import type {ExcalidrawElement} from "../types";
import {
    asLinear,
    asText,
    type Bounds,
    BOUND_TEXT_PADDING,
    DEFAULT_EXPORT_PADDING,
    DEFAULT_FONT_FAMILY,
    DEFAULT_FONT_SIZE,
    type FrameView,
    isFrameLike,
    isLinear,
    isTransparent,
    lineHeightForFamily,
    type Point,
} from "./model";
import {
    computeTransform,
    getElementBounds,
    globalLinearPoints,
    pointInElement,
    rotatePoint,
    sceneToPixel,
    type Transform,
} from "./geometry";
import {
    genericFontFamilies,
    getVendoredFontFiles,
    getVerticalOffset,
    splitFontRuns,
    svgFontFamily,
    uncoveredChars,
} from "./fonts";
import {getLineWidth} from "./textMetrics";

const MAX_RENDER_SCALE = 4;
const MIN_RENDER_SCALE = 0.1;
const MAX_RENDER_PIXELS = 4_000_000;
const DEFAULT_MAX_PIXEL_WIDTH = 1600;
const MAX_AUTO_SCALE = 2;
const MIN_READABLE_FONT_PX = 10;
const MAX_TILES = 36;

// FRAME_STYLE in the client (packages/common/src/constants.ts).
const FRAME_STROKE = "#bbb";
const FRAME_STROKE_WIDTH = 2;
const FRAME_RADIUS = 8;
const FRAME_NAME_OFFSET_Y = 3;
const FRAME_NAME_COLOR = "#999999";
const FRAME_NAME_FONT_SIZE = 14;
const FRAME_NAME_LINE_HEIGHT = 1.25;
const FRAME_NAME_FONT_FAMILY = 2;

const HIGHLIGHT_COLOR = "#e03131";
const HIGHLIGHT_WIDTH = 3;
const HIGHLIGHT_GAP = 4;

const SHEET_GUTTER = 12;
const SHEET_LABEL_HEIGHT = 20;
const SHEET_LABEL_FONT_SIZE = 13;

const COMPACT_TEXT_MAX = 80;

// Characters XML 1.0 forbids; one stray control char makes resvg reject the SVG.
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

const escapeXml = (value: string): string =>
  value
    .replace(INVALID_XML, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const n2 = (value: number): string => String(Math.round(value * 100) / 100);

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

// --- Public types ---

export type LegendMode = "none" | "ids" | "compact" | "frames" | "full";

export type RenderLayout = "single" | "tiles" | "sheet";

export type LegendEntry = {
  label: string;
  id: string;
  type: string;
  z: number;
  index: string | null;
  bbox: [number, number, number, number];
  textPreview?: string;
};

export type FrameLegendEntry = {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * Whether the picture can be trusted for text geometry. `fontFallback` lists the
 * text ids with characters none of the vendored client fonts covers (their width
 * in the PNG comes from a system font); `arrowLabelMasking` tells whether arrow
 * strokes are cut out under their bound labels as in the client.
 */
export type RenderFidelity =
  | { ok: true }
  | { ok: false; fontFallback: string[]; arrowLabelMasking: boolean };

export type RenderReadability = {
  /** The scale actually used (output px per scene unit). */
  fitScale: number;
  /** Smallest drawn text size in output pixels; null when no text is drawn. */
  minEffectiveFontPx: number | null;
};

export type RenderTile = {
  region: Bounds;
  svg: string;
  transform: Transform;
  width: number;
  height: number;
  readability: RenderReadability;
};

export type SheetCell = {
  id: string;
  /** Scene rectangle shown in this cell. */
  region: Bounds;
  /** Cell rectangle in sheet pixels (below its id label). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Maps scene coordinates to sheet pixels for this cell. */
  transform: Transform;
};

export type RenderOptions = {
  padding?: number;
  /** Explicit scale; when omitted the scale fits maxPixelWidth and never exceeds 2. */
  scale?: number;
  /** Width budget for the automatic scale, tiles and sheets (default 1600). */
  maxPixelWidth?: number;
  showGrid?: boolean;
  gridSize?: number;
  /** Set-of-Mark ordinal badges (default true). */
  showLabels?: boolean;
  /** Frame names above frames, like the client (default true). */
  showFrameNames?: boolean;
  viewBackgroundColor?: string;
  /** Draw only these ids (plus their bound labels and, for frames, their children). */
  ids?: string[];
  region?: Bounds;
  /** Legend format (default "full"; the MCP tools default to "none"). */
  legend?: LegendMode;
  /** Ids to outline with a dashed red box. */
  highlight?: string[];
  /** "tiles" splits a big area into readable tiles; "sheet" crops each of `ids`. */
  layout?: RenderLayout;
};

export type RenderResultBase = {
  svg: string;
  /**
   * Scene → pixel mapping of `svg`. For a sheet it is the identity on sheet
   * pixels; use `sheet[i].transform` per cell instead.
   */
  transform: Transform;
  width: number;
  height: number;
  legendOrder: "z-ascending";
  fidelity: RenderFidelity;
  readability: RenderReadability;
  layout: RenderLayout;
  /** layout "tiles": readable tiles covering the area; `svg` is then an overview. */
  tiles?: RenderTile[];
  /** layout "sheet": where each id's crop sits in `svg`. */
  sheet?: SheetCell[];
};

/**
 * Render output; `legend` depends on `legendMode`:
 * - "none": no legend;
 * - "ids": element ids in z-order (bottom → top);
 * - "compact": `"<id> <type> <x> <y> <w> <h> <text>"` lines in scene coordinates
 *   (rounded axis-aligned bounds); a container's line carries its bound label's
 *   text and bound labels get no line of their own; frames carry their name;
 * - "frames": the frames in view with name and scene rectangle;
 * - "full": one LegendEntry per drawn element with pixel bbox and ordinal label
 *   (the ordinal the Set-of-Mark badges show).
 */
export type RenderLegend =
  | { legendMode: "none"; legend?: undefined }
  | { legendMode: "ids"; legend: string[] }
  | { legendMode: "compact"; legend: string[] }
  | { legendMode: "frames"; legend: FrameLegendEntry[] }
  | { legendMode: "full"; legend: LegendEntry[] };

export type RenderResult = RenderResultBase & RenderLegend;

/** Result type narrowed to one legend mode. */
export type RenderResultFor<M extends LegendMode> = RenderResultBase &
  Extract<RenderLegend, { legendMode: M }>;

// --- Scene index ---

type SceneIndex = {
  live: ExcalidrawElement[];
  byId: Map<string, ExcalidrawElement>;
  /** Container id → its bound text. */
  labelOf: Map<string, ExcalidrawElement>;
};

const indexScene = (all: readonly ExcalidrawElement[]): SceneIndex => {
  const live = all.filter((e) => !e.isDeleted);
  const byId = new Map(live.map((e) => [e.id, e] as const));
  const labelOf = new Map<string, ExcalidrawElement>();
  for (const element of live) {
    const containerId = element.type === "text" ? asText(element).containerId : null;
    if (typeof containerId === "string" && byId.has(containerId)) {
      labelOf.set(containerId, element);
    }
  }
  return { live, byId, labelOf };
};

const containerOf = (
  element: ExcalidrawElement,
  index: SceneIndex,
): ExcalidrawElement | undefined => {
  if (element.type !== "text") {
    return undefined;
  }
  const containerId = asText(element).containerId;
  return typeof containerId === "string" ? index.byId.get(containerId) : undefined;
};

const sortByIndex = (
  elements: readonly ExcalidrawElement[],
): ExcalidrawElement[] =>
  [...elements].sort((a, b) => {
    if (typeof a.index === "string" && typeof b.index === "string") {
      return a.index < b.index ? -1 : a.index > b.index ? 1 : 0;
    }
    return 0;
  });

const frameName = (frame: ExcalidrawElement): string => {
  const name = (frame as FrameView).name;
  if (typeof name === "string") {
    return name;
  }
  return frame.type === "magicframe" ? "AI Frame" : "Frame";
};

// --- Linear geometry (client: rough.js curve + LinearElementEditor) ---

type Bezier = [Point, Point, Point, Point];

type LinearPath = { points: Point[]; curves: Bezier[] | null };

// rough.js `curve` (roughness 0): Catmull-Rom through the points with the end
// points duplicated.
const catmullRom = (points: Point[]): Bezier[] => {
  const ps = [points[0], ...points, points[points.length - 1]];
  const curves: Bezier[] = [];
  for (let i = 1; i + 2 < ps.length; i++) {
    const p = ps[i];
    const b1: Point = [p[0] + (ps[i + 1][0] - ps[i - 1][0]) / 6, p[1] + (ps[i + 1][1] - ps[i - 1][1]) / 6];
    const b2: Point = [
      ps[i + 1][0] + (p[0] - ps[i + 2][0]) / 6,
      ps[i + 1][1] + (p[1] - ps[i + 2][1]) / 6,
    ];
    curves.push([p, b1, b2, ps[i + 1]]);
  }
  return curves;
};

const linearPath = (element: ExcalidrawElement): LinearPath => {
  const points = globalLinearPoints(element);
  const curved =
    element.type !== "freedraw" &&
    element.roundness !== null &&
    element.roundness !== undefined &&
    !asLinear(element).elbowed &&
    points.length > 2;
  return { points, curves: curved ? catmullRom(points) : null };
};

const pathData = (path: LinearPath): string => {
  const [first, ...rest] = path.points;
  if (!path.curves) {
    return `M${n2(first[0])} ${n2(first[1])}${rest.map((p) => `L${n2(p[0])} ${n2(p[1])}`).join("")}`;
  }
  return `M${n2(first[0])} ${n2(first[1])}${path.curves
    .map(([, b1, b2, end]) => `C${n2(b1[0])} ${n2(b1[1])} ${n2(b2[0])} ${n2(b2[1])} ${n2(end[0])} ${n2(end[1])}`)
    .join("")}`;
};

const bezierAt = ([p0, p1, p2, p3]: Bezier, t: number): Point => {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * t * u * u;
  const c = 3 * t * t * u;
  const d = t * t * t;
  return [
    a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
    a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
  ];
};

const bezierHalfLengthPoint = (curve: Bezier): Point => {
  const samples: Point[] = [];
  for (let i = 0; i <= 32; i++) {
    samples.push(bezierAt(curve, i / 32));
  }
  const lengths = [0];
  for (let i = 1; i < samples.length; i++) {
    lengths.push(lengths[i - 1] + Math.hypot(samples[i][0] - samples[i - 1][0], samples[i][1] - samples[i - 1][1]));
  }
  const half = lengths[lengths.length - 1] / 2;
  for (let i = 1; i < samples.length; i++) {
    if (lengths[i] >= half) {
      const span = lengths[i] - lengths[i - 1] || 1;
      const f = (half - lengths[i - 1]) / span;
      return [
        samples[i - 1][0] + (samples[i][0] - samples[i - 1][0]) * f,
        samples[i - 1][1] + (samples[i][1] - samples[i - 1][1]) * f,
      ];
    }
  }
  return samples[samples.length - 1];
};

const pointsCenter = (points: Point[]): Point => {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
};

const rotationCenter = (element: ExcalidrawElement): Point =>
  isLinear(element) || element.type === "freedraw"
    ? pointsCenter(globalLinearPoints(element))
    : [element.x + (element.width || 0) / 2, element.y + (element.height || 0) / 2];

// LinearElementEditor.getBoundTextElementPosition: the label sits on the middle
// point (odd point count) or the middle of the middle segment.
const linearLabelCenter = (element: ExcalidrawElement, path: LinearPath): Point => {
  const pts = path.points;
  let center: Point;
  if (pts.length % 2 === 1) {
    center = pts[Math.floor(pts.length / 2)];
  } else {
    const i = pts.length / 2 - 1;
    center = path.curves
      ? bezierHalfLengthPoint(path.curves[i])
      : [(pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2];
  }
  const angle = element.angle || 0;
  return angle ? rotatePoint(center, rotationCenter(element), angle) : center;
};

type Box = { x: number; y: number; width: number; height: number };

const labelBox = (
  container: ExcalidrawElement | undefined,
  label: ExcalidrawElement,
): Box => {
  const width = label.width || 0;
  const height = label.height || 0;
  if (container && isLinear(container)) {
    const [cx, cy] = linearLabelCenter(container, linearPath(container));
    return { x: cx - width / 2, y: cy - height / 2, width, height };
  }
  return { x: label.x, y: label.y, width, height };
};

// --- Arrowheads (client: getArrowheadPoints / getArrowheadShapes) ---

const normalizeArrowhead = (arrowhead: string | null | undefined): string | null => {
  switch (arrowhead) {
    case undefined:
    case null:
      return null;
    case "dot":
      return "circle";
    case "crowfoot_one":
      return "cardinality_one";
    case "crowfoot_many":
      return "cardinality_many";
    case "crowfoot_one_or_many":
      return "cardinality_one_or_many";
    default:
      return arrowhead;
  }
};

const arrowheadSize = (arrowhead: string): number => {
  switch (arrowhead) {
    case "arrow":
      return 25;
    case "diamond":
    case "diamond_outline":
      return 12;
    case "cardinality_one":
    case "cardinality_exactly_one":
    case "cardinality_zero_or_one":
      return 20;
    default:
      return 15;
  }
};

const arrowheadAngle = (arrowhead: string): number =>
  ((arrowhead === "bar" ? 90 : arrowhead === "arrow" ? 20 : 25) * Math.PI) / 180;

type HeadGeometry = {
  tip: Point;
  /** Unit vector pointing out of the line at the tip. */
  dir: Point;
  segmentLength: number;
  /** The neighbour point of the tip (for the diamond's far corner). */
  neighbour: Point;
};

const headGeometry = (path: LinearPath, position: "start" | "end"): HeadGeometry | null => {
  const pts = path.points;
  if (pts.length < 2) {
    return null;
  }
  const end = position === "end";
  const tip = end ? pts[pts.length - 1] : pts[0];
  const neighbour = end ? pts[pts.length - 2] : pts[1];
  // The client aims the head from the point at t=0.7 of the end segment's bezier.
  let from: Point;
  if (path.curves) {
    from = bezierAt(end ? path.curves[path.curves.length - 1] : path.curves[0], 0.7);
  } else {
    const [a, b] = end ? [neighbour, tip] : [tip, neighbour];
    from = [a[0] + (b[0] - a[0]) * 0.7, a[1] + (b[1] - a[1]) * 0.7];
  }
  const dx = tip[0] - from[0];
  const dy = tip[1] - from[1];
  const distance = Math.hypot(dx, dy);
  if (!distance) {
    return null;
  }
  return {
    tip,
    dir: [dx / distance, dy / distance],
    segmentLength: Math.hypot(tip[0] - neighbour[0], tip[1] - neighbour[1]),
    neighbour,
  };
};

const arrowheadPoints = (
  geo: HeadGeometry,
  arrowhead: string,
  strokeWidth: number,
  position: "start" | "end",
  offsetMultiplier = 0,
): number[] => {
  const [x2, y2] = geo.tip;
  const [nx, ny] = geo.dir;
  const diamond = arrowhead === "diamond" || arrowhead === "diamond_outline";
  const minSize = Math.min(arrowheadSize(arrowhead), geo.segmentLength * (diamond ? 0.25 : 0.5));
  const tx = x2 - nx * minSize * offsetMultiplier;
  const ty = y2 - ny * minSize * offsetMultiplier;
  const xs = tx - nx * minSize;
  const ys = ty - ny * minSize;
  if (arrowhead === "circle" || arrowhead === "circle_outline") {
    return [tx, ty, Math.hypot(ys - ty, xs - tx) + strokeWidth - 2];
  }
  const angle = arrowheadAngle(arrowhead);
  if (arrowhead === "cardinality_many" || arrowhead === "cardinality_one_or_many") {
    const [x3, y3] = rotatePoint([tx, ty], [xs, ys], -angle);
    const [x4, y4] = rotatePoint([tx, ty], [xs, ys], angle);
    return [xs, ys, x3, y3, x4, y4];
  }
  const [x3, y3] = rotatePoint([xs, ys], [tx, ty], -angle);
  const [x4, y4] = rotatePoint([xs, ys], [tx, ty], angle);
  if (diamond) {
    const [px, py] = geo.neighbour;
    const [ox, oy] =
      position === "start"
        ? rotatePoint([tx + minSize * 2, ty], [tx, ty], Math.atan2(py - ty, px - tx))
        : rotatePoint([tx - minSize * 2, ty], [tx, ty], Math.atan2(ty - py, tx - px));
    return [tx, ty, x3, y3, ox, oy, x4, y4];
  }
  return [tx, ty, x3, y3, x4, y4];
};

const pointList = (coords: number[]): string => {
  const parts: string[] = [];
  for (let i = 0; i + 1 < coords.length; i += 2) {
    parts.push(`${n2(coords[i])},${n2(coords[i + 1])}`);
  }
  return parts.join(" ");
};

// Heads are always drawn solid so a dotted arrow still shows its head type.
const arrowheadSvg = (
  geo: HeadGeometry,
  rawArrowhead: string,
  stroke: string,
  strokeWidth: number,
  background: string,
  position: "start" | "end",
): string => {
  const arrowhead = normalizeArrowhead(rawArrowhead);
  if (!arrowhead) {
    return "";
  }
  const lineStyle = `stroke="${stroke}" stroke-width="${n2(strokeWidth)}" stroke-linecap="round" stroke-linejoin="round"`;
  const pts = (head: string, offset = 0) => arrowheadPoints(geo, head, strokeWidth, position, offset);
  const one = (offset: number) => {
    const [, , x3, y3, x4, y4] = pts("cardinality_one", offset);
    return `<polyline points="${pointList([x3, y3, x4, y4])}" fill="none" ${lineStyle} />`;
  };
  const many = () => {
    const [x2, y2, x3, y3, x4, y4] = pts("cardinality_many");
    return `<polyline points="${pointList([x3, y3, x2, y2, x4, y4])}" fill="none" ${lineStyle} />`;
  };
  const circle = (head: string, offset: number, fill: string, diameterScale = 1) => {
    const [cx, cy, diameter] = pts(head, offset);
    return `<circle cx="${n2(cx)}" cy="${n2(cy)}" r="${n2(Math.max(0.5, (diameter * diameterScale) / 2))}" fill="${fill}" ${lineStyle} />`;
  };
  switch (arrowhead) {
    case "circle":
    case "circle_outline":
      return circle(arrowhead, 0, arrowhead === "circle" ? stroke : background);
    case "triangle":
    case "triangle_outline": {
      const [x, y, x3, y3, x4, y4] = pts(arrowhead);
      const fill = arrowhead === "triangle" ? stroke : background;
      return `<polygon points="${pointList([x, y, x3, y3, x4, y4])}" fill="${fill}" ${lineStyle} />`;
    }
    case "diamond":
    case "diamond_outline": {
      const fill = arrowhead === "diamond" ? stroke : background;
      return `<polygon points="${pointList(pts(arrowhead))}" fill="${fill}" ${lineStyle} />`;
    }
    case "cardinality_one":
      return one(0);
    case "cardinality_many":
      return many();
    case "cardinality_one_or_many":
      return many() + one(-0.25);
    case "cardinality_exactly_one":
      return one(-0.5) + one(0);
    case "cardinality_zero_or_one":
      return circle("circle_outline", 1.5, background, 0.8) + one(-0.5);
    case "cardinality_zero_or_many":
      return many() + circle("circle_outline", 1.5, background, 0.8);
    default: {
      const [x, y, x3, y3, x4, y4] = pts(arrowhead);
      return `<polyline points="${pointList([x3, y3, x, y, x4, y4])}" fill="none" ${lineStyle} />`;
    }
  }
};

// --- Element drawing ---

type DrawContext = {
  prefix: string;
  index: SceneIndex;
  background: string;
  defs: string[];
  patterns: Map<string, string>;
  clips: Map<string, string>;
  counter: number;
  fontFallback: Set<string>;
  fontSizes: number[];
};

const nextId = (ctx: DrawContext, kind: string): string => {
  ctx.counter += 1;
  return `${ctx.prefix}${kind}${ctx.counter}`;
};

const strokeFor = (element: ExcalidrawElement): string =>
  isTransparent(element.strokeColor) ? "none" : escapeXml(element.strokeColor);

// Client: non-solid strokes are drawn 0.5 wider; dashes [8, 8+w], dots [1.5, 6+w].
const strokeWidthFor = (element: ExcalidrawElement): number =>
  (element.strokeWidth || 1) + (element.strokeStyle === "dashed" || element.strokeStyle === "dotted" ? 0.5 : 0);

const dashFor = (element: ExcalidrawElement): string => {
  const w = element.strokeWidth || 1;
  if (element.strokeStyle === "dashed") {
    return ` stroke-dasharray="8 ${n2(8 + w)}"`;
  }
  if (element.strokeStyle === "dotted") {
    return ` stroke-dasharray="1.5 ${n2(6 + w)}" stroke-linecap="round"`;
  }
  return "";
};

const strokeAttrs = (element: ExcalidrawElement): string =>
  `stroke="${strokeFor(element)}" stroke-width="${n2(strokeWidthFor(element))}"${dashFor(element)}`;

// rough.js hachure: lines at -41°, gap 4×strokeWidth, weight strokeWidth/2.
const fillFor = (element: ExcalidrawElement, ctx: DrawContext): string => {
  if (isTransparent(element.backgroundColor)) {
    return "none";
  }
  const color = escapeXml(element.backgroundColor);
  const style = element.fillStyle;
  if (style !== "hachure" && style !== "cross-hatch" && style !== "zigzag") {
    return color;
  }
  const strokeWidth = element.strokeWidth || 1;
  const cross = style === "cross-hatch";
  const key = `${color}|${strokeWidth}|${cross}`;
  let id = ctx.patterns.get(key);
  if (!id) {
    id = nextId(ctx, "p");
    ctx.patterns.set(key, id);
    const gap = Math.max(2, strokeWidth * 4);
    const weight = Math.max(0.5, strokeWidth / 2);
    const lines =
      `<line x1="0" y1="${n2(gap / 2)}" x2="${n2(gap)}" y2="${n2(gap / 2)}" stroke="${color}" stroke-width="${n2(weight)}" />` +
      (cross
        ? `<line x1="${n2(gap / 2)}" y1="0" x2="${n2(gap / 2)}" y2="${n2(gap)}" stroke="${color}" stroke-width="${n2(weight)}" />`
        : "");
    ctx.defs.push(
      `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${n2(gap)}" height="${n2(gap)}" patternTransform="rotate(-41)">${lines}</pattern>`,
    );
  }
  return `url(#${id})`;
};

// Client getCornerRadius.
const cornerRadius = (element: ExcalidrawElement): number => {
  const size = Math.min(element.width || 0, element.height || 0);
  const roundness = element.roundness;
  if (!roundness) {
    return 0;
  }
  if (roundness.type === 1 || roundness.type === 2) {
    return size * 0.25;
  }
  if (roundness.type === 3) {
    const fixed = roundness.value ?? 32;
    return size <= fixed / 0.25 ? size * 0.25 : fixed;
  }
  return 0;
};

const isPathALoop = (points: Point[]): boolean =>
  points.length >= 3 &&
  Math.hypot(points[0][0] - points[points.length - 1][0], points[0][1] - points[points.length - 1][1]) <= 8;

const renderTextLines = (
  element: ExcalidrawElement,
  box: Box,
  ctx: DrawContext,
): string => {
  const text = asText(element);
  const fontSize = text.fontSize ?? DEFAULT_FONT_SIZE;
  const fontFamily = text.fontFamily ?? DEFAULT_FONT_FAMILY;
  const lineHeight =
    typeof text.lineHeight === "number" && text.lineHeight > 0
      ? text.lineHeight
      : lineHeightForFamily(fontFamily);
  const lineHeightPx = fontSize * lineHeight;
  const verticalOffset = getVerticalOffset(fontFamily, fontSize, lineHeightPx);
  const anchor =
    text.textAlign === "center" ? "middle" : text.textAlign === "right" ? "end" : "start";
  const anchorX =
    text.textAlign === "center"
      ? box.x + box.width / 2
      : text.textAlign === "right"
        ? box.x + box.width
        : box.x;
  const content = String(text.text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "        ");
  ctx.fontSizes.push(fontSize);
  if (uncoveredChars(content, fontFamily).length) {
    ctx.fontFallback.add(element.id);
  }
  const family = escapeXml(svgFontFamily(fontFamily));
  const common = `font-size="${n2(fontSize)}" fill="${strokeFor(element)}" xml:space="preserve" style="white-space:pre"`;
  return content
    .split("\n")
    .map((line, i) => {
      const y = n2(box.y + verticalOffset + i * lineHeightPx);
      const runs = splitFontRuns(line, fontFamily);
      if (runs.length <= 1 && !runs[0]?.family) {
        return `<text x="${n2(anchorX)}" y="${y}" font-family="${family}" text-anchor="${anchor}" ${common}>${escapeXml(line)}</text>`;
      }
      // One chunk per font run, laid out with the metric engine's widths.
      const widths = runs.map((run) => getLineWidth(run.text, fontSize, fontFamily));
      const total = widths.reduce((a, b) => a + b, 0);
      let x = anchor === "middle" ? anchorX - total / 2 : anchor === "end" ? anchorX - total : anchorX;
      return runs
        .map((run, j) => {
          const chunk = `<text x="${n2(x)}" y="${y}" font-family="${run.family ? escapeXml(run.family) : family}" ${common}>${escapeXml(run.text)}</text>`;
          x += widths[j];
          return chunk;
        })
        .join("");
    })
    .join("");
};

const renderLinear = (
  element: ExcalidrawElement,
  ctx: DrawContext,
): string => {
  const path = linearPath(element);
  const stroke = strokeFor(element);
  const linear = asLinear(element);
  const closedFill =
    element.type === "line" && isPathALoop(path.points) ? fillFor(element, ctx) : "none";
  let body = `<path d="${pathData(path)}${closedFill !== "none" ? "Z" : ""}" fill="${closedFill}" ${strokeAttrs(element)} stroke-linejoin="round" />`;
  if (element.type === "arrow" && stroke !== "none") {
    const width = strokeWidthFor(element);
    // An arrow without an explicit endArrowhead field gets the default head.
    const end = linear.endArrowhead === undefined ? "arrow" : linear.endArrowhead;
    const endGeo = end ? headGeometry(path, "end") : null;
    if (end && endGeo) {
      body += arrowheadSvg(endGeo, end, stroke, width, ctx.background, "end");
    }
    const startGeo = linear.startArrowhead ? headGeometry(path, "start") : null;
    if (linear.startArrowhead && startGeo) {
      body += arrowheadSvg(startGeo, linear.startArrowhead, stroke, width, ctx.background, "start");
    }
  }
  return body;
};

const renderElementBody = (element: ExcalidrawElement, ctx: DrawContext): string => {
  switch (element.type) {
    case "rectangle": {
      const rx = cornerRadius(element);
      return `<rect x="${n2(element.x)}" y="${n2(element.y)}" width="${n2(element.width || 0)}" height="${n2(element.height || 0)}" rx="${n2(rx)}" fill="${fillFor(element, ctx)}" ${strokeAttrs(element)} />`;
    }
    case "image":
    case "embeddable":
    case "iframe":
      return `<rect x="${n2(element.x)}" y="${n2(element.y)}" width="${n2(element.width || 0)}" height="${n2(element.height || 0)}" fill="#f1f3f5" stroke="#adb5bd" stroke-width="1" />`;
    case "frame":
    case "magicframe":
      // Frames are containers: an outline only, never a fill over their children.
      return `<rect x="${n2(element.x)}" y="${n2(element.y)}" width="${n2(element.width || 0)}" height="${n2(element.height || 0)}" rx="${FRAME_RADIUS}" fill="none" stroke="${element.type === "magicframe" ? "#7affd7" : FRAME_STROKE}" stroke-width="${FRAME_STROKE_WIDTH}" />`;
    case "ellipse": {
      const rx = (element.width || 0) / 2;
      const ry = (element.height || 0) / 2;
      return `<ellipse cx="${n2(element.x + rx)}" cy="${n2(element.y + ry)}" rx="${n2(rx)}" ry="${n2(ry)}" fill="${fillFor(element, ctx)}" ${strokeAttrs(element)} />`;
    }
    case "diamond": {
      const w = element.width || 0;
      const h = element.height || 0;
      const cx = element.x + w / 2;
      const cy = element.y + h / 2;
      const pts = pointList([cx, element.y, element.x + w, cy, cx, element.y + h, element.x, cy]);
      return `<polygon points="${pts}" fill="${fillFor(element, ctx)}" ${strokeAttrs(element)} stroke-linejoin="round" />`;
    }
    case "line":
    case "arrow":
      return renderLinear(element, ctx);
    case "freedraw": {
      const pts = globalLinearPoints(element)
        .map((p) => `${n2(p[0])},${n2(p[1])}`)
        .join(" ");
      return `<polyline points="${pts}" fill="none" ${strokeAttrs(element)} stroke-linecap="round" stroke-linejoin="round" />`;
    }
    case "text":
      return renderTextLines(
        element,
        { x: element.x, y: element.y, width: element.width || 0, height: element.height || 0 },
        ctx,
      );
    default:
      return `<rect x="${n2(element.x)}" y="${n2(element.y)}" width="${n2(element.width || 0)}" height="${n2(element.height || 0)}" fill="none" stroke="#adb5bd" stroke-dasharray="4 4" />`;
  }
};

const opacityAttr = (element: ExcalidrawElement): string => {
  const o = (element.opacity ?? 100) / 100;
  return o >= 1 ? "" : ` opacity="${o.toFixed(2)}"`;
};

const rotated = (element: ExcalidrawElement, body: string, center?: Point): string => {
  const angle = element.angle || 0;
  if (!angle) {
    return body;
  }
  const [cx, cy] = center ?? rotationCenter(element);
  return `<g transform="rotate(${((angle * 180) / Math.PI).toFixed(3)} ${n2(cx)} ${n2(cy)})">${body}</g>`;
};

const renderLabel = (
  label: ExcalidrawElement,
  container: ExcalidrawElement | undefined,
  ctx: DrawContext,
): string => {
  const box = labelBox(container, label);
  const body = renderTextLines(label, box, ctx);
  return `<g${opacityAttr(label)}>${rotated(label, body, [box.x + box.width / 2, box.y + box.height / 2])}</g>`;
};

// The client clips everything inside a frame to the frame's rounded rectangle.
const frameClipId = (frame: ExcalidrawElement, ctx: DrawContext): string => {
  let id = ctx.clips.get(frame.id);
  if (!id) {
    id = nextId(ctx, "f");
    ctx.clips.set(frame.id, id);
    ctx.defs.push(
      `<clipPath id="${id}" clipPathUnits="userSpaceOnUse"><rect x="${n2(frame.x)}" y="${n2(frame.y)}" width="${n2(frame.width || 0)}" height="${n2(frame.height || 0)}" rx="${FRAME_RADIUS}" /></clipPath>`,
    );
  }
  return id;
};

const renderElement = (
  element: ExcalidrawElement,
  label: ExcalidrawElement | undefined,
  ctx: DrawContext,
): string => {
  let body = `<g${opacityAttr(element)}>${rotated(element, renderElementBody(element, ctx))}</g>`;
  if (label && isLinear(element)) {
    // Cut the stroke out under the label (+BOUND_TEXT_PADDING), as the client does.
    const box = labelBox(element, label);
    const [minX, minY, maxX, maxY] = getElementBounds(element);
    const margin = 100;
    const maskId = nextId(ctx, "m");
    ctx.defs.push(
      `<mask id="${maskId}" maskUnits="userSpaceOnUse" x="${n2(Math.min(minX, box.x) - margin)}" y="${n2(Math.min(minY, box.y) - margin)}" width="${n2(Math.max(maxX, box.x + box.width) - Math.min(minX, box.x) + margin * 2)}" height="${n2(Math.max(maxY, box.y + box.height) - Math.min(minY, box.y) + margin * 2)}">` +
        `<rect x="${n2(minX - margin)}" y="${n2(minY - margin)}" width="${n2(maxX - minX + margin * 2)}" height="${n2(maxY - minY + margin * 2)}" fill="#fff" />` +
        `<rect x="${n2(box.x - BOUND_TEXT_PADDING)}" y="${n2(box.y - BOUND_TEXT_PADDING)}" width="${n2(box.width + BOUND_TEXT_PADDING * 2)}" height="${n2(box.height + BOUND_TEXT_PADDING * 2)}" fill="#000" /></mask>`,
    );
    body = `<g mask="url(#${maskId})">${body}</g>`;
  }
  if (label) {
    body += renderLabel(label, element, ctx);
  }
  const frameId = element.frameId;
  const frame = typeof frameId === "string" ? ctx.index.byId.get(frameId) : undefined;
  if (frame && isFrameLike(frame)) {
    return `<g clip-path="url(#${frameClipId(frame, ctx)})">${body}</g>`;
  }
  return body;
};

const gridLines = (bounds: Bounds, gridSize: number): string => {
  const [minX, minY, maxX, maxY] = bounds;
  const lines: string[] = [];
  const startX = Math.floor(minX / gridSize) * gridSize;
  const startY = Math.floor(minY / gridSize) * gridSize;
  for (let x = startX; x <= maxX; x += gridSize) {
    lines.push(`<line x1="${x}" y1="${n2(minY)}" x2="${x}" y2="${n2(maxY)}" stroke="#e9ecef" stroke-width="0.5" />`);
  }
  for (let y = startY; y <= maxY; y += gridSize) {
    lines.push(`<line x1="${n2(minX)}" y1="${y}" x2="${n2(maxX)}" y2="${y}" stroke="#e9ecef" stroke-width="0.5" />`);
  }
  return lines.join("");
};

// --- Legends ---

const textPreviewOf = (element: ExcalidrawElement): string | undefined => {
  const t = asText(element).text;
  if (typeof t !== "string" || !t.trim()) {
    return undefined;
  }
  const flat = t.replace(/\s+/g, " ").trim();
  return flat.length > 24 ? `${flat.slice(0, 24)}…` : flat;
};

const compactText = (value: unknown): string => {
  if (typeof value !== "string") {
    return "";
  }
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > COMPACT_TEXT_MAX ? `${flat.slice(0, COMPACT_TEXT_MAX)}…` : flat;
};

const elementBoundsWithLabel = (element: ExcalidrawElement, index: SceneIndex): Bounds => {
  const bounds = getElementBounds(element);
  const label = index.labelOf.get(element.id);
  if (!label) {
    return bounds;
  }
  const box = labelBox(element, label);
  return [
    Math.min(bounds[0], box.x),
    Math.min(bounds[1], box.y),
    Math.max(bounds[2], box.x + box.width),
    Math.max(bounds[3], box.y + box.height),
  ];
};

const buildLegend = (
  mode: LegendMode,
  ordered: ExcalidrawElement[],
  index: SceneIndex,
  ordinals: Map<string, number>,
  transformOf: (element: ExcalidrawElement) => Transform,
): RenderLegend => {
  switch (mode) {
    case "none":
      return { legendMode: "none" };
    case "ids":
      return { legendMode: "ids", legend: ordered.map((e) => e.id) };
    case "compact": {
      const drawn = new Set(ordered.map((e) => e.id));
      const lines: string[] = [];
      for (const element of ordered) {
        const container = containerOf(element, index);
        if (container && drawn.has(container.id)) {
          continue;
        }
        const [x1, y1, x2, y2] = getElementBounds(element);
        const label = index.labelOf.get(element.id);
        const text = isFrameLike(element)
          ? compactText(frameName(element))
          : compactText(label ? asText(label).text : asText(element).text);
        const parts = [
          element.id,
          element.type,
          Math.round(x1),
          Math.round(y1),
          Math.round(x2 - x1),
          Math.round(y2 - y1),
        ].join(" ");
        lines.push(text ? `${parts} ${text}` : parts);
      }
      return { legendMode: "compact", legend: lines };
    }
    case "frames":
      return {
        legendMode: "frames",
        legend: ordered.filter(isFrameLike).map((frame) => ({
          id: frame.id,
          name: frameName(frame),
          x: Math.round(frame.x),
          y: Math.round(frame.y),
          width: Math.round(frame.width || 0),
          height: Math.round(frame.height || 0),
        })),
      };
    case "full":
    default:
      return {
        legendMode: "full",
        legend: ordered.map((element) => {
          const transform = transformOf(element);
          const b = getElementBounds(element);
          const topLeft = sceneToPixel(transform, b[0], b[1]);
          const bottomRight = sceneToPixel(transform, b[2], b[3]);
          const ordinal = ordinals.get(element.id) ?? 0;
          const entry: LegendEntry = {
            label: String(ordinal),
            id: element.id,
            type: element.type,
            z: ordinal,
            index: typeof element.index === "string" ? element.index : null,
            bbox: [
              Math.round(topLeft[0]),
              Math.round(topLeft[1]),
              Math.round(bottomRight[0] - topLeft[0]),
              Math.round(bottomRight[1] - topLeft[1]),
            ],
            textPreview: textPreviewOf(element),
          };
          return entry;
        }),
      };
  }
};

// --- Single render ---

type SingleRender = {
  inner: string;
  transform: Transform;
  width: number;
  height: number;
  ordered: ExcalidrawElement[];
  fontFallback: string[];
  readability: RenderReadability;
};

type SingleParams = {
  index: SceneIndex;
  drawn: ExcalidrawElement[];
  bounds: Bounds;
  clipToBounds: boolean;
  scale: number;
  padding: number;
  options: RenderOptions;
  prefix: string;
  ordinals: Map<string, number> | null;
};

const intersects = (a: Bounds, b: Bounds): boolean =>
  a[2] >= b[0] && a[0] <= b[2] && a[3] >= b[1] && a[1] <= b[3];

const capScale = (width: number, height: number, scale: number): number =>
  width > 0 && height > 0 && width * height * scale * scale > MAX_RENDER_PIXELS
    ? Math.sqrt(MAX_RENDER_PIXELS / (width * height))
    : scale;

const roundScale = (scale: number): number => Math.round(scale * 1000) / 1000;

const readabilityOf = (scale: number, fontSizes: number[]): RenderReadability => ({
  fitScale: roundScale(scale),
  minEffectiveFontPx: fontSizes.length
    ? Math.round(Math.min(...fontSizes) * scale * 10) / 10
    : null,
});

const renderSingle = (params: SingleParams): SingleRender => {
  const { index, drawn, bounds, scale, padding, options } = params;
  const transform = computeTransform(bounds, padding, scale);
  const visible = params.clipToBounds
    ? drawn.filter((e) => intersects(elementBoundsWithLabel(e, index), bounds))
    : drawn;
  const ordered = sortByIndex(visible);
  const ordinals =
    params.ordinals ?? new Map(ordered.map((element, i) => [element.id, i + 1] as const));
  const ctx: DrawContext = {
    prefix: params.prefix,
    index,
    background: escapeXml(options.viewBackgroundColor ?? "#ffffff"),
    defs: [],
    patterns: new Map(),
    clips: new Map(),
    counter: 0,
    fontFallback: new Set(),
    fontSizes: [],
  };
  const orderedIds = new Set(ordered.map((e) => e.id));
  const bodyParts: string[] = [];
  for (const element of ordered) {
    const container = containerOf(element, index);
    if (container && orderedIds.has(container.id)) {
      continue; // drawn right after its container, like the client
    }
    const label = index.labelOf.get(element.id);
    bodyParts.push(
      element.type === "text" && container
        ? renderLabel(element, container, ctx)
        : renderElement(element, label && orderedIds.has(label.id) ? label : undefined, ctx),
    );
  }

  const sceneGroupTransform = `scale(${scale}) translate(${n2(transform.offsetX)} ${n2(transform.offsetY)})`;
  const grid = options.showGrid
    ? `<g transform="${sceneGroupTransform}">${gridLines(
        [bounds[0] - padding, bounds[1] - padding, bounds[2] + padding, bounds[3] + padding],
        options.gridSize ?? 20,
      )}</g>`
    : "";

  const overlay: string[] = [];
  const overlayFamily = escapeXml(svgFontFamily(FRAME_NAME_FONT_FAMILY));
  if (options.showFrameNames ?? true) {
    const nameLineHeight = FRAME_NAME_FONT_SIZE * FRAME_NAME_LINE_HEIGHT;
    const baseline = getVerticalOffset(FRAME_NAME_FONT_FAMILY, FRAME_NAME_FONT_SIZE, nameLineHeight);
    for (const frame of ordered.filter(isFrameLike)) {
      const [px, py] = sceneToPixel(transform, frame.x, frame.y);
      const maxWidth = (frame.width || 0) * scale;
      const name = truncateToWidth(frameName(frame), maxWidth);
      if (!name) {
        continue;
      }
      const top = py - FRAME_NAME_OFFSET_Y - nameLineHeight;
      overlay.push(
        `<text x="${n2(px)}" y="${n2(top + baseline)}" font-family="${overlayFamily}" font-size="${FRAME_NAME_FONT_SIZE}" fill="${FRAME_NAME_COLOR}" xml:space="preserve" style="white-space:pre">${escapeXml(name)}</text>`,
      );
    }
  }

  for (const id of options.highlight ?? []) {
    const element = index.byId.get(id);
    if (!element) {
      continue;
    }
    const b = elementBoundsWithLabel(element, index);
    if (!intersects(b, [bounds[0] - padding, bounds[1] - padding, bounds[2] + padding, bounds[3] + padding])) {
      continue;
    }
    const [x1, y1] = sceneToPixel(transform, b[0], b[1]);
    const [x2, y2] = sceneToPixel(transform, b[2], b[3]);
    const inset = HIGHLIGHT_GAP + HIGHLIGHT_WIDTH / 2;
    overlay.push(
      `<rect x="${n2(x1 - inset)}" y="${n2(y1 - inset)}" width="${n2(x2 - x1 + inset * 2)}" height="${n2(y2 - y1 + inset * 2)}" fill="none" stroke="${HIGHLIGHT_COLOR}" stroke-width="${HIGHLIGHT_WIDTH}" stroke-dasharray="8 4" />`,
    );
  }

  if (options.showLabels ?? true) {
    for (const element of ordered) {
      const b = getElementBounds(element);
      const topLeft = sceneToPixel(transform, b[0], b[1]);
      const label = String(ordinals.get(element.id) ?? 0);
      const badgeW = 8 + label.length * 7;
      const bx = Math.max(0, topLeft[0]);
      const by = Math.max(0, topLeft[1]);
      overlay.push(
        `<g><rect x="${n2(bx)}" y="${n2(by)}" width="${badgeW}" height="14" rx="3" fill="#e03131" /><text x="${n2(bx + badgeW / 2)}" y="${n2(by + 11)}" font-family="monospace" font-size="10" fill="#ffffff" text-anchor="middle">${label}</text></g>`,
      );
    }
  }

  const inner = [
    ctx.defs.length ? `<defs>${ctx.defs.join("")}</defs>` : "",
    `<rect x="0" y="0" width="${n2(transform.pixelWidth)}" height="${n2(transform.pixelHeight)}" fill="${ctx.background}" />`,
    grid,
    `<g transform="${sceneGroupTransform}">${bodyParts.join("")}</g>`,
    overlay.join(""),
  ].join("");

  return {
    inner,
    transform,
    width: transform.pixelWidth,
    height: transform.pixelHeight,
    ordered,
    fontFallback: [...ctx.fontFallback],
    readability: readabilityOf(scale, ctx.fontSizes),
  };
};

const truncateToWidth = (text: string, maxWidth: number): string => {
  const width = (value: string) => getLineWidth(value, FRAME_NAME_FONT_SIZE, FRAME_NAME_FONT_FAMILY);
  if (width(text) <= maxWidth) {
    return text;
  }
  for (let i = text.length - 1; i > 0; i--) {
    const candidate = `${text.slice(0, i)}...`;
    if (width(candidate) <= maxWidth) {
      return candidate;
    }
  }
  return "";
};

const wrapSvg = (inner: string, width: number, height: number, attrs = ""): string =>
  `<svg xmlns="http://www.w3.org/2000/svg"${attrs} width="${n2(width)}" height="${n2(height)}" viewBox="0 0 ${n2(width)} ${n2(height)}">${inner}</svg>`;

const fidelityOf = (fontFallback: Iterable<string>): RenderFidelity => {
  const ids = [...new Set(fontFallback)];
  return ids.length ? { ok: false, fontFallback: ids, arrowLabelMasking: true } : { ok: true };
};

// --- Selection ---

const selectDrawn = (index: SceneIndex, ids?: string[]): ExcalidrawElement[] => {
  if (!ids) {
    return index.live;
  }
  const wanted = new Set(ids.filter((id) => index.byId.has(id)));
  // A container comes with its label; a frame with its children.
  const frames = new Set([...wanted].filter((id) => isFrameLike(index.byId.get(id)!)));
  for (const element of index.live) {
    if (typeof element.frameId === "string" && frames.has(element.frameId)) {
      wanted.add(element.id);
    }
  }
  for (const id of [...wanted]) {
    const label = index.labelOf.get(id);
    if (label) {
      wanted.add(label.id);
    }
  }
  return index.live.filter((e) => wanted.has(e.id));
};

const boundsOf = (elements: ExcalidrawElement[], index: SceneIndex): Bounds => {
  if (!elements.length) {
    return [0, 0, 0, 0];
  }
  const all = elements.map((e) => elementBoundsWithLabel(e, index));
  return [
    Math.min(...all.map((b) => b[0])),
    Math.min(...all.map((b) => b[1])),
    Math.max(...all.map((b) => b[2])),
    Math.max(...all.map((b) => b[3])),
  ];
};

const autoScale = (
  bounds: Bounds,
  padding: number,
  options: RenderOptions,
): number => {
  const width = bounds[2] - bounds[0] + padding * 2;
  const height = bounds[3] - bounds[1] + padding * 2;
  const maxPixelWidth = options.maxPixelWidth ?? DEFAULT_MAX_PIXEL_WIDTH;
  const requested =
    options.scale !== undefined
      ? clamp(options.scale, MIN_RENDER_SCALE, MAX_RENDER_SCALE)
      : clamp(width > 0 ? Math.min(MAX_AUTO_SCALE, maxPixelWidth / width) : 1, MIN_RENDER_SCALE, MAX_AUTO_SCALE);
  return capScale(width, height, requested);
};

// Frame names sit above the frame; make room for them in whole-scene renders.
const withFrameNameRoom = (
  bounds: Bounds,
  drawn: ExcalidrawElement[],
  scale: number,
  options: RenderOptions,
): Bounds => {
  if (options.region || !(options.showFrameNames ?? true)) {
    return bounds;
  }
  const room = ((FRAME_NAME_FONT_SIZE * FRAME_NAME_LINE_HEIGHT + FRAME_NAME_OFFSET_Y) * 1.1) / scale;
  let minY = bounds[1];
  for (const frame of drawn.filter(isFrameLike)) {
    minY = Math.min(minY, frame.y - room);
  }
  return [bounds[0], minY, bounds[2], bounds[3]];
};

// --- Tiles and sheets ---

const renderTiles = (
  index: SceneIndex,
  drawn: ExcalidrawElement[],
  bounds: Bounds,
  padding: number,
  overview: SingleRender,
  options: RenderOptions,
): RenderTile[] => {
  const toTile = (render: SingleRender, region: Bounds): RenderTile => ({
    region,
    svg: wrapSvg(render.inner, render.width, render.height),
    transform: render.transform,
    width: render.width,
    height: render.height,
    readability: render.readability,
  });
  const fontSizes = overview.ordered
    .filter((e) => e.type === "text")
    .map((e) => asText(e).fontSize ?? DEFAULT_FONT_SIZE);
  const minFont = fontSizes.length ? Math.min(...fontSizes) : null;
  const maxPixelWidth = options.maxPixelWidth ?? DEFAULT_MAX_PIXEL_WIDTH;
  const readableScale =
    options.scale !== undefined
      ? clamp(options.scale, MIN_RENDER_SCALE, MAX_RENDER_SCALE)
      : minFont
        ? clamp(MIN_READABLE_FONT_PX / minFont, MIN_RENDER_SCALE, MAX_RENDER_SCALE)
        : overview.transform.scale;
  if (readableScale <= overview.transform.scale + 1e-9 && overview.width <= maxPixelWidth + 0.5) {
    return [toTile(overview, bounds)];
  }
  const width = Math.max(1, bounds[2] - bounds[0]);
  const height = Math.max(1, bounds[3] - bounds[1]);
  let scale = readableScale;
  const tileBudget = (s: number) => Math.max(1, maxPixelWidth / s - padding * 2);
  let cols = Math.ceil(width / tileBudget(scale));
  let rows = Math.ceil(height / tileBudget(scale));
  if (cols * rows > MAX_TILES) {
    // Too many tiles: give up some readability rather than flood the caller.
    const factor = Math.sqrt((cols * rows) / MAX_TILES);
    scale = Math.max(overview.transform.scale, scale / factor);
    cols = Math.min(cols, Math.ceil(width / tileBudget(scale)));
    rows = Math.min(rows, Math.ceil(height / tileBudget(scale)));
    while (cols * rows > MAX_TILES) {
      if (cols >= rows) cols -= 1;
      else rows -= 1;
    }
    scale = Math.min(scale, maxPixelWidth / (width / cols + padding * 2), maxPixelWidth / (height / rows + padding * 2));
  }
  const tileW = width / cols;
  const tileH = height / rows;
  // A little overlap so text on a seam is whole in at least one tile.
  const overlap = Math.min(tileW, tileH) * 0.04;
  const tiles: RenderTile[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const region: Bounds = [
        Math.max(bounds[0], bounds[0] + c * tileW - overlap),
        Math.max(bounds[1], bounds[1] + r * tileH - overlap),
        Math.min(bounds[2], bounds[0] + (c + 1) * tileW + overlap),
        Math.min(bounds[3], bounds[1] + (r + 1) * tileH + overlap),
      ];
      const tileScale = capScale(region[2] - region[0] + padding * 2, region[3] - region[1] + padding * 2, scale);
      const render = renderSingle({
        index,
        drawn,
        bounds: region,
        clipToBounds: true,
        scale: tileScale,
        padding,
        options,
        prefix: `t${r}_${c}_`,
        ordinals: new Map(overview.ordered.map((e, i) => [e.id, i + 1] as const)),
      });
      tiles.push(toTile(render, region));
    }
  }
  return tiles;
};

const renderSheet = (
  index: SceneIndex,
  ids: string[],
  options: RenderOptions,
): RenderResult => {
  const padding = options.padding ?? DEFAULT_EXPORT_PADDING;
  const maxPixelWidth = options.maxPixelWidth ?? DEFAULT_MAX_PIXEL_WIDTH;
  const unique = [...new Set(ids)].filter((id) => index.byId.has(id));
  const cols = Math.max(1, Math.ceil(Math.sqrt(unique.length)));
  const cellBudget = Math.max(64, Math.floor((maxPixelWidth - SHEET_GUTTER * (cols + 1)) / cols));
  const cells = unique.map((id, i) => {
    const drawn = selectDrawn(index, [id]);
    const region = boundsOf(drawn, index);
    const w = region[2] - region[0] + padding * 2;
    const h = region[3] - region[1] + padding * 2;
    const scale = capScale(
      w,
      h,
      options.scale !== undefined
        ? clamp(options.scale, MIN_RENDER_SCALE, MAX_RENDER_SCALE)
        : clamp(Math.min(MAX_AUTO_SCALE, cellBudget / Math.max(1, w)), MIN_RENDER_SCALE, MAX_AUTO_SCALE),
    );
    // The crop shows the board around the element, not the element alone.
    const render = renderSingle({
      index,
      drawn: index.live,
      bounds: region,
      clipToBounds: true,
      scale,
      padding,
      options: { ...options, showLabels: false },
      prefix: `s${i}_`,
      ordinals: null,
    });
    return { id, region, render };
  });

  const rows = Math.ceil(cells.length / cols);
  const colWidths = Array.from({ length: cols }, (_, c) =>
    Math.max(0, ...cells.filter((_, i) => i % cols === c).map((cell) => cell.render.width)),
  );
  const rowHeights = Array.from({ length: rows }, (_, r) =>
    Math.max(0, ...cells.slice(r * cols, (r + 1) * cols).map((cell) => cell.render.height)),
  );
  const colX = colWidths.map((_, c) => SHEET_GUTTER + colWidths.slice(0, c).reduce((a, b) => a + b + SHEET_GUTTER, 0));
  const rowY = rowHeights.map(
    (_, r) => SHEET_GUTTER + rowHeights.slice(0, r).reduce((a, b) => a + b + SHEET_LABEL_HEIGHT + SHEET_GUTTER, 0),
  );
  const width = Math.max(1, SHEET_GUTTER + colWidths.reduce((a, b) => a + b + SHEET_GUTTER, 0));
  const height = Math.max(1, SHEET_GUTTER + rowHeights.reduce((a, b) => a + b + SHEET_LABEL_HEIGHT + SHEET_GUTTER, 0));
  const labelFamily = escapeXml(svgFontFamily(3));
  const parts: string[] = [`<rect x="0" y="0" width="${n2(width)}" height="${n2(height)}" fill="#f8f9fa" />`];
  const sheet: SheetCell[] = [];
  const fontFallback: string[] = [];
  const readabilities: RenderReadability[] = [];
  const transforms = new Map<string, Transform>();
  cells.forEach((cell, i) => {
    const x = colX[i % cols];
    const labelY = rowY[Math.floor(i / cols)];
    const y = labelY + SHEET_LABEL_HEIGHT;
    const { render } = cell;
    parts.push(
      `<text x="${n2(x)}" y="${n2(labelY + SHEET_LABEL_HEIGHT - 6)}" font-family="${labelFamily}" font-size="${SHEET_LABEL_FONT_SIZE}" fill="#1e1e1e" xml:space="preserve" style="white-space:pre">${escapeXml(cell.id)}</text>`,
      `<svg x="${n2(x)}" y="${n2(y)}" width="${n2(render.width)}" height="${n2(render.height)}" viewBox="0 0 ${n2(render.width)} ${n2(render.height)}">${render.inner}</svg>`,
      `<rect x="${n2(x - 0.5)}" y="${n2(y - 0.5)}" width="${n2(render.width + 1)}" height="${n2(render.height + 1)}" fill="none" stroke="#ced4da" stroke-width="1" />`,
    );
    const transform: Transform = {
      ...render.transform,
      offsetX: render.transform.offsetX + x / render.transform.scale,
      offsetY: render.transform.offsetY + y / render.transform.scale,
    };
    sheet.push({ id: cell.id, region: cell.region, x, y, width: render.width, height: render.height, transform });
    fontFallback.push(...render.fontFallback);
    readabilities.push(render.readability);
    for (const element of render.ordered) {
      if (!transforms.has(element.id)) {
        transforms.set(element.id, transform);
      }
    }
  });

  const ordered = sortByIndex(index.live.filter((e) => transforms.has(e.id)));
  const ordinals = new Map(ordered.map((e, i) => [e.id, i + 1] as const));
  const identity: Transform = {
    minX: 0,
    minY: 0,
    width,
    height,
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    pixelWidth: width,
    pixelHeight: height,
  };
  const minFont = readabilities
    .map((r) => r.minEffectiveFontPx)
    .filter((v): v is number => v !== null);
  return {
    svg: wrapSvg(parts.join(""), width, height),
    transform: identity,
    width,
    height,
    legendOrder: "z-ascending",
    fidelity: fidelityOf(fontFallback),
    readability: {
      fitScale: readabilities.length ? Math.min(...readabilities.map((r) => r.fitScale)) : 1,
      minEffectiveFontPx: minFont.length ? Math.min(...minFont) : null,
    },
    layout: "sheet",
    sheet,
    ...buildLegend(options.legend ?? "full", ordered, index, ordinals, (e) => transforms.get(e.id) ?? identity),
  };
};

// --- Entry point ---

const renderScene = (
  allElements: readonly ExcalidrawElement[],
  options: RenderOptions,
): RenderResult => {
  const index = indexScene(allElements);
  if (options.layout === "sheet" && options.ids && options.ids.length > 1) {
    return renderSheet(index, options.ids, options);
  }
  const padding = options.padding ?? DEFAULT_EXPORT_PADDING;
  const drawn = selectDrawn(index, options.ids);
  let bounds: Bounds = options.region ?? boundsOf(drawn, index);
  let scale = autoScale(bounds, padding, options);
  if (!options.region) {
    const roomy = withFrameNameRoom(bounds, drawn, scale, options);
    if (roomy[1] !== bounds[1]) {
      bounds = roomy;
      scale = autoScale(bounds, padding, options);
    }
  }
  const single = renderSingle({
    index,
    drawn,
    bounds,
    clipToBounds: !!options.region,
    scale,
    padding,
    options,
    prefix: "r",
    ordinals: null,
  });
  const layout: RenderLayout = options.layout === "tiles" ? "tiles" : "single";
  const tiles =
    layout === "tiles" ? renderTiles(index, drawn, bounds, padding, single, options) : undefined;
  const ordinals = new Map(single.ordered.map((e, i) => [e.id, i + 1] as const));
  return {
    svg: wrapSvg(single.inner, single.width, single.height),
    transform: single.transform,
    width: single.width,
    height: single.height,
    legendOrder: "z-ascending",
    fidelity: fidelityOf(single.fontFallback),
    readability: single.readability,
    layout,
    ...(tiles ? { tiles } : {}),
    ...buildLegend(options.legend ?? "full", single.ordered, index, ordinals, () => single.transform),
  };
};

/**
 * Render elements to SVG. Without `legend` the legend is the full entry list
 * (backward compatible); pass a mode to get that legend format.
 */
export function renderSvg(
  allElements: readonly ExcalidrawElement[],
  options?: RenderOptions & { legend?: "full" },
): RenderResultFor<"full">;
export function renderSvg<M extends LegendMode>(
  allElements: readonly ExcalidrawElement[],
  options: RenderOptions & { legend: M },
): RenderResultFor<M>;
export function renderSvg(
  allElements: readonly ExcalidrawElement[],
  options?: RenderOptions,
): RenderResult;
export function renderSvg(
  allElements: readonly ExcalidrawElement[],
  options: RenderOptions = {},
): RenderResult {
  return renderScene(allElements, options);
}

// --- Rasterizer ---

type ResvgModule = {
  Resvg: new (svg: string, opts?: unknown) => { render: () => { asPng: () => Buffer } };
};

let resvgModule: ResvgModule | null = null;
let resvgChecked = false;

const loadResvg = (): ResvgModule | null => {
  if (resvgChecked) {
    return resvgModule;
  }
  resvgChecked = true;
  try {
    resvgModule = require("@resvg/resvg-js") as ResvgModule;
  } catch {
    resvgModule = null;
  }
  return resvgModule;
};

export const isPngAvailable = (): boolean => loadResvg() !== null;

/**
 * resvg options: the vendored client fonts, with system fonts kept as the last
 * fallback for glyphs none of them has (emoji, CJK).
 */
export const resvgRenderOptions = () => {
  const generic = genericFontFamilies();
  return {
    font: {
      loadSystemFonts: true,
      fontFiles: getVendoredFontFiles(),
      defaultFontFamily: generic.sansSerif,
      sansSerifFamily: generic.sansSerif,
      monospaceFamily: generic.monospace,
    },
  };
};

export const svgToPngBase64 = (svg: string): string | null => {
  const mod = loadResvg();
  if (!mod) {
    return null;
  }
  try {
    const resvg = new mod.Resvg(svg, resvgRenderOptions());
    return resvg.render().asPng().toString("base64");
  } catch {
    return null;
  }
};

export const elementAtPoint = (
  elements: readonly ExcalidrawElement[],
  x: number,
  y: number,
): ExcalidrawElement | null => {
  const live = sortByIndex(elements.filter((e) => !e.isDeleted)).reverse();
  for (const element of live) {
    if (pointInElement(element, x, y)) {
      return element;
    }
  }
  return null;
};
