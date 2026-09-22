import type {ExcalidrawElement} from "../types";
import {applyUpdate} from "../elements";
import {asLinear, asText, isLinear} from "../verify/model";
import {getCommonBounds, getElementBounds} from "../verify/geometry";
import {moveElements} from "./move";
import type {SceneTxn} from "./txn";

export type ReflowOptions = {
  push?: "below" | "right" | "none";
  growFrame?: boolean;
};

type Box = { x: number; y: number; width: number; height: number };

const boxOf = (element: ExcalidrawElement): Box => {
  const [x1, y1, x2, y2] = getElementBounds(element);
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
};

const isLabel = (element: ExcalidrawElement): boolean =>
  element.type === "text" && typeof asText(element).containerId === "string";

// Shift what lies below (or right of) a block that grew by the growth delta,
// inside the block's own frame, so gaps stay as they were; optionally grow
// the frame so nothing spills out of it.
export const pushBelow = (
  txn: SceneTxn,
  previous: Box,
  next: Box,
  exclude: ReadonlySet<string>,
  options: ReflowOptions,
  frameId?: string | null,
): string[] => {
  const push = options.push ?? "below";
  if (push === "none") {
    return [];
  }
  const vertical = push === "below";
  const delta = vertical
    ? next.y + next.height - (previous.y + previous.height)
    : next.x + next.width - (previous.x + previous.width);
  if (delta <= 0.5) {
    return [];
  }
  const edge = vertical ? previous.y + previous.height : previous.x + previous.width;
  // "Below" means in the block's own column (overlapping it horizontally),
  // inside the same frame; groups move as a unit and bound arrows re-aim.
  const inBand = (box: Box): boolean =>
    vertical
      ? Math.min(box.x + box.width, next.x + next.width) - Math.max(box.x, next.x) > 0
      : Math.min(box.y + box.height, next.y + next.height) - Math.max(box.y, next.y) > 0;
  const candidates = txn.liveElements().filter((element) => {
    if (exclude.has(element.id) || isLabel(element)) return false;
    if (element.type === "frame" || element.type === "magicframe") return false;
    if (isLinear(element) && (asLinear(element).startBinding || asLinear(element).endBinding)) return false;
    return (element.frameId ?? null) === (frameId ?? null);
  });
  const seeds = candidates.filter((element) => {
    const box = boxOf(element);
    return (vertical ? box.y : box.x) >= edge - 1 && inBand(box);
  });
  const chosen = new Set(seeds.map((element) => element.id));
  const groups = new Set(seeds.flatMap((element) => element.groupIds ?? []));
  if (groups.size) {
    for (const element of candidates) {
      if ((element.groupIds ?? []).some((groupId) => groups.has(groupId))) chosen.add(element.id);
    }
  }
  const neighbours = candidates.filter((element) => chosen.has(element.id));
  const moved = neighbours.length
    ? moveElements(txn, neighbours, vertical ? 0 : delta, vertical ? delta : 0).moved
    : [];
  if (options.growFrame !== false && frameId) {
    growFrameToFit(txn, frameId);
  }
  return moved;
};

export const growFrameToFit = (txn: SceneTxn, frameId: string, padding = 24): void => {
  const frame = txn.live(frameId);
  if (!frame) return;
  const children = txn.liveElements().filter((element) => element.frameId === frameId);
  if (!children.length) return;
  const [, , x2, y2] = getCommonBounds(children);
  const right = Math.max(frame.x + frame.width, x2 + padding);
  const bottom = Math.max(frame.y + frame.height, y2 + padding);
  if (right > frame.x + frame.width + 0.5 || bottom > frame.y + frame.height + 0.5) {
    txn.put(applyUpdate(frame, { width: right - frame.x, height: bottom - frame.y }));
    txn.report.collateral.push({ id: frameId, reason: "frame grown to keep its content inside" });
  }
};

// After patches that may have grown elements (labels, fit), push their
// neighbours so the growth does not create overlaps (I20 reflow).
export const reflowAfterGrowth = (
  txn: SceneTxn,
  before: ReadonlyMap<string, ExcalidrawElement>,
  options: ReflowOptions,
): void => {
  for (const [id, previous] of before) {
    const after = txn.live(id);
    if (!after || isLabel(after) || isLinear(after)) continue;
    const moved = pushBelow(txn, boxOf(previous), boxOf(after), new Set([id]), options, after.frameId);
    if (moved.length) {
      const entry = txn.report.fit.find((fit) => fit.id === id);
      const pushed = { id, pushed: moved.length };
      if (entry) Object.assign(entry, { pushed: moved.length });
      else txn.report.fit.push(pushed as (typeof txn.report.fit)[number]);
    }
  }
};
