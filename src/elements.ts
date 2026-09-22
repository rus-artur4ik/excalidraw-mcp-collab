import {randomBytes, randomUUID} from "crypto";

import {generateKeyBetween, generateNKeysBetween} from "fractional-indexing";

import {asLinear, DEFAULT_FONT_FAMILY, DEFAULT_FONT_SIZE} from "./verify/model";
import {layoutText} from "./verify/textMetrics";
import {createItems, type CreateItem} from "./engine/create";
import {SceneTxn} from "./engine/txn";
import type {ExcalidrawElement} from "./types";

export type CreateAttrs = Partial<ExcalidrawElement> & {
  type: string;
  role?: string;
  label?: string;
  labelColor?: string;
  labelFontSize?: number;
  labelFontFamily?: number;
  lintIgnore?: string[];
  points?: [number, number][];
  waypoints?: [number, number][];
  route?: "direct" | "orthogonal" | "straight";
  containerId?: string;
  frameId?: string | null;
  fromId?: string;
  toId?: string;
  bindMode?: "inside" | "orbit" | "skip";
  startArrowhead?: string | null;
  endArrowhead?: string | null;
};

const randomInteger = (): number => randomBytes(4).readUInt32BE(0);

const elementDefaults = (): Omit<
  ExcalidrawElement,
  "id" | "type" | "version" | "versionNonce" | "index" | "updated"
> => ({
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  angle: 0,
  strokeColor: "#1e1e1e",
  backgroundColor: "transparent",
  fillStyle: "solid",
  strokeWidth: 2,
  strokeStyle: "solid",
  roughness: 1,
  opacity: 100,
  roundness: null,
  seed: randomInteger(),
  isDeleted: false,
  groupIds: [],
  frameId: null,
  boundElements: null,
  link: null,
  locked: false,
});

const lastIndex = (elements: readonly ExcalidrawElement[]): string | null => {
  let max: string | null = null;
  for (const element of elements) {
    if (element.index != null && (max === null || element.index > max)) {
      max = element.index;
    }
  }
  return max;
};

const firstIndex = (elements: readonly ExcalidrawElement[]): string | null => {
  let min: string | null = null;
  for (const element of elements) {
    if (element.index != null && (min === null || element.index < min)) {
      min = element.index;
    }
  }
  return min;
};

export const nextFractionalIndex = (
  elements: readonly ExcalidrawElement[],
): string => generateKeyBetween(lastIndex(elements), null);

export const bottomFractionalIndex = (
  elements: readonly ExcalidrawElement[],
): string => generateKeyBetween(null, firstIndex(elements));

type Pt = [number, number];

const LINEAR = new Set(["line", "arrow"]);

const pointsSpan = (points: Pt[]): { width: number; height: number } => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [px, py] of points) {
    minX = Math.min(minX, px);
    minY = Math.min(minY, py);
    maxX = Math.max(maxX, px);
    maxY = Math.max(maxY, py);
  }
  return { width: maxX - minX, height: maxY - minY };
};

const sizeStandaloneText = (
  attrs: Partial<ExcalidrawElement>,
): Partial<ExcalidrawElement> => {
  const text = typeof attrs.text === "string" ? attrs.text : "";
  const fontSize =
    typeof attrs.fontSize === "number" ? attrs.fontSize : DEFAULT_FONT_SIZE;
  const fontFamily =
    typeof attrs.fontFamily === "number" ? attrs.fontFamily : DEFAULT_FONT_FAMILY;
  const fixedWidth =
    typeof attrs.width === "number" && attrs.width > 0 ? attrs.width : undefined;
  const layout = layoutText(text, fontSize, fontFamily, fixedWidth);
  return {
    fontSize,
    fontFamily,
    lineHeight: typeof attrs.lineHeight === "number" ? attrs.lineHeight : layout.lineHeight,
    width: fixedWidth ?? layout.width,
    height: typeof attrs.height === "number" ? attrs.height : layout.height,
    text: layout.text,
    originalText: typeof attrs.originalText === "string" ? attrs.originalText : text,
    ...(fixedWidth !== undefined
      ? { autoResize: typeof attrs.autoResize === "boolean" ? attrs.autoResize : false }
      : {}),
  };
};

const shapeLinear = (
  attrs: Partial<ExcalidrawElement>,
): Partial<ExcalidrawElement> => {
  const provided = (attrs as { points?: Pt[] }).points;
  if (Array.isArray(provided) && provided.length >= 2) {
    return { points: provided, ...pointsSpan(provided) };
  }
  const w = typeof attrs.width === "number" ? attrs.width : 0;
  const h = typeof attrs.height === "number" ? attrs.height : 0;
  if (w !== 0 || h !== 0) {
    return { points: [[0, 0], [w, h]], width: Math.abs(w), height: Math.abs(h) };
  }
  return {};
};

const deriveGeometry = (
  attrs: Partial<ExcalidrawElement> & { type: string },
): Partial<ExcalidrawElement> => {
  if (
    attrs.type === "text" &&
    typeof attrs.text === "string" &&
    (attrs as { containerId?: unknown }).containerId == null
  ) {
    return sizeStandaloneText(attrs);
  }
  if (LINEAR.has(attrs.type)) {
    return shapeLinear(attrs);
  }
  if (attrs.type === "image") {
    return {
      fileId: attrs.fileId ?? null,
      status: attrs.status ?? "saved",
      scale: Array.isArray(attrs.scale) ? attrs.scale : [1, 1],
    };
  }
  return {};
};

// customData is the only place Excalidraw preserves unknown data across a reload.
const stowLintIgnore = (
  attrs: Partial<ExcalidrawElement>,
  base?: unknown,
): Partial<ExcalidrawElement> => {
  const { lintIgnore, ...rest } = attrs as Partial<ExcalidrawElement> & {
    lintIgnore?: unknown;
  };
  if (!Array.isArray(lintIgnore)) {
    return rest;
  }
  const customData = (rest.customData ?? base ?? {}) as Record<string, unknown>;
  return { ...rest, customData: { ...customData, lintIgnore } };
};

export const buildNewElement = (
  attrs: Partial<ExcalidrawElement> & { type: string },
  existing: readonly ExcalidrawElement[],
): ExcalidrawElement => {
  const now = Date.now();
  const base = elementDefaults();
  const stowed = { ...stowLintIgnore(attrs), type: attrs.type };
  return {
    ...base,
    ...stowed,
    ...deriveGeometry(stowed),
    id: typeof attrs.id === "string" ? attrs.id : randomUUID(),
    type: attrs.type,
    version: 1,
    versionNonce: randomInteger(),
    index: nextFractionalIndex(existing),
    updated: now,
  } as ExcalidrawElement;
};

export const applyUpdate = (
  element: ExcalidrawElement,
  patch: Partial<ExcalidrawElement>,
): ExcalidrawElement => {
  const { id, type, version, versionNonce, updated, ...mutable } = stowLintIgnore(
    patch,
    element.customData,
  );
  return {
    ...element,
    ...mutable,
    version: element.version + 1,
    versionNonce: randomInteger(),
    updated: Date.now(),
  };
};

export const markDeleted = (
  element: ExcalidrawElement,
): ExcalidrawElement => ({
  ...element,
  isDeleted: true,
  version: element.version + 1,
  versionNonce: randomInteger(),
  updated: Date.now(),
});

// Revives a bot-owned element above an incoming deletion so the bot's live copy
// wins the version race and propagates back to every client.
export const reassertElement = (
  element: ExcalidrawElement,
  incomingVersion: number,
): ExcalidrawElement => ({
  ...element,
  isDeleted: false,
  version: Math.max(element.version, incomingVersion) + 1,
  versionNonce: randomInteger(),
  updated: Date.now(),
});

// Plan creations against an existing scene without committing them: the
// engine's createItems on a throwaway transaction. `created` are new elements,
// `containerUpdates` existing ones it had to touch (back-references, sizes).
export const planCreations = (
  rawItems: CreateAttrs[],
  existing: readonly ExcalidrawElement[],
): {
  created: ExcalidrawElement[];
  containerUpdates: ExcalidrawElement[];
  labels: Record<string, string>;
} => {
  const txn = new SceneTxn(existing);
  createItems(txn, rawItems as CreateItem[]);
  const created: ExcalidrawElement[] = [];
  const containerUpdates: ExcalidrawElement[] = [];
  for (const element of txn.changed()) {
    const before = txn.original(element.id);
    if (before && !before.isDeleted) {
      containerUpdates.push(element);
    } else {
      created.push(element);
    }
  }
  return { created, containerUpdates, labels: { ...txn.report.labels } };
};

// A survivor still pointing at a deleted id is a `binding_backref_missing` error.
export const detachDeleted = (
  elements: readonly ExcalidrawElement[],
  deletedIds: ReadonlySet<string>,
): ExcalidrawElement[] => {
  const detached: ExcalidrawElement[] = [];
  for (const element of elements) {
    if (deletedIds.has(element.id)) {
      continue;
    }
    const patch: Partial<ExcalidrawElement> = {};
    const refs = element.boundElements;
    if (Array.isArray(refs) && refs.some((entry) => deletedIds.has(entry.id))) {
      const kept = refs.filter((entry) => !deletedIds.has(entry.id));
      patch.boundElements = kept.length ? kept : null;
    }
    const linear = asLinear(element);
    if (linear.startBinding && deletedIds.has(linear.startBinding.elementId)) {
      patch.startBinding = null;
    }
    if (linear.endBinding && deletedIds.has(linear.endBinding.elementId)) {
      patch.endBinding = null;
    }
    if (Object.keys(patch).length) {
      detached.push(applyUpdate(element, patch));
    }
  }
  return detached;
};

export type ReorderPlacement =
  | { to: "front" }
  | { to: "back" }
  | { to: "above"; anchorId: string }
  | { to: "below"; anchorId: string };

const indexKey = (element: ExcalidrawElement): string =>
  typeof element.index === "string" ? element.index : "";

const byIndexAsc = (a: ExcalidrawElement, b: ExcalidrawElement): number => {
  const ai = indexKey(a);
  const bi = indexKey(b);
  return ai < bi ? -1 : ai > bi ? 1 : 0;
};

const boundContainerId = (element: ExcalidrawElement): string | undefined => {
  if (element.type !== "text") {
    return undefined;
  }
  const containerId = element.containerId;
  return typeof containerId === "string" ? containerId : undefined;
};

export const planReorder = (
  elements: readonly ExcalidrawElement[],
  ids: string[],
  placement: ReorderPlacement,
): ExcalidrawElement[] => {
  const byId = new Map(elements.map((element) => [element.id, element] as const));
  const moved = ids
    .map((id) => byId.get(id))
    .filter((element): element is ExcalidrawElement => !!element && !element.isDeleted);
  if (!moved.length) {
    return [];
  }
  const movedIds = new Set(moved.map((element) => element.id));
  for (const element of elements) {
    if (element.isDeleted) {
      continue;
    }
    const containerId = boundContainerId(element);
    if (containerId && movedIds.has(containerId) && !movedIds.has(element.id)) {
      movedIds.add(element.id);
      moved.push(element);
    }
  }

  const textsByContainer = new Map<string, ExcalidrawElement[]>();
  const movedBoundText = new Set<string>();
  for (const element of moved) {
    const containerId = boundContainerId(element);
    if (containerId && movedIds.has(containerId)) {
      movedBoundText.add(element.id);
      const list = textsByContainer.get(containerId) ?? [];
      list.push(element);
      textsByContainer.set(containerId, list);
    }
  }
  const sequence: ExcalidrawElement[] = [];
  for (const element of [...moved].sort(byIndexAsc)) {
    if (movedBoundText.has(element.id)) {
      continue;
    }
    sequence.push(element);
    const texts = textsByContainer.get(element.id);
    if (texts) {
      for (const text of [...texts].sort(byIndexAsc)) {
        sequence.push(text);
      }
    }
  }

  const rest = elements
    .filter((element) => !movedIds.has(element.id) && typeof element.index === "string")
    .sort(byIndexAsc);
  let lower: string | null = null;
  let upper: string | null = null;
  if (placement.to === "front") {
    lower = rest.length ? indexKey(rest[rest.length - 1]) : null;
  } else if (placement.to === "back") {
    upper = rest.length ? indexKey(rest[0]) : null;
  } else {
    if (movedIds.has(placement.anchorId)) {
      throw new Error("anchor cannot be one of the reordered elements");
    }
    const anchorPos = rest.findIndex((element) => element.id === placement.anchorId);
    if (anchorPos < 0) {
      throw new Error(`anchor not found: ${placement.anchorId}`);
    }
    if (placement.to === "above") {
      lower = indexKey(rest[anchorPos]);
      upper = anchorPos + 1 < rest.length ? indexKey(rest[anchorPos + 1]) : null;
    } else {
      upper = indexKey(rest[anchorPos]);
      lower = anchorPos > 0 ? indexKey(rest[anchorPos - 1]) : null;
    }
  }

  const keys = generateNKeysBetween(lower, upper, sequence.length);
  return sequence.map((element, i) => applyUpdate(element, { index: keys[i] }));
};
