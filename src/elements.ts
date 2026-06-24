import { randomBytes, randomUUID } from "crypto";

import { generateKeyBetween } from "fractional-indexing";

import type { ExcalidrawElement } from "./types";

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

export const buildNewElement = (
  attrs: Partial<ExcalidrawElement> & { type: string },
  existing: readonly ExcalidrawElement[],
): ExcalidrawElement => {
  const now = Date.now();
  const base = elementDefaults();
  return {
    ...base,
    ...attrs,
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
