import {generateNKeysBetween} from "fractional-indexing";

import type {ExcalidrawElement} from "../types";
import {applyUpdate} from "../elements";
import {asLinear, asText} from "../verify/model";
import {globalLinearPoints} from "../verify/geometry";
import {createItems, type CreateContext, type CreateItem} from "./create";
import {boundTextOf, labelSource} from "./follow";
import {deleteTargets} from "./lifecycle";
import type {SceneTxn} from "./txn";
import {canChangeType, type Patch, updateItems} from "./update";

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const PASS_THROUGH = [
  "x",
  "y",
  "width",
  "height",
  "angle",
  "strokeColor",
  "backgroundColor",
  "fillStyle",
  "strokeWidth",
  "strokeStyle",
  "roughness",
  "opacity",
  "roundness",
  "role",
  "text",
  "fontSize",
  "fontFamily",
  "textAlign",
  "verticalAlign",
  "labelColor",
  "labelFontSize",
  "labelFontFamily",
  "frameId",
  "groupIds",
  "name",
  "link",
  "kind",
  "slot",
  "lintIgnore",
  "protected",
  "startArrowhead",
  "endArrowhead",
  "fileId",
] as const;

// Turn a desired-state item into a patch carrying only what differs, so an
// idempotent re-run (set_table, create_diagram with the same diagramId) does
// not bump every element.
export const patchFromItem = (current: ExcalidrawElement, item: CreateItem, txn: SceneTxn): Patch | null => {
  const patch: Patch = { id: current.id };
  if (item.type && item.type !== current.type) {
    patch.type = item.type;
  }
  for (const key of PASS_THROUGH) {
    const value = (item as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (key === "role") {
      const role = (current.customData as { role?: unknown } | undefined)?.role;
      if (role !== value) patch.role = value;
      continue;
    }
    if (key === "kind" || key === "slot" || key === "protected" || key === "lintIgnore") {
      const stored = (current.customData as Record<string, unknown> | undefined)?.[key];
      if (!same(stored, value)) patch[key] = value;
      continue;
    }
    if (!same((current as Record<string, unknown>)[key], value)) {
      patch[key] = value;
    }
  }
  if (item.customData && typeof item.customData === "object") {
    const merged = { ...((current.customData as Record<string, unknown>) ?? {}), ...(item.customData as Record<string, unknown>) };
    if (!same(merged, current.customData)) patch.customData = merged;
  }
  if (typeof item.label === "string") {
    const label = boundTextOf(txn, current);
    if (!label || labelSource(label) !== item.label) patch.label = item.label;
    if (label) {
      const view = asText(label);
      for (const [itemKey, textKey] of [
        ["labelFontSize", "fontSize"],
        ["labelFontFamily", "fontFamily"],
        ["textAlign", "textAlign"],
        ["verticalAlign", "verticalAlign"],
      ] as const) {
        const value = (item as Record<string, unknown>)[itemKey];
        if (value !== undefined && same((view as Record<string, unknown>)[textKey], value)) {
          delete patch[itemKey];
        }
      }
      if (typeof item.fontSize === "number" && view.fontSize === item.fontSize) delete patch.fontSize;
      if (typeof item.labelColor === "string" && label.strokeColor === item.labelColor) delete patch.labelColor;
    }
  }
  if (current.type === "arrow" || item.type === "arrow") {
    const linear = asLinear(current);
    if (typeof item.fromId === "string" && linear.startBinding?.elementId !== item.fromId) patch.fromId = item.fromId;
    if (typeof item.toId === "string" && linear.endBinding?.elementId !== item.toId) patch.toId = item.toId;
    const reroute = item.route || item.waypoints || item.startAnchor || item.endAnchor;
    if (reroute) {
      if (item.route) patch.route = item.route;
      if (item.waypoints) patch.waypoints = item.waypoints;
      if (item.startAnchor) patch.startAnchor = item.startAnchor;
      if (item.endAnchor) patch.endAnchor = item.endAnchor;
    }
    // A diagram re-run re-plans the path from the (possibly moved) nodes.
    if (typeof item.fromId === "string" && !reroute) patch.route = "direct";
  }
  if (Array.isArray(item.points) && current.type === "line") {
    const current2 = globalLinearPoints(current).map(([px, py]) => [px - current.x, py - current.y]);
    if (!same(current2, item.points)) patch.points = item.points;
  }
  return Object.keys(patch).length > 1 ? patch : null;
};

// Apply a composite's desired state in one transaction: live ids are patched
// in place (only what differs), missing or deleted ids are (re)created, and
// `removeIds` are deleted. Items are created in the order given, bottom → top.
export const upsertItems = (
  txn: SceneTxn,
  items: CreateItem[],
  options: { removeIds?: string[]; context?: CreateContext } = {},
): { created: string[]; updated: string[]; removed: string[] } => {
  const created: string[] = [];
  const updated: string[] = [];
  const toCreate: CreateItem[] = [];
  const patches: Patch[] = [];
  for (const item of items) {
    const id = typeof item.id === "string" ? item.id : undefined;
    let current = id ? txn.live(id) : undefined;
    if (current && item.type && !canChangeType(current.type, item.type)) {
      // e.g. a legend sample switching from a chip to a line: replace it.
      deleteTargets(txn, [current], { force: true });
      current = undefined;
    }
    if (!current) {
      toCreate.push(item);
      continue;
    }
    const patch = patchFromItem(current, item, txn);
    if (patch) patches.push(patch);
  }
  // Shapes first, arrows last: an arrow may bind to a shape created here.
  const shapes = toCreate.filter((item) => item.type !== "arrow");
  const arrows = toCreate.filter((item) => item.type === "arrow");
  if (shapes.length) created.push(...createItems(txn, shapes, options.context).ids);
  if (patches.length) updated.push(...updateItems(txn, patches, options.context).updated);
  if (arrows.length) created.push(...createItems(txn, arrows, options.context).ids);
  const removed: string[] = [];
  if (options.removeIds?.length) {
    const targets = options.removeIds
      .map((id) => txn.live(id))
      .filter((element): element is ExcalidrawElement => !!element);
    removed.push(...deleteTargets(txn, targets, { force: true }).deleted);
  }
  restackInOrder(
    txn,
    items.map((item) => item.id).filter((id): id is string => typeof id === "string"),
  );
  return { created, updated, removed };
};

const indexOf = (element: ExcalidrawElement): string =>
  typeof element.index === "string" ? element.index : "";

// Keep a composite's z-order as planned (backgrounds under cells, labels right
// above their containers) when later calls add parts to it: new elements are
// created on top of the board, so re-stack the block where it already sits.
export const restackInOrder = (txn: SceneTxn, orderedIds: readonly string[]): void => {
  const sequence: ExcalidrawElement[] = [];
  const seen = new Set<string>();
  for (const id of orderedIds) {
    const element = txn.live(id);
    if (!element || seen.has(id)) continue;
    seen.add(id);
    sequence.push(element);
    const label = boundTextOf(txn, element);
    if (label && !seen.has(label.id)) {
      seen.add(label.id);
      sequence.push(label);
    }
  }
  if (sequence.length < 2) return;
  const ordered = sequence.every((element, i) => i === 0 || indexOf(sequence[i - 1]) < indexOf(element));
  if (ordered) return;
  const lowest = sequence.reduce((min, element) => (indexOf(element) < min ? indexOf(element) : min), indexOf(sequence[0]));
  let below: string | null = null;
  for (const element of txn.all()) {
    const key = indexOf(element);
    if (!seen.has(element.id) && key && key < lowest && (below === null || key > below)) {
      below = key;
    }
  }
  const keys = generateNKeysBetween(below, lowest || null, sequence.length);
  sequence.forEach((element, i) => {
    if (indexOf(element) !== keys[i]) {
      txn.put(applyUpdate(txn.live(element.id) ?? element, { index: keys[i] }));
    }
  });
};
