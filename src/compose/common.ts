import type {ExcalidrawElement} from "../types";
import {getElementBounds} from "../verify/geometry";
import {asText} from "../verify/model";
import {measureText, normalizeText, wrapText} from "../verify/textMetrics";
import type {PlanBounds, PlannedItem} from "./types";

// Auto-sized boxes get a couple of spare pixels: the browser measures with
// canvas metrics that can exceed the font-file advances by a fraction of a
// pixel, and a line that is 0.3 px too wide wraps.
export const AUTO_WIDTH_SLACK = 2;

export const liveById = (
  live: readonly ExcalidrawElement[],
): Map<string, ExcalidrawElement> => {
  const map = new Map<string, ExcalidrawElement>();
  for (const element of live) {
    if (!element.isDeleted) {
      map.set(element.id, element);
    }
  }
  return map;
};

export const boundLabelsOf = (
  container: ExcalidrawElement,
  live: readonly ExcalidrawElement[],
): ExcalidrawElement[] => {
  const backrefs = new Set(
    (container.boundElements ?? [])
      .filter((ref) => ref.type === "text")
      .map((ref) => ref.id),
  );
  return live.filter(
    (element) =>
      !element.isDeleted &&
      element.type === "text" &&
      (asText(element).containerId === container.id || backrefs.has(element.id)),
  );
};

export const labelTextOf = (label: ExcalidrawElement): string => {
  const view = asText(label);
  return typeof view.originalText === "string" ? view.originalText : view.text ?? "";
};

export type TextBlock = {
  text: string;
  width: number;
  height: number;
  lineCount: number;
};

export const measureBlock = (
  text: string,
  fontSize: number,
  fontFamily: number,
  maxWidth?: number,
): TextBlock => {
  const wrapped =
    typeof maxWidth === "number" && maxWidth > 0
      ? wrapText(text, fontSize, fontFamily, maxWidth)
      : normalizeText(text);
  const measured = measureText(wrapped, fontSize, fontFamily);
  return {
    text: wrapped,
    width: Math.ceil(measured.width),
    height: Math.ceil(measured.height),
    lineCount: measured.lineCount,
  };
};

export const toPlanBounds = ([minX, minY, maxX, maxY]: [
  number,
  number,
  number,
  number,
]): PlanBounds => ({ x: minX, y: minY, width: maxX - minX, height: maxY - minY });

export const unionBounds = (list: readonly PlanBounds[]): PlanBounds => {
  if (!list.length) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of list) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
};

export const elementBounds = (element: ExcalidrawElement): PlanBounds =>
  toPlanBounds(getElementBounds(element));

export const itemBounds = (item: PlannedItem): PlanBounds => {
  const x = item.x ?? 0;
  const y = item.y ?? 0;
  if (Array.isArray(item.points) && item.points.length) {
    const xs = item.points.map(([px]) => x + px);
    const ys = item.points.map(([, py]) => y + py);
    return toPlanBounds([
      Math.min(...xs),
      Math.min(...ys),
      Math.max(...xs),
      Math.max(...ys),
    ]);
  }
  return { x, y, width: item.width ?? 0, height: item.height ?? 0 };
};

export const liveBoundsOf = (
  ids: readonly string[],
  byId: Map<string, ExcalidrawElement>,
): PlanBounds | undefined => {
  const present = ids
    .map((id) => byId.get(id))
    .filter((element): element is ExcalidrawElement => !!element);
  return present.length ? unionBounds(present.map(elementBounds)) : undefined;
};

// Groups the composite sits in besides its own, innermost first, so a table
// a user grouped with other shapes stays in that group after a re-plan.
export const outerGroupIds = (
  element: ExcalidrawElement | undefined,
  ownGroupId: string,
): string[] => (element?.groupIds ?? []).filter((groupId) => groupId !== ownGroupId);

// Elements of the composite that are live but no longer planned, together
// with their bound labels. Ownership is by deterministic id prefix, so a
// user's copy of a cell (random id, same customData) is never deleted.
export const staleIds = (
  live: readonly ExcalidrawElement[],
  plannedIds: ReadonlySet<string>,
  owned: (element: ExcalidrawElement) => boolean,
): string[] => {
  // Bound labels follow their container: kept with it, removed with it.
  const stale = live.filter(
    (element) =>
      !element.isDeleted &&
      !plannedIds.has(element.id) &&
      !(element.type === "text" && asText(element).containerId) &&
      owned(element),
  );
  const ids = new Set(stale.map((element) => element.id));
  for (const element of stale) {
    for (const label of boundLabelsOf(element, live)) {
      ids.add(label.id);
    }
  }
  return [...ids];
};

// Labels of planned containers that are planned without a label (empty cell).
export const orphanLabelIds = (
  items: readonly PlannedItem[],
  byId: Map<string, ExcalidrawElement>,
  live: readonly ExcalidrawElement[],
): string[] => {
  const ids: string[] = [];
  for (const item of items) {
    if (typeof item.label === "string" && item.label.length) {
      continue;
    }
    const existing = byId.get(item.id);
    if (existing && item.type !== "text") {
      ids.push(...boundLabelsOf(existing, live).map((label) => label.id));
    }
  }
  return ids;
};

// Anchors may be given as a bound label id; the shape is what callouts and
// badges attach to.
export const resolveAnchor = (
  anchorId: string,
  byId: Map<string, ExcalidrawElement>,
): ExcalidrawElement => {
  const anchor = byId.get(anchorId);
  if (!anchor) {
    throw new Error(`anchor "${anchorId}" not found on the board`);
  }
  const containerId = asText(anchor).containerId;
  if (anchor.type === "text" && typeof containerId === "string") {
    return byId.get(containerId) ?? anchor;
  }
  return anchor;
};

export const assertKey = (key: unknown, what: string): string => {
  if (typeof key !== "string" || !key.length) {
    throw new Error(`${what} key must be a non-empty string`);
  }
  if (key.includes(":")) {
    throw new Error(`${what} key "${key}" must not contain ":" (it is part of element ids)`);
  }
  if (key === "label") {
    throw new Error(`${what} key "label" is reserved (element ids ending in :label are bound labels)`);
  }
  return key;
};
