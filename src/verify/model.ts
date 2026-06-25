import type {ExcalidrawElement} from "../types";

export type Point = [number, number];

export type Bounds = [minX: number, minY: number, maxX: number, maxY: number];

export type BindMode = "inside" | "orbit" | "skip";

export type FixedPointBinding = {
  elementId: string;
  fixedPoint: Point;
  mode: BindMode;
};

export type LinearView = ExcalidrawElement & {
  points?: Point[];
  startBinding?: FixedPointBinding | null;
  endBinding?: FixedPointBinding | null;
  startArrowhead?: string | null;
  endArrowhead?: string | null;
  elbowed?: boolean;
};

export type TextView = ExcalidrawElement & {
  text?: string;
  originalText?: string;
  fontSize?: number;
  fontFamily?: number;
  textAlign?: string;
  verticalAlign?: string;
  containerId?: string | null;
  lineHeight?: number;
  autoResize?: boolean;
};

export type FrameView = ExcalidrawElement & { name?: string | null };

export const asLinear = (element: ExcalidrawElement): LinearView =>
  element as unknown as LinearView;

export const asText = (element: ExcalidrawElement): TextView =>
  element as unknown as TextView;

export const GENERIC_TYPES = new Set([
  "rectangle",
  "ellipse",
  "diamond",
  "selection",
]);

export const LINEAR_TYPES = new Set(["line", "arrow"]);

export const BINDABLE_TYPES = new Set([
  "rectangle",
  "diamond",
  "ellipse",
  "text",
  "image",
  "iframe",
  "embeddable",
  "frame",
  "magicframe",
]);

export const CONTAINER_TYPES = new Set(["rectangle", "diamond", "ellipse"]);

export const isLinear = (element: ExcalidrawElement): boolean =>
  LINEAR_TYPES.has(element.type);

export const isArrow = (element: ExcalidrawElement): boolean =>
  element.type === "arrow";

export const isBindable = (element: ExcalidrawElement): boolean =>
  BINDABLE_TYPES.has(element.type);

export const isFrameLike = (element: ExcalidrawElement): boolean =>
  element.type === "frame" || element.type === "magicframe";

export const DEFAULT_FONT_SIZE = 20;
export const DEFAULT_FONT_FAMILY = 5;
export const BOUND_TEXT_PADDING = 5;
export const DEFAULT_EXPORT_PADDING = 10;
export const ARROW_LABEL_WIDTH_FRACTION = 0.7;
export const ARROW_LABEL_FONT_SIZE_TO_MIN_WIDTH_RATIO = 11;
export const ARROW_LABEL_HEIGHT_PADDING_MULTIPLIER = 16;

export const BASE_BINDING_GAP = 5;
export const MAX_BINDING_DISTANCE = 15;

export const CENTER_RATIO = 0.5001;

export const FONT_FAMILY: Record<string, number> = {
  Virgil: 1,
  Helvetica: 2,
  Cascadia: 3,
  Excalifont: 5,
  Nunito: 6,
  "Lilita One": 7,
  "Comic Shanns": 8,
  "Liberation Sans": 9,
  Assistant: 10,
};

export const FONT_LINE_HEIGHTS: Record<number, number> = {
  1: 1.25,
  2: 1.15,
  3: 1.2,
  5: 1.25,
  6: 1.25,
  7: 1.15,
  8: 1.25,
  9: 1.15,
  10: 1.25,
};

export const FONT_CSS_FAMILIES: Record<number, string> = {
  1: "Virgil, Segoe UI Emoji",
  2: "Helvetica, Arial, sans-serif",
  3: "Cascadia, monospace",
  5: "Excalifont, Segoe UI Emoji, sans-serif",
  6: "Nunito, sans-serif",
  7: "Lilita One, sans-serif",
  8: "Comic Shanns, monospace",
  9: "Liberation Sans, Arial, sans-serif",
  10: "Assistant, sans-serif",
};

export const MONOSPACE_FAMILIES = new Set([3, 8]);

export const FILL_STYLES = new Set(["hachure", "cross-hatch", "solid", "zigzag"]);
export const STROKE_STYLES = new Set(["solid", "dashed", "dotted"]);
export const ROUGHNESS_VALUES = new Set([0, 1, 2]);
export const ARROWHEADS = new Set([
  "arrow",
  "bar",
  "circle",
  "circle_outline",
  "triangle",
  "triangle_outline",
  "diamond",
  "diamond_outline",
  "dot",
  "cardinality_one",
  "cardinality_many",
  "cardinality_one_or_many",
  "cardinality_exactly_one",
  "cardinality_zero_or_one",
  "cardinality_zero_or_many",
  "crowfoot_one",
  "crowfoot_many",
  "crowfoot_one_or_many",
]);

export const lineHeightForFamily = (fontFamily?: number): number =>
  FONT_LINE_HEIGHTS[fontFamily ?? DEFAULT_FONT_FAMILY] ?? 1.25;

export const cssFamilyFor = (fontFamily?: number): string =>
  FONT_CSS_FAMILIES[fontFamily ?? DEFAULT_FONT_FAMILY] ??
  FONT_CSS_FAMILIES[DEFAULT_FONT_FAMILY];

export const isTransparent = (color: string | undefined): boolean =>
  !color || color === "transparent" || color === "" || color === "none";
