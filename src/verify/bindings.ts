import type {ExcalidrawElement} from "../types";
import {BASE_BINDING_GAP, type BindMode, CENTER_RATIO, type FixedPointBinding, type Point,} from "./model";
import {globalLinearPoints, rotatePoint} from "./geometry";

const center = (element: ExcalidrawElement): Point => [
  element.x + (element.width || 0) / 2,
  element.y + (element.height || 0) / 2,
];

export const bindingGap = (element: ExcalidrawElement): number =>
  BASE_BINDING_GAP + (element.strokeWidth || 0) / 2;

export const normalizeFixedPoint = ([x, y]: Point): Point => [
  Math.abs(x - 0.5) < 0.0001 ? CENTER_RATIO : x,
  Math.abs(y - 0.5) < 0.0001 ? CENTER_RATIO : y,
];

const edgePointToward = (
  element: ExcalidrawElement,
  toward: Point,
): Point => {
  const c = center(element);
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
  const localEdge: Point = [c[0] + dx * t, c[1] + dy * t];
  return rotatePoint(localEdge, c, angle);
};

export const computeFixedPoint = (
  element: ExcalidrawElement,
  globalContact: Point,
): Point => {
  const c = center(element);
  const local = rotatePoint(globalContact, c, -(element.angle || 0));
  const ratioX = (local[0] - element.x) / Math.max(element.width || 0, 0.0001);
  const ratioY = (local[1] - element.y) / Math.max(element.height || 0, 0.0001);
  return normalizeFixedPoint([ratioX, ratioY]);
};

export type ConnectionPlan = {
  arrow: Partial<ExcalidrawElement> & { type: "arrow" };
  fromBoundElements: { id: string; type: string }[];
  toBoundElements: { id: string; type: string }[];
};

export type RouteMode = "direct" | "orthogonal";

export type ArrowPathOptions = {
  mode?: BindMode;
  waypoints?: Point[];
  route?: RouteMode;
};

export type ConnectOptions = ArrowPathOptions & {
  arrowId: string;
  startArrowhead?: string | null;
  endArrowhead?: string | null;
};

export type ArrowPath = {
  x: number;
  y: number;
  width: number;
  height: number;
  points: Point[];
  startBinding: FixedPointBinding;
  endBinding: FixedPointBinding;
};

const withBackref = (
  element: ExcalidrawElement,
  arrowId: string,
): { id: string; type: string }[] => {
  const existing = Array.isArray(element.boundElements)
    ? element.boundElements
    : [];
  if (existing.some((entry) => entry.id === arrowId)) {
    return [...existing];
  }
  return [...existing, { id: arrowId, type: "arrow" }];
};

const AXIS_EPSILON = 1;

const shiftToward = (from: Point, toward: Point, distance: number): Point => {
  const dx = toward[0] - from[0];
  const dy = toward[1] - from[1];
  const length = Math.hypot(dx, dy);
  if (length === 0) {
    return from;
  }
  return [from[0] + (dx / length) * distance, from[1] + (dy / length) * distance];
};

const elbowBetween = (
  start: Point,
  end: Point,
  horizontal: boolean,
): Point[] => {
  if (horizontal) {
    if (Math.abs(end[1] - start[1]) <= AXIS_EPSILON) {
      return [];
    }
    const midX = (start[0] + end[0]) / 2;
    return [
      [midX, start[1]],
      [midX, end[1]],
    ];
  }
  if (Math.abs(end[0] - start[0]) <= AXIS_EPSILON) {
    return [];
  }
  const midY = (start[1] + end[1]) / 2;
  return [
    [start[0], midY],
    [end[0], midY],
  ];
};

const spanOf = (points: Point[]): { width: number; height: number } => {
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  return {
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
};

export type ArrowGeometry = {
  x: number;
  y: number;
  width: number;
  height: number;
  points: Point[];
};

const geometryFromGlobalPath = (globalPath: Point[]): ArrowGeometry => {
  const [origin] = globalPath;
  const points: Point[] = globalPath.map(([x, y]) => [x - origin[0], y - origin[1]]);
  return { x: origin[0], y: origin[1], ...spanOf(points), points };
};

const middleFor = (
  start: Point,
  end: Point,
  options: ArrowPathOptions,
  horizontal: boolean,
): Point[] => {
  if (options.waypoints?.length) {
    return options.waypoints;
  }
  return options.route === "orthogonal" ? elbowBetween(start, end, horizontal) : [];
};

const dominantlyHorizontal = (start: Point, end: Point): boolean =>
  Math.abs(end[0] - start[0]) >= Math.abs(end[1] - start[1]);

// Reshapes an unbound arrow in place: its own endpoints stay, the detour changes.
export const reshapeArrowPath = (
  arrow: ExcalidrawElement,
  options: ArrowPathOptions,
): ArrowGeometry => {
  const path = globalLinearPoints(arrow);
  const start = path[0];
  const end = path[path.length - 1];
  const middle = middleFor(start, end, options, dominantlyHorizontal(start, end));
  return geometryFromGlobalPath([start, ...middle, end]);
};

export const planArrowPath = (
  from: ExcalidrawElement,
  to: ExcalidrawElement,
  options: ArrowPathOptions = {},
): ArrowPath => {
  const mode: BindMode = options.mode ?? "orbit";
  const waypoints = options.waypoints ?? [];
  const centerFrom = center(from);
  const centerTo = center(to);
  const horizontal = dominantlyHorizontal(centerFrom, centerTo);
  const orthogonal = options.route === "orthogonal" && waypoints.length === 0;

  // An elbow leaves and enters along its own axis, not toward the opposite centre.
  const aimFrom = waypoints[0] ?? (orthogonal
    ? ([centerTo[0], centerFrom[1]] as Point)
    : centerTo);
  const aimTo = waypoints[waypoints.length - 1] ?? (orthogonal
    ? ([centerFrom[0], centerTo[1]] as Point)
    : centerFrom);

  const contactFrom = edgePointToward(from, aimFrom);
  const contactTo = edgePointToward(to, aimTo);

  const middle = middleFor(contactFrom, contactTo, options, horizontal);

  let start = shiftToward(
    contactFrom,
    middle[0] ?? contactTo,
    bindingGap(from),
  );
  let end = shiftToward(
    contactTo,
    middle[middle.length - 1] ?? contactFrom,
    bindingGap(to),
  );
  if (!middle.length && Math.hypot(end[0] - start[0], end[1] - start[1]) < 1) {
    start = contactFrom;
    end = contactTo;
  }

  return {
    ...geometryFromGlobalPath([start, ...middle, end]),
    startBinding: {
      elementId: from.id,
      fixedPoint: computeFixedPoint(from, contactFrom),
      mode,
    },
    endBinding: {
      elementId: to.id,
      fixedPoint: computeFixedPoint(to, contactTo),
      mode,
    },
  };
};

export const planConnection = (
  from: ExcalidrawElement,
  to: ExcalidrawElement,
  options: ConnectOptions,
): ConnectionPlan => {
  const path = planArrowPath(from, to, options);
  const arrow: Partial<ExcalidrawElement> & { type: "arrow" } = {
    type: "arrow",
    ...path,
    elbowed: false,
    startArrowhead: options.startArrowhead ?? null,
    endArrowhead: options.endArrowhead === undefined ? "arrow" : options.endArrowhead,
  } as Partial<ExcalidrawElement> & { type: "arrow" };

  return {
    arrow,
    fromBoundElements: withBackref(from, options.arrowId),
    toBoundElements: withBackref(to, options.arrowId),
  };
};
