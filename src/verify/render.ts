import type {ExcalidrawElement} from "../types";
import {
    asLinear,
    asText,
    type Bounds,
    cssFamilyFor,
    DEFAULT_EXPORT_PADDING,
    isTransparent,
    lineHeightForFamily,
    type Point,
} from "./model";
import {
    computeTransform,
    getCommonBounds,
    getElementBounds,
    globalLinearPoints,
    pointInElement,
    sceneToPixel,
    type Transform,
} from "./geometry";

const MAX_RENDER_SCALE = 4;
const MIN_RENDER_SCALE = 0.1;
const MAX_RENDER_PIXELS = 4_000_000;

const escapeXml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const fillFor = (element: ExcalidrawElement): string =>
  isTransparent(element.backgroundColor)
    ? "none"
    : escapeXml(element.backgroundColor);

const strokeFor = (element: ExcalidrawElement): string =>
  isTransparent(element.strokeColor) ? "none" : escapeXml(element.strokeColor);

const dashFor = (element: ExcalidrawElement): string => {
  const w = element.strokeWidth || 1;
  if (element.strokeStyle === "dashed") {
    return ` stroke-dasharray="${w * 4} ${w * 2}"`;
  }
  if (element.strokeStyle === "dotted") {
    return ` stroke-dasharray="${w} ${w * 2}"`;
  }
  return "";
};

const opacityAttr = (element: ExcalidrawElement): string => {
  const o = (element.opacity ?? 100) / 100;
  return o >= 1 ? "" : ` opacity="${o.toFixed(2)}"`;
};

const arrowHeadPath = (points: Point[], size: number): string => {
  if (points.length < 2) {
    return "";
  }
  const tip = points[points.length - 1];
  const prev = points[points.length - 2];
  const angle = Math.atan2(tip[1] - prev[1], tip[0] - prev[0]);
  const spread = Math.PI / 7;
  const a: Point = [
    tip[0] - size * Math.cos(angle - spread),
    tip[1] - size * Math.sin(angle - spread),
  ];
  const b: Point = [
    tip[0] - size * Math.cos(angle + spread),
    tip[1] - size * Math.sin(angle + spread),
  ];
  return `${a[0].toFixed(2)},${a[1].toFixed(2)} ${tip[0].toFixed(2)},${tip[1].toFixed(2)} ${b[0].toFixed(2)},${b[1].toFixed(2)}`;
};

const renderElementBody = (element: ExcalidrawElement): string => {
  const stroke = strokeFor(element);
  const strokeWidth = element.strokeWidth || 1;
  const common = `stroke="${stroke}" stroke-width="${strokeWidth}"${dashFor(element)}`;

  switch (element.type) {
    case "rectangle":
    case "image":
    case "embeddable":
    case "iframe":
    case "frame":
    case "magicframe": {
      const rx =
        element.roundness && (element.width || 0) > 0
          ? Math.min(32, (element.width || 0) * 0.1)
          : 0;
      const fill = element.type === "rectangle" ? fillFor(element) : "#f1f3f5";
      const placeholderStroke = element.type === "rectangle" ? stroke : "#adb5bd";
      return `<rect x="${element.x}" y="${element.y}" width="${element.width || 0}" height="${element.height || 0}" rx="${rx}" fill="${fill}" stroke="${placeholderStroke}" stroke-width="${strokeWidth}"${dashFor(element)} />`;
    }
    case "ellipse": {
      const rx = (element.width || 0) / 2;
      const ry = (element.height || 0) / 2;
      return `<ellipse cx="${element.x + rx}" cy="${element.y + ry}" rx="${rx}" ry="${ry}" fill="${fillFor(element)}" ${common} />`;
    }
    case "diamond": {
      const w = element.width || 0;
      const h = element.height || 0;
      const cx = element.x + w / 2;
      const cy = element.y + h / 2;
      const pts = `${cx},${element.y} ${element.x + w},${cy} ${cx},${element.y + h} ${element.x},${cy}`;
      return `<polygon points="${pts}" fill="${fillFor(element)}" ${common} />`;
    }
    case "line":
    case "arrow": {
      const pts = globalLinearPoints(element);
      const polyline = pts.map((p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(" ");
      const linear = asLinear(element);
      const headSize = Math.max(10, strokeWidth * 4);
      let heads = "";
      if (element.type === "arrow" && linear.endArrowhead !== null) {
        heads += `<polyline points="${arrowHeadPath(pts, headSize)}" fill="none" ${common} />`;
      }
      if (linear.startArrowhead) {
        const reversed = [...pts].reverse();
        heads += `<polyline points="${arrowHeadPath(reversed, headSize)}" fill="none" ${common} />`;
      }
      return `<polyline points="${polyline}" fill="none" ${common} />${heads}`;
    }
    case "freedraw": {
      const pts = globalLinearPoints(element)
        .map((p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`)
        .join(" ");
      return `<polyline points="${pts}" fill="none" ${common} stroke-linecap="round" stroke-linejoin="round" />`;
    }
    case "text": {
      const text = asText(element);
      const fontSize = text.fontSize ?? 20;
      const fontFamily = cssFamilyFor(text.fontFamily);
      const lineHeight = lineHeightForFamily(text.fontFamily) * fontSize;
      const anchor =
        text.textAlign === "center" ? "middle" : text.textAlign === "right" ? "end" : "start";
      const anchorX =
        text.textAlign === "center"
          ? element.x + (element.width || 0) / 2
          : text.textAlign === "right"
            ? element.x + (element.width || 0)
            : element.x;
      const lines = String(text.text ?? "").split("\n");
      const spans = lines
        .map((line, i) => {
          const y = element.y + fontSize * 0.82 + i * lineHeight;
          return `<text x="${anchorX}" y="${y}" font-family="${escapeXml(fontFamily)}" font-size="${fontSize}" fill="${strokeFor(element)}" text-anchor="${anchor}">${escapeXml(line)}</text>`;
        })
        .join("");
      return spans;
    }
    default:
      return `<rect x="${element.x}" y="${element.y}" width="${element.width || 0}" height="${element.height || 0}" fill="none" stroke="#adb5bd" stroke-dasharray="4 4" />`;
  }
};

const renderElement = (element: ExcalidrawElement): string => {
  const body = renderElementBody(element);
  const angle = element.angle || 0;
  const wrapped = angle
    ? `<g transform="rotate(${((angle * 180) / Math.PI).toFixed(3)} ${(element.x + (element.width || 0) / 2).toFixed(2)} ${(element.y + (element.height || 0) / 2).toFixed(2)})">${body}</g>`
    : body;
  return `<g${opacityAttr(element)}>${wrapped}</g>`;
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

const gridLines = (bounds: Bounds, gridSize: number): string => {
  const [minX, minY, maxX, maxY] = bounds;
  const lines: string[] = [];
  const startX = Math.floor(minX / gridSize) * gridSize;
  const startY = Math.floor(minY / gridSize) * gridSize;
  for (let x = startX; x <= maxX; x += gridSize) {
    lines.push(`<line x1="${x}" y1="${minY}" x2="${x}" y2="${maxY}" stroke="#e9ecef" stroke-width="0.5" />`);
  }
  for (let y = startY; y <= maxY; y += gridSize) {
    lines.push(`<line x1="${minX}" y1="${y}" x2="${maxX}" y2="${y}" stroke="#e9ecef" stroke-width="0.5" />`);
  }
  return lines.join("");
};

export type LegendEntry = {
  label: string;
  id: string;
  type: string;
  bbox: [number, number, number, number];
  textPreview?: string;
};

export type RenderOptions = {
  padding?: number;
  scale?: number;
  showGrid?: boolean;
  gridSize?: number;
  showLabels?: boolean;
  viewBackgroundColor?: string;
  ids?: string[];
  region?: Bounds;
};

export type RenderResult = {
  svg: string;
  transform: Transform;
  legend: LegendEntry[];
  width: number;
  height: number;
};

const textPreviewOf = (element: ExcalidrawElement): string | undefined => {
  const t = asText(element).text;
  if (typeof t !== "string" || !t.trim()) {
    return undefined;
  }
  const flat = t.replace(/\s+/g, " ").trim();
  return flat.length > 24 ? `${flat.slice(0, 24)}…` : flat;
};

export const renderSvg = (
  allElements: readonly ExcalidrawElement[],
  options: RenderOptions = {},
): RenderResult => {
  const padding = options.padding ?? DEFAULT_EXPORT_PADDING;
  const showLabels = options.showLabels ?? true;
  const background = options.viewBackgroundColor ?? "#ffffff";

  const live = allElements.filter((e) => !e.isDeleted);
  const idSet = options.ids ? new Set(options.ids) : null;
  const drawn = idSet ? live.filter((e) => idSet.has(e.id)) : live;

  const bounds: Bounds = options.region
    ? options.region
    : drawn.length
      ? getCommonBounds(drawn)
      : [0, 0, 0, 0];

  const requestedScale = Math.min(
    MAX_RENDER_SCALE,
    Math.max(MIN_RENDER_SCALE, options.scale ?? 1),
  );
  const baseWidth = bounds[2] - bounds[0] + padding * 2;
  const baseHeight = bounds[3] - bounds[1] + padding * 2;
  const scale =
    baseWidth > 0 &&
    baseHeight > 0 &&
    baseWidth * baseHeight * requestedScale * requestedScale > MAX_RENDER_PIXELS
      ? Math.sqrt(MAX_RENDER_PIXELS / (baseWidth * baseHeight))
      : requestedScale;

  const transform = computeTransform(bounds, padding, scale);

  const visible = options.region
    ? drawn.filter((e) => {
        const b = getElementBounds(e);
        return (
          b[2] >= bounds[0] &&
          b[0] <= bounds[2] &&
          b[3] >= bounds[1] &&
          b[1] <= bounds[3]
        );
      })
    : drawn;

  const ordered = sortByIndex(visible);

  const sceneGroupTransform = `scale(${scale}) translate(${transform.offsetX} ${transform.offsetY})`;
  const body = ordered.map(renderElement).join("");
  const grid = options.showGrid
    ? `<g>${gridLines([bounds[0] - padding, bounds[1] - padding, bounds[2] + padding, bounds[3] + padding], options.gridSize ?? 20)}</g>`
    : "";

  const legend: LegendEntry[] = [];
  const labelNodes: string[] = [];
  ordered.forEach((element, i) => {
    const b = getElementBounds(element);
    const topLeft = sceneToPixel(transform, b[0], b[1]);
    const bottomRight = sceneToPixel(transform, b[2], b[3]);
    const label = String(i + 1);
    legend.push({
      label,
      id: element.id,
      type: element.type,
      bbox: [
        Math.round(topLeft[0]),
        Math.round(topLeft[1]),
        Math.round(bottomRight[0] - topLeft[0]),
        Math.round(bottomRight[1] - topLeft[1]),
      ],
      textPreview: textPreviewOf(element),
    });
    if (showLabels) {
      const badgeW = 8 + label.length * 7;
      const bx = Math.max(0, topLeft[0]);
      const by = Math.max(0, topLeft[1]);
      labelNodes.push(
        `<g><rect x="${bx}" y="${by}" width="${badgeW}" height="14" rx="3" fill="#e03131" /><text x="${bx + badgeW / 2}" y="${by + 11}" font-family="monospace" font-size="10" fill="#ffffff" text-anchor="middle">${label}</text></g>`,
      );
    }
  });

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${transform.pixelWidth}" height="${transform.pixelHeight}" viewBox="0 0 ${transform.pixelWidth} ${transform.pixelHeight}">`,
    `<rect x="0" y="0" width="${transform.pixelWidth}" height="${transform.pixelHeight}" fill="${background}" />`,
    grid ? `<g transform="${sceneGroupTransform}">${grid}</g>` : "",
    `<g transform="${sceneGroupTransform}">${body}</g>`,
    labelNodes.join(""),
    `</svg>`,
  ].join("");

  return {
    svg,
    transform,
    legend,
    width: transform.pixelWidth,
    height: transform.pixelHeight,
  };
};

let resvgModule: unknown = null;
let resvgChecked = false;

const loadResvg = (): { Resvg: new (svg: string, opts?: unknown) => { render: () => { asPng: () => Buffer } } } | null => {
  if (resvgChecked) {
    return resvgModule as never;
  }
  resvgChecked = true;
  try {
    resvgModule = require("@resvg/resvg-js");
  } catch {
    resvgModule = null;
  }
  return resvgModule as never;
};

export const isPngAvailable = (): boolean => loadResvg() !== null;

export const svgToPngBase64 = (svg: string): string | null => {
  const mod = loadResvg();
  if (!mod) {
    return null;
  }
  try {
    const resvg = new mod.Resvg(svg, {
      font: { loadSystemFonts: true, defaultFontFamily: "DejaVu Sans" },
    });
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
