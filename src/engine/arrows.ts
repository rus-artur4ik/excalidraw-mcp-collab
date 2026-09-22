import type {ExcalidrawElement} from "../types";
import {
  asLinear,
  type BindMode,
  CENTER_RATIO,
  type FixedPointBinding,
  type Point,
} from "../verify/model";
import {globalLinearPoints, rotatePoint, segmentElementRange} from "../verify/geometry";
import {bindingGap, computeFixedPoint, normalizeFixedPoint} from "../verify/bindings";

export type Side = "top" | "right" | "bottom" | "left" | "center";

export type Anchor = { side: Side; at?: number };

export type RouteKind = "direct" | "straight" | "orthogonal";

export type ArrowGeometry = {
  x: number;
  y: number;
  width: number;
  height: number;
  points: Point[];
};

const centerOf = (element: ExcalidrawElement): Point => [
  element.x + (element.width || 0) / 2,
  element.y + (element.height || 0) / 2,
];

export const geometryFromGlobalPath = (globalPath: Point[]): ArrowGeometry => {
  const [origin] = globalPath;
  const points: Point[] = globalPath.map(([x, y]) => [x - origin[0], y - origin[1]]);
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  return {
    x: origin[0],
    y: origin[1],
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
    points,
  };
};

export const globalFixedPoint = (
  fixedPoint: Point,
  element: ExcalidrawElement,
): Point => {
  const [fx, fy] = normalizeFixedPoint(fixedPoint);
  return rotatePoint(
    [element.x + (element.width || 0) * fx, element.y + (element.height || 0) * fy],
    centerOf(element),
    element.angle || 0,
  );
};

export const anchorFixedPoint = (anchor: Anchor): Point => {
  const at = typeof anchor.at === "number" ? Math.min(1, Math.max(0, anchor.at)) : 0.5;
  switch (anchor.side) {
    case "top":
      return [at, 0];
    case "bottom":
      return [at, 1];
    case "left":
      return [0, at];
    case "right":
      return [1, at];
    default:
      return [CENTER_RATIO, CENTER_RATIO];
  }
};

const SIDE_NORMALS: Record<Exclude<Side, "center">, Point> = {
  top: [0, -1],
  bottom: [0, 1],
  left: [-1, 0],
  right: [1, 0],
};

const sideNormal = (side: Side, element: ExcalidrawElement): Point | null => {
  if (side === "center") {
    return null;
  }
  return rotatePoint(SIDE_NORMALS[side], [0, 0], element.angle || 0);
};

// Which side a stored fixedPoint sits on (for spreading arrows along a side).
export const sideOfFixedPoint = (fixedPoint: Point): Side | null => {
  const [fx, fy] = fixedPoint;
  const eps = 0.02;
  if (Math.abs(fy) < eps) return "top";
  if (Math.abs(fy - 1) < eps) return "bottom";
  if (Math.abs(fx) < eps) return "left";
  if (Math.abs(fx - 1) < eps) return "right";
  return null;
};

const expanded = (element: ExcalidrawElement, gap: number): ExcalidrawElement => {
  if (element.type === "diamond") {
    // Offsetting a rhombus's edges by `gap` grows each half-diagonal by
    // gap / cos of the edge angle.
    const halfW = (element.width || 0) / 2;
    const halfH = (element.height || 0) / 2;
    const edge = Math.hypot(halfW, halfH) || 1;
    const growW = (gap * edge) / (halfH || 1);
    const growH = (gap * edge) / (halfW || 1);
    return {
      ...element,
      x: element.x - growW,
      y: element.y - growH,
      width: (element.width || 0) + growW * 2,
      height: (element.height || 0) + growH * 2,
    };
  }
  return {
    ...element,
    x: element.x - gap,
    y: element.y - gap,
    width: (element.width || 0) + gap * 2,
    height: (element.height || 0) + gap * 2,
  };
};

// Point where the segment aim→focus first enters the element's outline grown
// by `gap` — the client's `intersectElementWithLineSegment` for orbit bindings.
export const outlinePointAlong = (
  element: ExcalidrawElement,
  aim: Point,
  focus: Point,
  gap: number,
): Point | null => {
  const range = segmentElementRange(expanded(element, gap), aim, focus);
  if (!range || range[0] <= 0) {
    return null;
  }
  const t = range[0];
  return [aim[0] + (focus[0] - aim[0]) * t, aim[1] + (focus[1] - aim[1]) * t];
};

const shiftToward = (from: Point, toward: Point, distance: number): Point => {
  const dx = toward[0] - from[0];
  const dy = toward[1] - from[1];
  const length = Math.hypot(dx, dy);
  if (length === 0) {
    return from;
  }
  return [from[0] + (dx / length) * distance, from[1] + (dy / length) * distance];
};

// Outline point of the ray from the element's centre toward `toward`.
const edgePointToward = (element: ExcalidrawElement, toward: Point): Point => {
  const c = centerOf(element);
  const angle = element.angle || 0;
  const localToward = rotatePoint(toward, c, -angle);
  const dx = localToward[0] - c[0];
  const dy = localToward[1] - c[1];
  if (dx === 0 && dy === 0) {
    return c;
  }
  const halfW = Math.max((element.width || 0) / 2, 0.0001);
  const halfH = Math.max((element.height || 0) / 2, 0.0001);
  let t: number;
  if (element.type === "ellipse") {
    t = 1 / Math.hypot(dx / halfW, dy / halfH);
  } else if (element.type === "diamond") {
    t = 1 / (Math.abs(dx) / halfW + Math.abs(dy) / halfH);
  } else {
    t = 1 / Math.max(Math.abs(dx) / halfW, Math.abs(dy) / halfH);
  }
  return rotatePoint([c[0] + dx * t, c[1] + dy * t], c, angle);
};

const AXIS_EPSILON = 1;

const elbow = (
  start: Point,
  end: Point,
  startDir: "h" | "v",
  endDir: "h" | "v",
): Point[] => {
  if (startDir === "h" && endDir === "h") {
    if (Math.abs(end[1] - start[1]) <= AXIS_EPSILON) {
      return [];
    }
    const midX = (start[0] + end[0]) / 2;
    return [
      [midX, start[1]],
      [midX, end[1]],
    ];
  }
  if (startDir === "v" && endDir === "v") {
    if (Math.abs(end[0] - start[0]) <= AXIS_EPSILON) {
      return [];
    }
    const midY = (start[1] + end[1]) / 2;
    return [
      [start[0], midY],
      [end[0], midY],
    ];
  }
  if (startDir === "h") {
    return Math.abs(end[1] - start[1]) <= AXIS_EPSILON ? [] : [[end[0], start[1]]];
  }
  return Math.abs(end[0] - start[0]) <= AXIS_EPSILON ? [] : [[start[0], end[1]]];
};

const dirOfSide = (side: Side | undefined): "h" | "v" | undefined =>
  side === "left" || side === "right" ? "h" : side === "top" || side === "bottom" ? "v" : undefined;

const overlap = (a0: number, a1: number, b0: number, b1: number): [number, number] | null => {
  const lo = Math.max(a0, b0);
  const hi = Math.min(a1, b1);
  return hi - lo > 0 ? [lo, hi] : null;
};

export type ArrowPathOptions = {
  mode?: BindMode;
  waypoints?: Point[];
  route?: RouteKind;
  startAnchor?: Anchor;
  endAnchor?: Anchor;
  // Keep these binding points (e.g. rerouting an arrow whose ends stay put).
  startFixed?: Point;
  endFixed?: Point;
};

export type ArrowPathPlan = ArrowGeometry & {
  startBinding: FixedPointBinding;
  endBinding: FixedPointBinding;
  warnings: string[];
};

// Resolve a `straight` route to facing anchors on both shapes so the arrow is
// exactly horizontal or vertical; null when the shapes share no band.
const straightAnchors = (
  from: ExcalidrawElement,
  to: ExcalidrawElement,
  startAnchor?: Anchor,
  endAnchor?: Anchor,
): { start: Anchor; end: Anchor } | { needed: string } => {
  const fx0 = from.x;
  const fx1 = from.x + (from.width || 0);
  const fy0 = from.y;
  const fy1 = from.y + (from.height || 0);
  const tx0 = to.x;
  const tx1 = to.x + (to.width || 0);
  const ty0 = to.y;
  const ty1 = to.y + (to.height || 0);
  const wantDir = dirOfSide(startAnchor?.side) ?? dirOfSide(endAnchor?.side);
  const yBand = overlap(fy0, fy1, ty0, ty1);
  const xBand = overlap(fx0, fx1, tx0, tx1);
  const horizontal =
    wantDir === "h" ||
    (wantDir === undefined && yBand !== null && (xBand === null || Math.abs(centerOf(to)[0] - centerOf(from)[0]) >= Math.abs(centerOf(to)[1] - centerOf(from)[1])));
  if (horizontal) {
    if (!yBand) {
      const dy = Math.round(centerOf(from)[1] - centerOf(to)[1]);
      return { needed: `move ${to.id} by dy=${dy} (or ${from.id} by dy=${-dy}) so the two shapes share a horizontal band` };
    }
    const y = (yBand[0] + yBand[1]) / 2;
    const toRight = centerOf(to)[0] >= centerOf(from)[0];
    return {
      start: { side: startAnchor?.side ?? (toRight ? "right" : "left"), at: (y - fy0) / Math.max(1, fy1 - fy0) },
      end: { side: endAnchor?.side ?? (toRight ? "left" : "right"), at: (y - ty0) / Math.max(1, ty1 - ty0) },
    };
  }
  if (!xBand) {
    const dx = Math.round(centerOf(from)[0] - centerOf(to)[0]);
    return { needed: `move ${to.id} by dx=${dx} (or ${from.id} by dx=${-dx}) so the two shapes share a vertical band` };
  }
  const x = (xBand[0] + xBand[1]) / 2;
  const below = centerOf(to)[1] >= centerOf(from)[1];
  return {
    start: { side: startAnchor?.side ?? (below ? "bottom" : "top"), at: (x - fx0) / Math.max(1, fx1 - fx0) },
    end: { side: endAnchor?.side ?? (below ? "top" : "bottom"), at: (x - tx0) / Math.max(1, tx1 - tx0) },
  };
};

export const planBoundArrowPath = (
  from: ExcalidrawElement,
  to: ExcalidrawElement,
  options: ArrowPathOptions = {},
): ArrowPathPlan => {
  const mode: BindMode = options.mode ?? "orbit";
  const warnings: string[] = [];
  let startAnchor = options.startAnchor;
  let endAnchor = options.endAnchor;
  let route: RouteKind = options.route ?? "direct";
  if (route === "straight" && !options.waypoints?.length) {
    const resolved = straightAnchors(from, to, startAnchor, endAnchor);
    if ("needed" in resolved) {
      warnings.push(`route "straight" is impossible here: ${resolved.needed}; used an orthogonal route instead`);
      route = "orthogonal";
    } else {
      startAnchor = resolved.start;
      endAnchor = resolved.end;
    }
  }
  const waypoints = options.waypoints ?? [];
  const orthogonal = route === "orthogonal" && waypoints.length === 0;
  const centerFrom = centerOf(from);
  const centerTo = centerOf(to);
  const horizontal =
    Math.abs(centerTo[0] - centerFrom[0]) >= Math.abs(centerTo[1] - centerFrom[1]);

  const startFixed = startAnchor ? anchorFixedPoint(startAnchor) : options.startFixed;
  const endFixed = endAnchor ? anchorFixedPoint(endAnchor) : options.endFixed;

  // Aim points for projecting a free end onto its outline.
  const aimFrom: Point =
    waypoints[0] ??
    (endFixed ? globalFixedPoint(endFixed, to) : orthogonal ? [centerTo[0], centerFrom[1]] : centerTo);
  const aimTo: Point =
    waypoints[waypoints.length - 1] ??
    (startFixed ? globalFixedPoint(startFixed, from) : orthogonal ? [centerFrom[0], centerTo[1]] : centerFrom);

  const contactFrom = startFixed ? globalFixedPoint(startFixed, from) : edgePointToward(from, aimFrom);
  const contactTo = endFixed ? globalFixedPoint(endFixed, to) : edgePointToward(to, aimTo);

  const startDir = dirOfSide(startAnchor?.side) ?? (horizontal ? "h" : "v");
  const endDir = dirOfSide(endAnchor?.side) ?? (horizontal ? "h" : "v");
  const middle: Point[] = waypoints.length
    ? waypoints
    : orthogonal
      ? elbow(contactFrom, contactTo, startDir, endDir)
      : [];

  const startNormal = startAnchor ? sideNormal(startAnchor.side, from) : null;
  const endNormal = endAnchor ? sideNormal(endAnchor.side, to) : null;
  const gapFrom = mode === "inside" ? 0 : bindingGap(from);
  const gapTo = mode === "inside" ? 0 : bindingGap(to);
  let start: Point = startNormal
    ? [contactFrom[0] + startNormal[0] * gapFrom, contactFrom[1] + startNormal[1] * gapFrom]
    : shiftToward(contactFrom, middle[0] ?? contactTo, gapFrom);
  let end: Point = endNormal
    ? [contactTo[0] + endNormal[0] * gapTo, contactTo[1] + endNormal[1] * gapTo]
    : shiftToward(contactTo, middle[middle.length - 1] ?? contactFrom, gapTo);
  // Keep an orthogonal route axis-aligned after the gap shift.
  if (orthogonal && middle.length) {
    const first = middle[0];
    const last = middle[middle.length - 1];
    if (startDir === "h") first[1] = start[1];
    else first[0] = start[0];
    if (endDir === "h") last[1] = end[1];
    else last[0] = end[0];
  }
  if (!middle.length && Math.hypot(end[0] - start[0], end[1] - start[1]) < 1) {
    start = contactFrom;
    end = contactTo;
  }
  if (route === "straight" && !waypoints.length) {
    // Snap tiny float drift so the segment is exactly axis-aligned.
    if (dirOfSide(startAnchor?.side) === "h") end = [end[0], start[1]];
    else end = [start[0], end[1]];
  }

  return {
    ...geometryFromGlobalPath([start, ...middle, end]),
    startBinding: {
      elementId: from.id,
      fixedPoint: startFixed ? normalizeFixedPoint(startFixed) : computeFixedPoint(from, contactFrom),
      mode,
    },
    endBinding: {
      elementId: to.id,
      fixedPoint: endFixed ? normalizeFixedPoint(endFixed) : computeFixedPoint(to, contactTo),
      mode,
    },
    warnings,
  };
};

// Unbound (or half-bound) arrow: keep its free ends where they are and only
// reshape the detour.
export const reshapeFreeArrow = (
  arrow: ExcalidrawElement,
  options: { waypoints?: Point[]; route?: RouteKind },
): ArrowGeometry => {
  const path = globalLinearPoints(arrow);
  const start = path[0];
  const end = path[path.length - 1];
  const horizontal = Math.abs(end[0] - start[0]) >= Math.abs(end[1] - start[1]);
  const dir = horizontal ? "h" : "v";
  const middle = options.waypoints?.length
    ? options.waypoints
    : options.route === "orthogonal"
      ? elbow(start, end, dir, dir)
      : [];
  return geometryFromGlobalPath([start, ...middle, end]);
};

// Classify an existing path so a reroute can keep its character.
export const inferRoute = (arrow: ExcalidrawElement): "direct" | "orthogonal" | "waypoints" => {
  const points = globalLinearPoints(arrow);
  if (points.length <= 2) {
    return "direct";
  }
  const axisAligned = points.every((point, i) => {
    if (i === 0) return true;
    const prev = points[i - 1];
    return Math.abs(point[0] - prev[0]) < 0.5 || Math.abs(point[1] - prev[1]) < 0.5;
  });
  return axisAligned ? "orthogonal" : "waypoints";
};

// The client's `updateBoundPoint` for one end of an arrow whose bound shape
// moved: aim from the neighbouring point (or the other end's focus on a
// 2-point arrow) at the stored fixed point and stop at the outline + gap.
const boundEndPoint = (
  arrow: ExcalidrawElement,
  which: "start" | "end",
  shape: ExcalidrawElement,
  points: Point[],
  lookup: (id: string) => ExcalidrawElement | undefined,
): Point => {
  const linear = asLinear(arrow);
  const binding = which === "start" ? linear.startBinding : linear.endBinding;
  const other = which === "start" ? linear.endBinding : linear.startBinding;
  if (!binding) {
    return which === "start" ? points[0] : points[points.length - 1];
  }
  const focus = globalFixedPoint(binding.fixedPoint, shape);
  if (binding.mode === "inside") {
    return focus;
  }
  let aim: Point;
  if (points.length === 2) {
    const otherShape = other ? lookup(other.elementId) : undefined;
    aim =
      other && otherShape && !otherShape.isDeleted
        ? globalFixedPoint(other.fixedPoint, otherShape)
        : which === "start"
          ? points[1]
          : points[0];
  } else {
    aim = which === "start" ? points[1] : points[points.length - 2];
  }
  return outlinePointAlong(shape, aim, focus, bindingGap(shape)) ?? focus;
};

// Recompute the ends of `arrow` bound to any of `movedShapeIds` (or both ends
// of a 2-point arrow, as the client does), keeping middle points in place.
export const followBoundShapes = (
  arrow: ExcalidrawElement,
  movedShapeIds: ReadonlySet<string>,
  lookup: (id: string) => ExcalidrawElement | undefined,
): ArrowGeometry | null => {
  const linear = asLinear(arrow);
  const points = globalLinearPoints(arrow);
  if (points.length < 2) {
    return null;
  }
  const startShape = linear.startBinding ? lookup(linear.startBinding.elementId) : undefined;
  const endShape = linear.endBinding ? lookup(linear.endBinding.elementId) : undefined;
  const startMoved = !!startShape && movedShapeIds.has(startShape.id);
  const endMoved = !!endShape && movedShapeIds.has(endShape.id);
  if (!startMoved && !endMoved) {
    return null;
  }
  const twoPoint = points.length === 2;
  const next = points.map((point) => [...point] as Point);
  const updateStart = !!startShape && !startShape.isDeleted && (startMoved || twoPoint);
  const updateEnd = !!endShape && !endShape.isDeleted && (endMoved || twoPoint);
  // For a 2-point arrow both ends aim at each other's focus, so compute both
  // from the original points before writing either.
  const newStart = updateStart ? boundEndPoint(arrow, "start", startShape!, points, lookup) : null;
  const newEnd = updateEnd ? boundEndPoint(arrow, "end", endShape!, points, lookup) : null;
  if (newStart) next[0] = newStart;
  if (newEnd) next[next.length - 1] = newEnd;
  return geometryFromGlobalPath(next);
};

export const translateGeometry = (arrow: ExcalidrawElement, dx: number, dy: number): { x: number; y: number } => ({
  x: arrow.x + dx,
  y: arrow.y + dy,
});

// Bind one end of an arrow whose other end stays free: the bound end lands on
// the shape's outline (+ gap) facing the free end, or at an anchor.
export const planHalfBound = (
  arrow: ExcalidrawElement,
  which: "start" | "end",
  shape: ExcalidrawElement,
  options: { mode?: BindMode; anchor?: Anchor } = {},
): { geometry: ArrowGeometry; binding: FixedPointBinding } => {
  const points = globalLinearPoints(arrow);
  const free = which === "start" ? points[points.length - 1] : points[0];
  const neighbour = points.length > 2 ? (which === "start" ? points[1] : points[points.length - 2]) : free;
  const mode = options.mode ?? "orbit";
  const fixed = options.anchor ? anchorFixedPoint(options.anchor) : undefined;
  const contact = fixed ? globalFixedPoint(fixed, shape) : edgePointToward(shape, neighbour);
  const normal = options.anchor ? sideNormal(options.anchor.side, shape) : null;
  const gap = mode === "inside" ? 0 : bindingGap(shape);
  const end: Point = normal
    ? [contact[0] + normal[0] * gap, contact[1] + normal[1] * gap]
    : shiftToward(contact, neighbour, gap);
  const next = points.map((point) => [...point] as Point);
  if (which === "start") next[0] = end;
  else next[next.length - 1] = end;
  return {
    geometry: geometryFromGlobalPath(next),
    binding: {
      elementId: shape.id,
      fixedPoint: fixed ? normalizeFixedPoint(fixed) : computeFixedPoint(shape, contact),
      mode,
    },
  };
};
