import {
    ARROW_LABEL_FONT_SIZE_TO_MIN_WIDTH_RATIO,
    ARROW_LABEL_HEIGHT_PADDING_MULTIPLIER,
    ARROW_LABEL_WIDTH_FRACTION,
    BOUND_TEXT_PADDING,
    DEFAULT_FONT_FAMILY,
    DEFAULT_FONT_SIZE,
    isLinear,
    lineHeightForFamily,
    MONOSPACE_FAMILIES,
} from "./model";
import {getElementBounds} from "./geometry";
import {isFontFamilyAvailable, lineWidthEm} from "./fonts";
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

const legacyCharAdvanceEm = (char: string, monospace: boolean): number => {
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

/**
 * The Helvetica-like advance table used before the real fonts were vendored.
 * Still measures glyphs no vendored font has (emoji, CJK) and everything when
 * the font files cannot be loaded.
 */
export const legacyTextMetricsProvider: TextMetricsProvider = {
  getLineWidth(text, fontSize, fontFamily) {
    const monospace = MONOSPACE_FAMILIES.has(fontFamily ?? 0);
    let total = 0;
    for (const char of text) {
      total += legacyCharAdvanceEm(char, monospace);
    }
    return total * fontSize;
  },
};

// Same numbers as the browser's canvas measureText: the client's own font files,
// advances plus pair kerning.
export const fontTextMetricsProvider: TextMetricsProvider = {
  getLineWidth(text, fontSize, fontFamily) {
    if (!isFontFamilyAvailable(fontFamily)) {
      return legacyTextMetricsProvider.getLineWidth(text, fontSize, fontFamily);
    }
    const monospace = MONOSPACE_FAMILIES.has(fontFamily ?? 0);
    return (
      lineWidthEm(text, fontFamily, (char) => legacyCharAdvanceEm(char, monospace)) *
      fontSize
    );
  },
};

let activeProvider: TextMetricsProvider = fontTextMetricsProvider;

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

export type TextLayout = {
  width: number;
  height: number;
  lineHeight: number;
  text: string;
};

export const layoutText = (
  text: string,
  fontSize: number = DEFAULT_FONT_SIZE,
  fontFamily: number = DEFAULT_FONT_FAMILY,
  maxWidth?: number,
): TextLayout => {
  const bounded = typeof maxWidth === "number" && maxWidth > 0;
  const wrapped = bounded
    ? wrapText(text, fontSize, fontFamily, maxWidth)
    : normalizeText(text);
  const measured = measureText(wrapped, fontSize, fontFamily);
  return {
    width: bounded ? maxWidth : Math.ceil(measured.width),
    height: Math.ceil(measured.height),
    lineHeight: lineHeightForFamily(fontFamily),
    text: wrapped,
  };
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

export const OVERFLOW_EPSILON = 1;

export const MIN_LABEL_FONT_SIZE = 8;

// Inverse of getBoundTextMaxWidth/Height: an inscribed shape needs a bigger box
// than its usable label area, so a diamond fitting 190px of text is 400px wide.
const CONTAINER_SHAPE_FACTOR: Record<string, number> = {
  ellipse: SQRT2,
  diamond: 2,
};

export const containerSizeForText = (
  containerType: string,
  textWidth: number,
  textHeight: number,
): { width: number; height: number } => {
  const factor = CONTAINER_SHAPE_FACTOR[containerType] ?? 1;
  return {
    width: Math.ceil((textWidth + BOUND_TEXT_PADDING * 2) * factor),
    height: Math.ceil((textHeight + BOUND_TEXT_PADDING * 2) * factor),
  };
};

export type ContainerTextFit = {
  usableWidth: number;
  usableHeight: number;
  textWidth: number;
  textHeight: number;
  widthOverflow: boolean;
  heightOverflow: boolean;
  fittedWidth: number;
  fittedHeight: number;
};

export const fitTextToContainer = (
  container: ExcalidrawElement,
  text: string,
  fontSize: number = DEFAULT_FONT_SIZE,
  fontFamily: number = DEFAULT_FONT_FAMILY,
): ContainerTextFit => {
  const linear = isLinear(container);
  const usableWidth = getBoundTextMaxWidth(container, fontSize);
  const usableHeight = linear ? Infinity : getBoundTextMaxHeight(container);
  const measured = measureText(
    wrapText(text, fontSize, fontFamily, usableWidth),
    fontSize,
    fontFamily,
  );
  const widthOverflow = measured.width > usableWidth + OVERFLOW_EPSILON;
  const heightOverflow =
    !linear &&
    usableHeight > 0 &&
    measured.height > usableHeight + OVERFLOW_EPSILON;

  const currentWidth = container.width || 0;
  const fittedWidth = widthOverflow
    ? Math.max(
        currentWidth,
        containerSizeForText(container.type, measured.width, 0).width,
      )
    : currentWidth;
  // Widening rewraps the text, so height must be measured against the wider box.
  const rewrapped =
    fittedWidth === currentWidth
      ? measured
      : measureText(
          wrapText(
            text,
            fontSize,
            fontFamily,
            getBoundTextMaxWidth({ ...container, width: fittedWidth }, fontSize),
          ),
          fontSize,
          fontFamily,
        );
  const fittedHeight = linear
    ? container.height || 0
    : Math.max(
        container.height || 0,
        containerSizeForText(container.type, 0, rewrapped.height).height,
      );

  return {
    usableWidth: Math.round(usableWidth),
    usableHeight: linear ? Infinity : Math.round(usableHeight),
    textWidth: Math.ceil(measured.width),
    textHeight: Math.ceil(measured.height),
    widthOverflow,
    heightOverflow,
    fittedWidth: Math.ceil(fittedWidth),
    fittedHeight: Math.ceil(fittedHeight),
  };
};

export const largestFittingFontSize = (
  container: ExcalidrawElement,
  text: string,
  fontFamily: number = DEFAULT_FONT_FAMILY,
  maxFontSize: number = DEFAULT_FONT_SIZE,
): number | null => {
  for (let size = Math.floor(maxFontSize) - 1; size >= MIN_LABEL_FONT_SIZE; size--) {
    const fit = fitTextToContainer(container, text, size, fontFamily);
    if (!fit.widthOverflow && !fit.heightOverflow) {
      return size;
    }
  }
  return null;
};
