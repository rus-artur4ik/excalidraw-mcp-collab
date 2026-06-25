import type {ExcalidrawElement} from "../../types";

let counter = 0;

export const el = (
  overrides: Partial<ExcalidrawElement> & { type: string },
): ExcalidrawElement => {
  counter += 1;
  const defaults = {
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
    seed: 1,
    version: 1,
    versionNonce: 1,
    index: `a${counter}`,
    isDeleted: false,
    groupIds: [],
    frameId: null,
    boundElements: null,
    updated: 0,
    link: null,
    locked: false,
  };
  return {
    ...defaults,
    ...overrides,
    id: overrides.id ?? `el-${counter}`,
  } as ExcalidrawElement;
};
