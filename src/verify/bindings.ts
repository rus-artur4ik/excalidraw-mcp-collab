import type {ExcalidrawElement} from "../types";
import {BASE_BINDING_GAP, type BindMode, CENTER_RATIO, type FixedPointBinding, type Point,} from "./model";
import {rotatePoint} from "./geometry";

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

export type ConnectOptions = {
  arrowId: string;
  mode?: BindMode;
  startArrowhead?: string | null;
  endArrowhead?: string | null;
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

export const planConnection = (
  from: ExcalidrawElement,
  to: ExcalidrawElement,
  options: ConnectOptions,
): ConnectionPlan => {
  const mode: BindMode = options.mode ?? "orbit";
  const contactFrom = edgePointToward(from, center(to));
  const contactTo = edgePointToward(to, center(from));

  const fixedFrom = computeFixedPoint(from, contactFrom);
  const fixedTo = computeFixedPoint(to, contactTo);

  const dx = contactTo[0] - contactFrom[0];
  const dy = contactTo[1] - contactFrom[1];
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const gapFrom = bindingGap(from);
  const gapTo = bindingGap(to);

  let start: Point = [contactFrom[0] + ux * gapFrom, contactFrom[1] + uy * gapFrom];
  let end: Point = [contactTo[0] - ux * gapTo, contactTo[1] - uy * gapTo];
  if (Math.hypot(end[0] - start[0], end[1] - start[1]) < 1) {
    start = contactFrom;
    end = contactTo;
  }

  const localEnd: Point = [end[0] - start[0], end[1] - start[1]];
  const startBinding: FixedPointBinding = {
    elementId: from.id,
    fixedPoint: fixedFrom,
    mode,
  };
  const endBinding: FixedPointBinding = {
    elementId: to.id,
    fixedPoint: fixedTo,
    mode,
  };

  const arrow: Partial<ExcalidrawElement> & { type: "arrow" } = {
    type: "arrow",
    x: start[0],
    y: start[1],
    width: Math.abs(localEnd[0]),
    height: Math.abs(localEnd[1]),
    points: [
      [0, 0],
      [localEnd[0], localEnd[1]],
    ],
    elbowed: false,
    startArrowhead: options.startArrowhead ?? null,
    endArrowhead: options.endArrowhead === undefined ? "arrow" : options.endArrowhead,
    startBinding,
    endBinding,
  } as Partial<ExcalidrawElement> & { type: "arrow" };

  return {
    arrow,
    fromBoundElements: withBackref(from, options.arrowId),
    toBoundElements: withBackref(to, options.arrowId),
  };
};
