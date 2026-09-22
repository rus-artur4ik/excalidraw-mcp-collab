import type {ExcalidrawElement} from "../types";
import {
  asText,
  BOUND_TEXT_PADDING,
  DEFAULT_FONT_FAMILY,
  DEFAULT_FONT_SIZE,
  isLinear,
  lineHeightForFamily,
  type Point,
} from "../verify/model";
import {globalLinearPoints} from "../verify/geometry";
import {
  getBoundTextMaxHeight,
  getBoundTextMaxWidth,
  getLineWidth,
  measureText,
  normalizeText,
  wrapText,
} from "../verify/textMetrics";

// Bound-text layout ported from the Excalidraw client (packages/element/src/
// textElement.ts: redrawTextBoundingBox, computeBoundTextPosition,
// getContainerCoords; linearElementEditor.getBoundTextElementPosition). The
// browser recomputes these fields on its first touch, so any other formula
// makes the board jump in front of the person looking at it.

export type TextAlign = "left" | "center" | "right";
export type VerticalAlign = "top" | "middle" | "bottom";

export type LabelStyle = {
  fontSize: number;
  fontFamily: number;
  textAlign: TextAlign;
  verticalAlign: VerticalAlign;
};

export const asTextAlign = (value: unknown, fallback: TextAlign = "center"): TextAlign =>
  value === "left" || value === "right" || value === "center" ? value : fallback;

export const asVerticalAlign = (
  value: unknown,
  fallback: VerticalAlign = "middle",
): VerticalAlign =>
  value === "top" || value === "bottom" || value === "middle" ? value : fallback;

export const labelStyleOf = (text: ExcalidrawElement | undefined): LabelStyle => {
  const view = text ? asText(text) : undefined;
  return {
    fontSize: typeof view?.fontSize === "number" ? view.fontSize : DEFAULT_FONT_SIZE,
    fontFamily:
      typeof view?.fontFamily === "number" ? view.fontFamily : DEFAULT_FONT_FAMILY,
    textAlign: asTextAlign(view?.textAlign),
    verticalAlign: asVerticalAlign(view?.verticalAlign),
  };
};

export const containerCoords = (container: ExcalidrawElement): Point => {
  let offsetX = BOUND_TEXT_PADDING;
  let offsetY = BOUND_TEXT_PADDING;
  const width = container.width || 0;
  const height = container.height || 0;
  if (container.type === "ellipse") {
    offsetX += (width / 2) * (1 - Math.SQRT2 / 2);
    offsetY += (height / 2) * (1 - Math.SQRT2 / 2);
  }
  if (container.type === "diamond") {
    offsetX += width / 4;
    offsetY += height / 4;
  }
  return [container.x + offsetX, container.y + offsetY];
};

// Where the client draws an arrow's label: on the middle point when the arrow
// has an odd number of points, else at the middle of the middle segment.
export const arrowLabelAnchor = (arrow: ExcalidrawElement): Point => {
  const points = globalLinearPoints(arrow);
  if (points.length % 2 === 1) {
    return points[Math.floor(points.length / 2)];
  }
  const index = points.length / 2 - 1;
  const a = points[index];
  const b = points[index + 1] ?? a;
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
};

export const computeContainerDimensionForBoundText = (
  dimension: number,
  containerType: string,
): number => {
  const size = Math.ceil(dimension);
  const padding = BOUND_TEXT_PADDING * 2;
  if (containerType === "ellipse") {
    return Math.round(((size + padding) / Math.SQRT2) * 2);
  }
  if (containerType === "arrow") {
    return size + padding * 8;
  }
  if (containerType === "diamond") {
    return 2 * (size + padding);
  }
  return size + padding;
};

// When the server grows a box for its label it leaves the lint's minimum
// padding (8 px) rather than the client's bare 5 px, so a fitted box is not
// immediately reported as tight. The client never shrinks a box, so the extra
// room survives.
export const COMFORT_PADDING = 8;

export const comfortableDimension = (dimension: number, containerType: string): number =>
  computeContainerDimensionForBoundText(
    dimension + (containerType === "arrow" ? 0 : 2 * (COMFORT_PADDING - BOUND_TEXT_PADDING)),
    containerType,
  );

export const boundTextPosition = (
  container: ExcalidrawElement,
  width: number,
  height: number,
  textAlign: TextAlign,
  verticalAlign: VerticalAlign,
): Point => {
  if (isLinear(container)) {
    const [cx, cy] = arrowLabelAnchor(container);
    return [cx - width / 2, cy - height / 2];
  }
  const [originX, originY] = containerCoords(container);
  const maxWidth = getBoundTextMaxWidth(container, DEFAULT_FONT_SIZE);
  const maxHeight = getBoundTextMaxHeight(container);
  const y =
    verticalAlign === "top"
      ? originY
      : verticalAlign === "bottom"
        ? originY + (maxHeight - height)
        : originY + (maxHeight / 2 - height / 2);
  const x =
    textAlign === "left"
      ? originX
      : textAlign === "right"
        ? originX + (maxWidth - width)
        : originX + (maxWidth / 2 - width / 2);
  const angle = container.angle || 0;
  if (!angle) {
    return [x, y];
  }
  const contentCenter: Point = [originX + maxWidth / 2, originY + maxHeight / 2];
  const textCenter: Point = [x + width / 2, y + height / 2];
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = textCenter[0] - contentCenter[0];
  const dy = textCenter[1] - contentCenter[1];
  return [
    contentCenter[0] + dx * cos - dy * sin - width / 2,
    contentCenter[1] + dx * sin + dy * cos - height / 2,
  ];
};

// Word-only wrapping for arrow labels: a short edge must not split a word in
// half (the client's own wrap breaks overlong words mid-word).
const wrapWords = (
  text: string,
  fontSize: number,
  fontFamily: number,
  maxWidth: number,
): string =>
  normalizeText(text)
    .split("\n")
    .flatMap((line) => {
      if (getLineWidth(line, fontSize, fontFamily) <= maxWidth) {
        return [line];
      }
      const words = line.split(/(\s+)/);
      const lines: string[] = [];
      let current = "";
      for (const token of words) {
        if (!token) {
          continue;
        }
        if (/^\s+$/.test(token)) {
          current += token;
          continue;
        }
        const candidate = current + token;
        if (!current.trim() || getLineWidth(candidate, fontSize, fontFamily) <= maxWidth) {
          current = candidate;
          continue;
        }
        lines.push(current.replace(/\s+$/, ""));
        current = token;
      }
      lines.push(current.replace(/\s+$/, ""));
      return lines;
    })
    .join("\n");

export type LabelLayout = {
  text: string;
  width: number;
  height: number;
  x: number;
  y: number;
  lineHeight: number;
  // Container size the client would grow to so the label fits (never shrinks).
  containerWidth: number;
  containerHeight: number;
};

export const layoutLabel = (
  container: ExcalidrawElement,
  originalText: string,
  style: LabelStyle,
): LabelLayout => {
  const { fontSize, fontFamily } = style;
  const linear = isLinear(container);
  const maxWidth = getBoundTextMaxWidth(container, fontSize);
  const wrapped = linear
    ? wrapWords(originalText, fontSize, fontFamily, maxWidth)
    : wrapText(originalText, fontSize, fontFamily, maxWidth);
  const metrics = measureText(wrapped, fontSize, fontFamily);
  const width = Math.ceil(metrics.width);
  const height = Math.ceil(metrics.height);
  let grown = container;
  if (!linear) {
    const maxHeight = getBoundTextMaxHeight(container);
    if (height > maxHeight) {
      grown = {
        ...grown,
        height: comfortableDimension(height, container.type),
      };
    }
    if (width > maxWidth + 0.5) {
      grown = {
        ...grown,
        width: comfortableDimension(width, container.type),
      };
    }
  }
  const [x, y] = boundTextPosition(grown, width, height, style.textAlign, style.verticalAlign);
  return {
    text: wrapped,
    width,
    height,
    x,
    y,
    lineHeight: lineHeightForFamily(fontFamily),
    containerWidth: grown.width || 0,
    containerHeight: grown.height || 0,
  };
};

export type WrapMode = "words" | "balanced" | "none";

// Break text into lines ourselves and write the breaks into the text (opt-in
// wrap:"balanced" / nowrap). The browser only re-wraps what is still too wide,
// so baked breaks survive; the price is that a later, wider box keeps them.
export const bakeLineBreaks = (
  text: string,
  fontSize: number,
  fontFamily: number,
  maxWidth: number,
  options: { wrap?: WrapMode; nowrap?: string[] } = {},
): string => {
  const wrap = options.wrap ?? "words";
  if (wrap === "none" || !Number.isFinite(maxWidth) || maxWidth <= 0) {
    return text;
  }
  const patterns = (options.nowrap ?? []).map((source) => new RegExp(source, "gu"));
  const paragraphs = normalizeText(text).split("\n");
  const wrapParagraph = (paragraph: string, width: number): string[] => {
    // Positions of spaces that must not become line breaks: inside a nowrap
    // match, or right before a joiner glyph (a line never starts with · — →).
    const glued = new Set<number>();
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      for (const match of paragraph.matchAll(pattern)) {
        const start = match.index ?? 0;
        for (let i = start; i < start + match[0].length; i++) {
          if (paragraph[i] === " ") glued.add(i);
        }
      }
    }
    for (let i = 0; i < paragraph.length - 1; i++) {
      if (paragraph[i] === " " && /[·—→]/u.test(paragraph[i + 1])) glued.add(i);
    }
    const tokens: string[] = [];
    let current = "";
    for (let i = 0; i < paragraph.length; i++) {
      const char = paragraph[i];
      if (char === " " && !glued.has(i)) {
        if (current) tokens.push(current);
        current = "";
      } else {
        current += char;
      }
    }
    if (current) tokens.push(current);
    const lines: string[] = [];
    let line = "";
    for (const token of tokens) {
      const candidate = line ? `${line} ${token}` : token;
      if (!line || getLineWidth(candidate, fontSize, fontFamily) <= width) {
        line = candidate;
      } else {
        lines.push(line);
        line = token;
      }
    }
    lines.push(line);
    return lines;
  };
  return paragraphs
    .flatMap((paragraph) => {
      const greedy = wrapParagraph(paragraph, maxWidth);
      if (wrap !== "balanced" || greedy.length < 2 || greedy.length > 3) {
        return greedy;
      }
      // Narrowest width that still gives the same number of lines: the last
      // line stops being a lone word.
      let lo = maxWidth / greedy.length;
      let hi = maxWidth;
      let best = greedy;
      for (let step = 0; step < 18; step++) {
        const mid = (lo + hi) / 2;
        const lines = wrapParagraph(paragraph, mid);
        if (lines.length === greedy.length) {
          best = lines;
          hi = mid;
        } else {
          lo = mid;
        }
      }
      return best;
    })
    .join("\n");
};
