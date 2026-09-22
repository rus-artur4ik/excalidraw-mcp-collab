import {randomUUID} from "crypto";

import type {ExcalidrawElement} from "../types";
import {applyUpdate} from "../elements";
import {customDataOf} from "../customData";
import {asText, isLinear} from "../verify/model";
import {getElementBounds} from "../verify/geometry";
import {invalidArgs, notFound} from "./errors";
import {moveElements} from "./move";
import {growFrameToFit} from "./reflow";
import type {SceneTxn} from "./txn";

export type StackDirection = "down" | "right";
export type StackAlign = "start" | "center" | "end";

export type StackRef = {
  id: string;
  index: number;
  gap: number;
  direction: StackDirection;
  align: StackAlign;
};

export const stackRefOf = (element: ExcalidrawElement): StackRef | undefined => {
  const ref = (customDataOf(element) as { stack?: unknown }).stack;
  return ref && typeof ref === "object" && typeof (ref as StackRef).id === "string"
    ? (ref as StackRef)
    : undefined;
};

const membersOf = (txn: SceneTxn, stackId: string): ExcalidrawElement[] =>
  txn
    .liveElements()
    .filter((element) => stackRefOf(element)?.id === stackId)
    .sort((a, b) => (stackRefOf(a)!.index ?? 0) - (stackRefOf(b)!.index ?? 0));

const writeRef = (txn: SceneTxn, element: ExcalidrawElement, ref: StackRef): void => {
  txn.put(
    applyUpdate(element, {
      customData: { ...customDataOf(element), stack: ref },
    }),
  );
};

export type CreateStackInput = {
  ids: string[];
  direction?: StackDirection;
  gap?: number;
  align?: StackAlign;
  stackId?: string;
};

// A stack is a remembered column (or row): the members keep the same gap, so a
// later edit that makes one of them taller pushes the rest instead of
// overlapping them. It is re-applied on every write that touches a member —
// the server cannot see edits made in the browser, so a person moving a member
// there simply redefines where the stack sits the next time the bot writes.
export const createStack = (txn: SceneTxn, input: CreateStackInput): { stackId: string; members: string[] } => {
  const members = input.ids
    .map((id) => txn.live(id))
    .filter((element): element is ExcalidrawElement => !!element);
  if (members.length < 2) {
    throw invalidArgs("a stack needs at least two existing elements", { ids: input.ids });
  }
  for (const element of members) {
    if (element.type === "text" && typeof asText(element).containerId === "string") {
      throw invalidArgs(`${element.id} is a label; stack its container instead`, { ids: [element.id] });
    }
  }
  const direction = input.direction ?? "down";
  const stackId = input.stackId ?? `stack-${randomUUID().slice(0, 8)}`;
  const gap = input.gap ?? defaultGap(members, direction);
  const align = input.align ?? "start";
  const ordered = [...members].sort((a, b) =>
    direction === "down" ? a.y - b.y : a.x - b.x,
  );
  ordered.forEach((element, index) => {
    writeRef(txn, element, { id: stackId, index, gap, direction, align });
  });
  relayoutStack(txn, stackId);
  return { stackId, members: ordered.map((element) => element.id) };
};

// The gap people already used, so creating a stack does not move anything.
const defaultGap = (members: readonly ExcalidrawElement[], direction: StackDirection): number => {
  const sorted = [...members].sort((a, b) => (direction === "down" ? a.y - b.y : a.x - b.x));
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const [px1, py1, px2, py2] = getElementBounds(sorted[i - 1]);
    const [cx1, cy1] = getElementBounds(sorted[i]);
    gaps.push(direction === "down" ? cy1 - py2 : cx1 - px2);
    void px1;
    void py1;
  }
  const positive = gaps.filter((gap) => gap > 0);
  return positive.length ? Math.round(positive.reduce((sum, gap) => sum + gap, 0) / positive.length) : 24;
};

export const relayoutStack = (txn: SceneTxn, stackId: string): string[] => {
  const members = membersOf(txn, stackId);
  if (members.length < 2) {
    return [];
  }
  const ref = stackRefOf(members[0])!;
  const vertical = ref.direction !== "right";
  const first = getElementBounds(members[0]);
  const edge = vertical ? first[0] : first[1];
  const size = vertical ? first[2] - first[0] : first[3] - first[1];
  let cursor = vertical ? first[3] : first[2];
  const moved: string[] = [];
  for (const member of members.slice(1)) {
    const current = txn.live(member.id);
    if (!current) continue;
    const bounds = getElementBounds(current);
    const wantStart = cursor + ref.gap;
    const across =
      ref.align === "center"
        ? edge + (size - (vertical ? bounds[2] - bounds[0] : bounds[3] - bounds[1])) / 2
        : ref.align === "end"
          ? edge + size - (vertical ? bounds[2] - bounds[0] : bounds[3] - bounds[1])
          : edge;
    const dx = vertical ? across - bounds[0] : wantStart - bounds[0];
    const dy = vertical ? wantStart - bounds[1] : across - bounds[1];
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
      moved.push(...moveElements(txn, [current], dx, dy).moved);
    }
    const after = getElementBounds(txn.live(member.id) ?? current);
    cursor = vertical ? after[3] : after[2];
  }
  const frameId = members[0].frameId;
  if (moved.length && typeof frameId === "string") {
    growFrameToFit(txn, frameId);
  }
  return moved;
};

// Called at the end of every write: any stack a changed element belongs to is
// re-applied, so growing one member pushes the others down by the same gap.
export const relayoutTouchedStacks = (txn: SceneTxn): string[] => {
  const stacks = new Set<string>();
  for (const element of txn.changed()) {
    if (element.isDeleted || isLinear(element)) continue;
    const ref = stackRefOf(element);
    if (ref) stacks.add(ref.id);
  }
  const moved: string[] = [];
  for (const stackId of stacks) {
    moved.push(...relayoutStack(txn, stackId));
  }
  return moved;
};

export const insertIntoStack = (
  txn: SceneTxn,
  stackId: string,
  id: string,
  insertAt?: number,
): void => {
  const element = txn.live(id);
  if (!element) {
    throw notFound(`element not found: ${id}`, [id]);
  }
  const members = membersOf(txn, stackId).filter((member) => member.id !== id);
  if (!members.length) {
    throw notFound(`no stack ${stackId} on this board`);
  }
  const template = stackRefOf(members[0])!;
  const at = Math.max(0, Math.min(insertAt ?? members.length, members.length));
  const ordered = [...members.slice(0, at), element, ...members.slice(at)];
  ordered.forEach((member, index) => {
    const current = txn.live(member.id);
    if (current) {
      writeRef(txn, current, { ...template, index });
    }
  });
  relayoutStack(txn, stackId);
};

export const removeFromStack = (txn: SceneTxn, id: string): void => {
  const element = txn.live(id);
  const ref = element ? stackRefOf(element) : undefined;
  if (!element || !ref) {
    return;
  }
  const custom = { ...customDataOf(element) } as Record<string, unknown>;
  delete custom.stack;
  txn.put(applyUpdate(element, { customData: custom }));
  relayoutStack(txn, ref.id);
};
