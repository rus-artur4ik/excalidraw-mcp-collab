import {randomBytes, randomUUID} from "crypto";

import {generateKeyBetween} from "fractional-indexing";

import {CONTAINER_TYPES, DEFAULT_FONT_FAMILY, DEFAULT_FONT_SIZE} from "./verify/model";
import {layoutBoundText, layoutText} from "./verify/textMetrics";
import type {ExcalidrawElement} from "./types";

export type CreateAttrs = Partial<ExcalidrawElement> & {
  type: string;
  label?: string;
  labelColor?: string;
  points?: [number, number][];
  containerId?: string;
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

export const nextFractionalIndex = (
  elements: readonly ExcalidrawElement[],
): string => generateKeyBetween(lastIndex(elements), null);

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
  return {};
};

export const buildNewElement = (
  attrs: Partial<ExcalidrawElement> & { type: string },
  existing: readonly ExcalidrawElement[],
): ExcalidrawElement => {
  const now = Date.now();
  const base = elementDefaults();
  return {
    ...base,
    ...attrs,
    ...deriveGeometry(attrs),
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
  const { id, type, version, versionNonce, index, updated, ...mutable } = patch;
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

const addBackref = (
  element: ExcalidrawElement,
  refId: string,
  refType: string,
): { id: string; type: string }[] => {
  const existing = Array.isArray(element.boundElements)
    ? element.boundElements
    : [];
  return existing.some((entry) => entry.id === refId)
    ? existing
    : [...existing, { id: refId, type: refType }];
};

const buildBoundText = (
  container: ExcalidrawElement,
  attrs: CreateAttrs,
  existing: readonly ExcalidrawElement[],
): { text: ExcalidrawElement; container: ExcalidrawElement } => {
  const fontSize =
    typeof attrs.fontSize === "number" ? attrs.fontSize : DEFAULT_FONT_SIZE;
  const fontFamily =
    typeof attrs.fontFamily === "number" ? attrs.fontFamily : DEFAULT_FONT_FAMILY;
  const raw = String(attrs.text ?? attrs.label ?? "");
  const layout = layoutBoundText(container, raw, fontSize, fontFamily);
  const { label, labelColor, ...textAttrs } = attrs;
  const text = buildNewElement(
    {
      ...textAttrs,
      type: "text",
      containerId: container.id,
      text: layout.text,
      originalText: raw,
      x: layout.x,
      y: layout.y,
      width: layout.width,
      height: layout.height,
      fontSize,
      fontFamily,
      lineHeight: layout.lineHeight,
      strokeColor: attrs.strokeColor ?? labelColor ?? "#1e1e1e",
      textAlign: attrs.textAlign ?? "center",
      verticalAlign: attrs.verticalAlign ?? "middle",
      autoResize: false,
    },
    existing,
  );
  return {
    text,
    container: applyUpdate(container, {
      boundElements: addBackref(container, text.id, "text"),
      height: layout.containerHeight,
    }),
  };
};

export const planCreations = (
  items: CreateAttrs[],
  existing: readonly ExcalidrawElement[],
): { created: ExcalidrawElement[]; containerUpdates: ExcalidrawElement[] } => {
  const working = [...existing];
  const created: ExcalidrawElement[] = [];
  const createdIndex = new Map<string, number>();
  const containerUpdates = new Map<string, ExcalidrawElement>();
  const replace = (element: ExcalidrawElement) => {
    const i = working.findIndex((w) => w.id === element.id);
    if (i >= 0) {
      working[i] = element;
    }
  };
  const pushCreated = (element: ExcalidrawElement) => {
    createdIndex.set(element.id, created.length);
    created.push(element);
    working.push(element);
  };
  // A container the same batch is creating is patched in place; only a
  // pre-existing one becomes a separate containerUpdate.
  const recordContainerUpdate = (container: ExcalidrawElement) => {
    const at = createdIndex.get(container.id);
    if (at !== undefined) {
      created[at] = container;
    } else {
      containerUpdates.set(container.id, container);
    }
    replace(container);
  };
  const find = (id: string): ExcalidrawElement | undefined =>
    working.find((w) => w.id === id);

  for (const raw of items) {
    if (raw.type === "text" && typeof raw.containerId === "string") {
      const container = find(raw.containerId);
      if (!container || container.isDeleted) {
        throw new Error(`container not found: ${raw.containerId}`);
      }
      if (!CONTAINER_TYPES.has(container.type)) {
        throw new Error(`element ${container.id} is not a text container`);
      }
      const bound = buildBoundText(container, raw, working);
      pushCreated(bound.text);
      recordContainerUpdate(bound.container);
      continue;
    }
    if (typeof raw.label === "string" && CONTAINER_TYPES.has(raw.type)) {
      const { label, labelColor, ...containerAttrs } = raw;
      const container = buildNewElement(containerAttrs, working);
      pushCreated(container);
      const bound = buildBoundText(
        container,
        { type: "text", text: label, labelColor },
        working,
      );
      recordContainerUpdate(bound.container);
      pushCreated(bound.text);
      continue;
    }
    pushCreated(buildNewElement(raw, working));
  }

  return { created, containerUpdates: [...containerUpdates.values()] };
};
