import {
    ARROW_LABEL_FONT_SIZE_TO_MIN_WIDTH_RATIO,
    ARROW_LABEL_HEIGHT_PADDING_MULTIPLIER,
    ARROW_LABEL_WIDTH_FRACTION,
    BOUND_TEXT_PADDING,
    lineHeightForFamily,
    MONOSPACE_FAMILIES,
} from "./model";
import type {ExcalidrawElement} from "../types";

const ADVANCE_PER_MILLE: Record<string, number> = {
  " ": 278,
  "!": 278,
  '"': 355,
  "#": 556,
  $: 556,
  "%": 889,
  "&": 667,
  "'": 191,
  "(": 333,
  ")": 333,
  "*": 389,
  "+": 584,
  ",": 278,
  "-": 333,
  ".": 278,
  "/": 278,
  "0": 556,
  "1": 556,
  "2": 556,
  "3": 556,
  "4": 556,
  "5": 556,
  "6": 556,
  "7": 556,
  "8": 556,
  "9": 556,
  ":": 278,
  ";": 278,
  "<": 584,
  "=": 584,
  ">": 584,
  "?": 556,
  "@": 1015,
  A: 667,
  B: 667,
  C: 722,
  D: 722,
  E: 667,
  F: 611,
  G: 778,
  H: 722,
  I: 278,
  J: 500,
  K: 667,
  L: 556,
  M: 833,
  N: 722,
  O: 778,
  P: 667,
  Q: 778,
  R: 722,
  S: 667,
  T: 611,
  U: 722,
  V: 667,
  W: 944,
  X: 667,
  Y: 667,
  Z: 611,
  "[": 278,
  "\\": 278,
  "]": 278,
  "^": 469,
  _: 556,
  "`": 333,
  a: 556,
  b: 556,
  c: 500,
  d: 556,
  e: 556,
  f: 278,
  g: 556,
  h: 556,
  i: 222,
  j: 222,
  k: 500,
  l: 222,
  m: 833,
  n: 556,
  o: 556,
  p: 556,
  q: 556,
  r: 333,
  s: 500,
  t: 278,
  u: 556,
  v: 500,
  w: 722,
  x: 500,
  y: 500,
  z: 500,
  "{": 334,
  "|": 260,
  "}": 334,
  "~": 584,
};

const DEFAULT_ADVANCE_PER_MILLE = 560;
const MONOSPACE_ADVANCE_PER_MILLE = 600;
const WIDE_GLYPH_ADVANCE_PER_MILLE = 1000;

const charAdvanceEm = (char: string, monospace: boolean): number => {
  if (monospace) {
    return MONOSPACE_ADVANCE_PER_MILLE / 1000;
  }
  const code = char.codePointAt(0) ?? 0;
  if (code > 0x2e7f) {
    return WIDE_GLYPH_ADVANCE_PER_MILLE / 1000;
  }
  return (ADVANCE_PER_MILLE[char] ?? DEFAULT_ADVANCE_PER_MILLE) / 1000;
};

export interface TextMetricsProvider {
  getLineWidth(text: string, fontSize: number, fontFamily?: number): number;
}

const builtInProvider: TextMetricsProvider = {
  getLineWidth(text, fontSize, fontFamily) {
    const monospace = MONOSPACE_FAMILIES.has(fontFamily ?? 0);
    let total = 0;
    for (const char of text) {
      total += charAdvanceEm(char, monospace);
    }
    return total * fontSize;
  },
};

let activeProvider: TextMetricsProvider = builtInProvider;

export const setTextMetricsProvider = (provider: TextMetricsProvider): void => {
  activeProvider = provider;
};

export const normalizeText = (text: string): string =>
  text.replace(/\r\n?/g, "\n").replace(/\t/g, "        ");

export const getLineWidth = (
  text: string,
  fontSize: number,
  fontFamily?: number,
): number => activeProvider.getLineWidth(text, fontSize, fontFamily);

export const measureText = (
  text: string,
  fontSize: number,
  fontFamily?: number,
): { width: number; height: number; lineCount: number } => {
  const normalized = normalizeText(text);
  const lines = normalized.split("\n");
  const width = lines.reduce(
    (max, line) => Math.max(max, getLineWidth(line, fontSize, fontFamily)),
    0,
  );
  const lineHeight = lineHeightForFamily(fontFamily) * fontSize;
  return {
    width,
    height: lineHeight * lines.length,
    lineCount: lines.length,
  };
};

const wrapSingleLine = (
  line: string,
  fontSize: number,
  fontFamily: number | undefined,
  maxWidth: number,
): string[] => {
  if (getLineWidth(line, fontSize, fontFamily) <= maxWidth) {
    return [line];
  }
  const tokens = line.match(/\s+|\S+/g) ?? [line];
  const wrapped: string[] = [];
  let current = "";
  const pushCurrent = () => {
    if (current.length) {
      wrapped.push(current.replace(/\s+$/, ""));
      current = "";
    }
  };
  for (const token of tokens) {
    const candidate = current + token;
    if (/^\s+$/.test(token)) {
      current = candidate;
      continue;
    }
    if (getLineWidth(candidate, fontSize, fontFamily) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (!current.length && getLineWidth(token, fontSize, fontFamily) > maxWidth) {
      let chunk = "";
      for (const char of token) {
        if (
          chunk.length &&
          getLineWidth(chunk + char, fontSize, fontFamily) > maxWidth
        ) {
          wrapped.push(chunk);
          chunk = char;
        } else {
          chunk += char;
        }
      }
      current = chunk;
      continue;
    }
    pushCurrent();
    current = token;
  }
  pushCurrent();
  return wrapped.length ? wrapped : [""];
};

export const wrapText = (
  text: string,
  fontSize: number,
  fontFamily: number | undefined,
  maxWidth: number,
): string => {
  if (!Number.isFinite(maxWidth) || maxWidth <= 0) {
    return normalizeText(text);
  }
  return normalizeText(text)
    .split("\n")
    .flatMap((line) => wrapSingleLine(line, fontSize, fontFamily, maxWidth))
    .join("\n");
};

const SQRT2 = Math.sqrt(2);

export const getBoundTextMaxWidth = (
  container: ExcalidrawElement,
  fontSize: number,
): number => {
  const width = container.width || 0;
  switch (container.type) {
    case "arrow":
    case "line":
      return Math.max(
        ARROW_LABEL_WIDTH_FRACTION * width,
        fontSize * ARROW_LABEL_FONT_SIZE_TO_MIN_WIDTH_RATIO,
      );
    case "ellipse":
      return Math.round((width / 2) * SQRT2) - BOUND_TEXT_PADDING * 2;
    case "diamond":
      return Math.round(width / 2) - BOUND_TEXT_PADDING * 2;
    default:
      return width - BOUND_TEXT_PADDING * 2;
  }
};

export const getBoundTextMaxHeight = (
  container: ExcalidrawElement,
): number => {
  const height = container.height || 0;
  switch (container.type) {
    case "arrow":
    case "line":
      return height - BOUND_TEXT_PADDING * ARROW_LABEL_HEIGHT_PADDING_MULTIPLIER;
    case "ellipse":
      return Math.round((height / 2) * SQRT2) - BOUND_TEXT_PADDING * 2;
    case "diamond":
      return Math.round(height / 2) - BOUND_TEXT_PADDING * 2;
    default:
      return height - BOUND_TEXT_PADDING * 2;
  }
};
