import type {ExcalidrawElement} from "../types";
import {asLinear, type Bounds, type Point} from "./model";

export const rotatePoint = (
  point: Point,
  center: Point,
  angle: number,
): Point => {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = point[0] - center[0];
  const dy = point[1] - center[1];
  return [center[0] + dx * cos - dy * sin, center[1] + dx * sin + dy * cos];
};

const boundsOfPoints = (points: Point[]): Bounds => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return [minX, minY, maxX, maxY];
};

export const globalLinearPoints = (element: ExcalidrawElement): Point[] => {
  const points = asLinear(element).points;
  if (!Array.isArray(points) || points.length === 0) {
    return [
      [element.x, element.y],
      [element.x + (element.width || 0), element.y + (element.height || 0)],
    ];
  }
  return points.map(([px, py]) => [element.x + px, element.y + py]);
};

export const getElementBounds = (element: ExcalidrawElement): Bounds => {
  const angle = element.angle || 0;
  const { x, y, width = 0, height = 0, type } = element;

  if (type === "line" || type === "arrow" || type === "freedraw") {
    const pts = globalLinearPoints(element);
    const [bx1, by1, bx2, by2] = boundsOfPoints(pts);
    const center: Point = [(bx1 + bx2) / 2, (by1 + by2) / 2];
    if (!angle) {
      return [bx1, by1, bx2, by2];
    }
    return boundsOfPoints(pts.map((p) => rotatePoint(p, center, angle)));
  }

  const cx = x + width / 2;
  const cy = y + height / 2;
  const center: Point = [cx, cy];

  if (type === "ellipse") {
    const w2 = width / 2;
    const h2 = height / 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const ww = Math.hypot(w2 * cos, h2 * sin);
    const hh = Math.hypot(h2 * cos, w2 * sin);
    return [cx - ww, cy - hh, cx + ww, cy + hh];
  }

  const corners: Point[] =
    type === "diamond"
      ? [
          [cx, y],
          [cx, y + height],
          [x, cy],
          [x + width, cy],
        ]
      : [
          [x, y],
          [x + width, y],
          [x + width, y + height],
          [x, y + height],
        ];

  if (!angle) {
    return boundsOfPoints(corners);
  }
  return boundsOfPoints(corners.map((p) => rotatePoint(p, center, angle)));
};

export const getCommonBounds = (
  elements: readonly ExcalidrawElement[],
): Bounds => {
  if (elements.length === 0) {
    return [0, 0, 0, 0];
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const element of elements) {
    const [x1, y1, x2, y2] = getElementBounds(element);
    minX = Math.min(minX, x1);
    minY = Math.min(minY, y1);
    maxX = Math.max(maxX, x2);
    maxY = Math.max(maxY, y2);
  }
  return [minX, minY, maxX, maxY];
};

export const boundsCenter = (b: Bounds): Point => [
  (b[0] + b[2]) / 2,
  (b[1] + b[3]) / 2,
];

export const boundsArea = (b: Bounds): number =>
  Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);

export const intersectionArea = (a: Bounds, b: Bounds): number => {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) {
    return 0;
  }
  return w * h;
};

export const boundsContain = (outer: Bounds, inner: Bounds): boolean =>
  outer[0] <= inner[0] &&
  outer[1] <= inner[1] &&
  outer[2] >= inner[2] &&
  outer[3] >= inner[3];

const unrotateToLocal = (
  element: ExcalidrawElement,
  x: number,
  y: number,
): Point => {
  const cx = element.x + (element.width || 0) / 2;
  const cy = element.y + (element.height || 0) / 2;
  return rotatePoint([x, y], [cx, cy], -(element.angle || 0));
};

const distanceToSegment = (
  p: Point,
  a: Point,
  b: Point,
): number => {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    return Math.hypot(p[0] - a[0], p[1] - a[1]);
  }
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
};

export const pointInElement = (
  element: ExcalidrawElement,
  x: number,
  y: number,
): boolean => {
  const { type, width = 0, height = 0 } = element;

  if (type === "line" || type === "arrow" || type === "freedraw") {
    const center: Point = [
      element.x + width / 2,
      element.y + height / 2,
    ];
    const local = rotatePoint([x, y], center, -(element.angle || 0));
    const pts = globalLinearPoints(element);
    const localPts = pts.map((p) => rotatePoint(p, center, -(element.angle || 0)));
    for (let i = 0; i < localPts.length - 1; i++) {
      if (distanceToSegment(local, localPts[i], localPts[i + 1]) <= 5) {
        return true;
      }
    }
    return false;
  }

  const [lx, ly] = unrotateToLocal(element, x, y);
  const left = element.x;
  const top = element.y;
  const right = element.x + width;
  const bottom = element.y + height;

  if (type === "ellipse") {
    const rx = width / 2;
    const ry = height / 2;
    if (rx <= 0 || ry <= 0) {
      return false;
    }
    const nx = (lx - (left + rx)) / rx;
    const ny = (ly - (top + ry)) / ry;
    return nx * nx + ny * ny <= 1;
  }

  if (type === "diamond") {
    const cx = left + width / 2;
    const cy = top + height / 2;
    if (width <= 0 || height <= 0) {
      return false;
    }
    return (
      Math.abs(lx - cx) / (width / 2) + Math.abs(ly - cy) / (height / 2) <= 1
    );
  }

  return lx >= left && lx <= right && ly >= top && ly <= bottom;
};

export const distanceToElement = (
  element: ExcalidrawElement,
  x: number,
  y: number,
): number => {
  if (pointInElement(element, x, y)) {
    return 0;
  }
  if (
    element.type === "line" ||
    element.type === "arrow" ||
    element.type === "freedraw"
  ) {
    const center: Point = [
      element.x + (element.width || 0) / 2,
      element.y + (element.height || 0) / 2,
    ];
    const angle = element.angle || 0;
    const local = rotatePoint([x, y], center, -angle);
    const localPts = globalLinearPoints(element).map((p) =>
      rotatePoint(p, center, -angle),
    );
    let min = Infinity;
    for (let i = 0; i < localPts.length - 1; i++) {
      min = Math.min(min, distanceToSegment(local, localPts[i], localPts[i + 1]));
    }
    return Number.isFinite(min) ? min : Infinity;
  }
  const [lx, ly] = unrotateToLocal(element, x, y);
  const left = element.x;
  const top = element.y;
  const right = element.x + (element.width || 0);
  const bottom = element.y + (element.height || 0);
  const dx = Math.max(left - lx, 0, lx - right);
  const dy = Math.max(top - ly, 0, ly - bottom);
  return Math.hypot(dx, dy);
};

export type Transform = {
  minX: number;
  minY: number;
  width: number;
  height: number;
  scale: number;
  offsetX: number;
  offsetY: number;
  pixelWidth: number;
  pixelHeight: number;
};

export const computeTransform = (
  bounds: Bounds,
  padding: number,
  scale: number,
): Transform => {
  const [minX, minY, maxX, maxY] = bounds;
  const width = maxX - minX + padding * 2;
  const height = maxY - minY + padding * 2;
  return {
    minX,
    minY,
    width,
    height,
    scale,
    offsetX: -minX + padding,
    offsetY: -minY + padding,
    pixelWidth: width * scale,
    pixelHeight: height * scale,
  };
};

export const sceneToPixel = (t: Transform, x: number, y: number): Point => [
  (x + t.offsetX) * t.scale,
  (y + t.offsetY) * t.scale,
];

export const pixelToScene = (t: Transform, px: number, py: number): Point => [
  px / t.scale - t.offsetX,
  py / t.scale - t.offsetY,
];

export type ArrangeOptions =
  | {
      mode: "grid";
      columns?: number;
      gapX?: number;
      gapY?: number;
      originX?: number;
      originY?: number;
    }
  | {
      mode: "row";
      gap?: number;
      align?: "top" | "center" | "bottom";
      originX?: number;
      originY?: number;
    }
  | {
      mode: "column";
      gap?: number;
      align?: "left" | "center" | "right";
      originX?: number;
      originY?: number;
    }
  | {
      mode: "align";
      edge: "left" | "right" | "top" | "bottom" | "centerX" | "centerY";
    }
  | { mode: "distribute"; axis: "horizontal" | "vertical" };

export const arrangePositions = (
  elements: readonly ExcalidrawElement[],
  options: ArrangeOptions,
): Map<string, Point> => {
  const result = new Map<string, Point>();
  if (elements.length === 0) {
    return result;
  }
  const common = getCommonBounds(elements);

  if (options.mode === "grid") {
    const columns = Math.max(1, options.columns ?? Math.ceil(Math.sqrt(elements.length)));
    const gapX = options.gapX ?? 40;
    const gapY = options.gapY ?? 40;
    const cellW = Math.max(...elements.map((e) => e.width || 0)) + gapX;
    const cellH = Math.max(...elements.map((e) => e.height || 0)) + gapY;
    const originX = options.originX ?? common[0];
    const originY = options.originY ?? common[1];
    elements.forEach((element, i) => {
      const col = i % columns;
      const row = Math.floor(i / columns);
      result.set(element.id, [originX + col * cellW, originY + row * cellH]);
    });
    return result;
  }

  if (options.mode === "row") {
    const gap = options.gap ?? 40;
    const rowHeight = Math.max(...elements.map((e) => e.height || 0));
    const originX = options.originX ?? common[0];
    const originY = options.originY ?? common[1];
    let cursor = originX;
    for (const element of elements) {
      const h = element.height || 0;
      const align = options.align ?? "top";
      const y =
        align === "center"
          ? originY + (rowHeight - h) / 2
          : align === "bottom"
            ? originY + (rowHeight - h)
            : originY;
      result.set(element.id, [cursor, y]);
      cursor += (element.width || 0) + gap;
    }
    return result;
  }

  if (options.mode === "column") {
    const gap = options.gap ?? 40;
    const colWidth = Math.max(...elements.map((e) => e.width || 0));
    const originX = options.originX ?? common[0];
    const originY = options.originY ?? common[1];
    let cursor = originY;
    for (const element of elements) {
      const w = element.width || 0;
      const align = options.align ?? "left";
      const x =
        align === "center"
          ? originX + (colWidth - w) / 2
          : align === "right"
            ? originX + (colWidth - w)
            : originX;
      result.set(element.id, [x, cursor]);
      cursor += (element.height || 0) + gap;
    }
    return result;
  }

  if (options.mode === "align") {
    const [minX, minY, maxX, maxY] = common;
    for (const element of elements) {
      const w = element.width || 0;
      const h = element.height || 0;
      let x = element.x;
      let y = element.y;
      switch (options.edge) {
        case "left":
          x = minX;
          break;
        case "right":
          x = maxX - w;
          break;
        case "top":
          y = minY;
          break;
        case "bottom":
          y = maxY - h;
          break;
        case "centerX":
          x = (minX + maxX) / 2 - w / 2;
          break;
        case "centerY":
          y = (minY + maxY) / 2 - h / 2;
          break;
      }
      result.set(element.id, [x, y]);
    }
    return result;
  }

  const horizontal = options.axis === "horizontal";
  const sorted = [...elements].sort((a, b) =>
    horizontal ? a.x - b.x : a.y - b.y,
  );
  if (sorted.length < 3) {
    for (const element of sorted) {
      result.set(element.id, [element.x, element.y]);
    }
    return result;
  }
  const sizeOf = (e: ExcalidrawElement) => (horizontal ? e.width || 0 : e.height || 0);
  const startEdge = horizontal ? sorted[0].x : sorted[0].y;
  const last = sorted[sorted.length - 1];
  const endEdge = (horizontal ? last.x + (last.width || 0) : last.y + (last.height || 0));
  const totalSize = sorted.reduce((acc, e) => acc + sizeOf(e), 0);
  const gap = (endEdge - startEdge - totalSize) / (sorted.length - 1);
  let cursor = startEdge;
  for (const element of sorted) {
    result.set(
      element.id,
      horizontal ? [cursor, element.y] : [element.x, cursor],
    );
    cursor += sizeOf(element) + gap;
  }
  return result;
};
