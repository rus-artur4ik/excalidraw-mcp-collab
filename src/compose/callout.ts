import type {ExcalidrawElement} from "../types";
import {type BoardProfile, fontSizeFor, resolveProfile} from "../profile";
import {customDataOf} from "../customData";
import {globalLinearPoints} from "../verify/geometry";
import {asText, DEFAULT_FONT_FAMILY, isFrameLike, isLinear, type Point} from "../verify/model";
import {isRoleName, resolveRole, ROLE_NAMES} from "../verify/styles";
import {
  AUTO_WIDTH_SLACK,
  elementBounds,
  liveBoundsOf,
  liveById,
  measureBlock,
  resolveAnchor,
  unionBounds,
} from "./common";
import type {ComposePlan, PlanBounds, PlannedItem} from "./types";

export type CalloutSide = "top" | "right" | "bottom" | "left";

export type CalloutInput = {
  id: string;
  anchorId: string;
  text: string;
  side?: "auto" | CalloutSide;
  // Largest gap between the box and the anchor (default 120).
  maxDistance?: number;
  // Palette role in its subtle tone; default note.
  role?: string;
  frameId?: string;
};

const FONT_SIZE = 16;
const MAX_TEXT_WIDTH = 240;
const PAD_X = 12;
const PAD_Y = 8;
const DEFAULT_MAX_DISTANCE = 120;
// A pointer shorter than this reads as a glitch, not a leader line.
const MIN_GAP = 40;
const GAP_STEP = 16;
const SLIDE_STEP = 16;
// Minimum shared span with the anchor for the pointer to stay straight.
const MIN_OVERLAP = 16;
const CLEARANCE = 8;
const AUTO_SIDES: CalloutSide[] = ["right", "bottom", "top", "left"];

const OPPOSITE: Record<CalloutSide, CalloutSide> = {
  top: "bottom",
  bottom: "top",
  left: "right",
  right: "left",
};

type Rect = { minX: number; minY: number; maxX: number; maxY: number };

const toRect = (b: PlanBounds): Rect => ({
  minX: b.x,
  minY: b.y,
  maxX: b.x + b.width,
  maxY: b.y + b.height,
});

const inflate = (r: Rect, by: number): Rect => ({
  minX: r.minX - by,
  minY: r.minY - by,
  maxX: r.maxX + by,
  maxY: r.maxY + by,
});

const overlapArea = (a: Rect, b: Rect): number => {
  const w = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
  const h = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
  return w > 0 && h > 0 ? w * h : 0;
};

const contains = (outer: Rect, inner: Rect): boolean =>
  outer.minX <= inner.minX &&
  outer.minY <= inner.minY &&
  outer.maxX >= inner.maxX &&
  outer.maxY >= inner.maxY;

// Liang–Barsky: length of segment a→b inside the rectangle.
const segmentInside = (a: Point, b: Point, r: Rect): number => {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const p = [-dx, dx, -dy, dy];
  const q = [a[0] - r.minX, r.maxX - a[0], a[1] - r.minY, r.maxY - a[1]];
  let t0 = 0;
  let t1 = 1;
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) {
        return 0;
      }
      continue;
    }
    const t = q[i] / p[i];
    if (p[i] < 0) {
      t0 = Math.max(t0, t);
    } else {
      t1 = Math.min(t1, t);
    }
    if (t0 > t1) {
      return 0;
    }
  }
  return (t1 - t0) * Math.hypot(dx, dy);
};

type Obstacle =
  | { kind: "box"; rect: Rect }
  | { kind: "path"; points: Point[] };

const collectObstacles = (
  calloutId: string,
  anchor: ExcalidrawElement,
  byId: Map<string, ExcalidrawElement>,
): Obstacle[] => {
  const anchorRect = toRect(elementBounds(anchor));
  const obstacles: Obstacle[] = [];
  for (const element of byId.values()) {
    const containerId = asText(element).containerId;
    if (
      element.id === calloutId ||
      element.id === `${calloutId}:ptr` ||
      element.id === anchor.id ||
      containerId === calloutId ||
      containerId === anchor.id ||
      isFrameLike(element)
    ) {
      continue;
    }
    if (isLinear(element)) {
      obstacles.push({ kind: "path", points: globalLinearPoints(element) });
      continue;
    }
    const rect = toRect(elementBounds(element));
    // Lanes, group frames and panels around the anchor are the backdrop the
    // callout is meant to sit on, not something to avoid.
    if (element.type !== "text" && contains(rect, anchorRect)) {
      continue;
    }
    obstacles.push({ kind: "box", rect });
  }
  return obstacles;
};

const collision = (box: Rect, obstacles: readonly Obstacle[]): number => {
  const zone = inflate(box, CLEARANCE);
  let score = 0;
  for (const obstacle of obstacles) {
    if (obstacle.kind === "box") {
      score += overlapArea(zone, obstacle.rect);
    } else {
      for (let i = 0; i < obstacle.points.length - 1; i++) {
        score += segmentInside(obstacle.points[i], obstacle.points[i + 1], zone);
      }
    }
  }
  return score;
};

type Candidate = { side: CalloutSide; rect: Rect };

const candidateRects = (
  anchor: Rect,
  width: number,
  height: number,
  sides: readonly CalloutSide[],
  maxDistance: number,
): Candidate[] => {
  const distances: number[] = [];
  for (let d = Math.min(MIN_GAP, maxDistance); d <= maxDistance; d += GAP_STEP) {
    distances.push(d);
  }
  if (distances[distances.length - 1] !== maxDistance) {
    distances.push(maxDistance);
  }
  const centerX = (anchor.minX + anchor.maxX) / 2;
  const centerY = (anchor.minY + anchor.maxY) / 2;
  const slideLimit = (side: CalloutSide): number => {
    const horizontal = side === "left" || side === "right";
    const anchorSpan = horizontal ? anchor.maxY - anchor.minY : anchor.maxX - anchor.minX;
    const boxSpan = horizontal ? height : width;
    return Math.max(0, (anchorSpan + boxSpan) / 2 - MIN_OVERLAP);
  };
  const maxSteps = Math.ceil(Math.max(...sides.map(slideLimit)) / SLIDE_STEP);
  const candidates: Candidate[] = [];
  // Nearest gap first, then the least slide off-center, then side preference.
  for (const d of distances) {
    for (let step = 0; step <= maxSteps; step++) {
      for (const offset of step === 0 ? [0] : [step * SLIDE_STEP, -step * SLIDE_STEP]) {
        for (const side of sides) {
          if (Math.abs(offset) > slideLimit(side)) {
            continue;
          }
          let x: number;
          let y: number;
          if (side === "left" || side === "right") {
            x = side === "right" ? anchor.maxX + d : anchor.minX - d - width;
            y = centerY - height / 2 + offset;
          } else {
            x = centerX - width / 2 + offset;
            y = side === "bottom" ? anchor.maxY + d : anchor.minY - d - height;
          }
          x = Math.round(x);
          y = Math.round(y);
          candidates.push({ side, rect: { minX: x, minY: y, maxX: x + width, maxY: y + height } });
        }
      }
    }
  }
  return candidates;
};

// Shared span of box and anchor across the pointer's axis, or null.
const sharedSpan = (side: CalloutSide, box: Rect, anchor: Rect): [number, number] | null => {
  const [a0, a1, b0, b1] =
    side === "left" || side === "right"
      ? [anchor.minY, anchor.maxY, box.minY, box.maxY]
      : [anchor.minX, anchor.maxX, box.minX, box.maxX];
  const lo = Math.max(a0, b0);
  const hi = Math.min(a1, b1);
  return hi - lo >= 1 ? [lo, hi] : null;
};

export const planCallout = (
  input: CalloutInput,
  live: readonly ExcalidrawElement[],
  profile?: BoardProfile | null,
): ComposePlan => {
  const { id } = input;
  if (typeof id !== "string" || !id.length) {
    throw new Error("callout id must be a non-empty string");
  }
  if (typeof input.text !== "string" || !input.text.trim().length) {
    throw new Error(`callout "${id}" needs text`);
  }
  if (input.role !== undefined && !isRoleName(input.role)) {
    throw new Error(`unknown role "${input.role}"; valid roles: ${ROLE_NAMES.join(", ")}`);
  }
  const side = input.side ?? "auto";
  if (side !== "auto" && !(side in OPPOSITE)) {
    throw new Error(`side must be auto, top, right, bottom or left`);
  }
  const byId = liveById(live);
  const anchor = resolveAnchor(input.anchorId, byId);
  if (anchor.id === id) {
    throw new Error(`callout "${id}" cannot anchor to itself`);
  }
  const existing = byId.get(id);
  if (existing && customDataOf(existing).kind !== "callout") {
    throw new Error(`element "${id}" exists and is not a callout; pick another id`);
  }
  if (input.frameId) {
    const frame = byId.get(input.frameId);
    if (!frame || !isFrameLike(frame)) {
      throw new Error(`frame "${input.frameId}" not found`);
    }
  }
  const frameId = input.frameId ?? anchor.frameId ?? null;
  const frame = frameId ? byId.get(frameId) : undefined;
  const frameRect = frame && isFrameLike(frame) ? toRect(elementBounds(frame)) : undefined;

  const style = resolveRole(input.role ?? "note", "subtle")!;
  const fontSize = profile ? fontSizeFor(profile, "body") : FONT_SIZE;
  const padX = profile ? resolveProfile(profile).spacing.cellPadding : PAD_X;
  const padY = profile ? resolveProfile(profile).spacing.cellPadding : PAD_Y;
  const block = measureBlock(input.text, fontSize, DEFAULT_FONT_FAMILY, MAX_TEXT_WIDTH);
  const width = block.width + 2 * padX + AUTO_WIDTH_SLACK;
  const height = block.height + 2 * padY;
  const maxDistance = Math.max(0, input.maxDistance ?? DEFAULT_MAX_DISTANCE);

  const anchorRect = toRect(elementBounds(anchor));
  const obstacles = collectObstacles(id, anchor, byId);
  const candidates = candidateRects(
    anchorRect,
    width,
    height,
    side === "auto" ? AUTO_SIDES : [side],
    maxDistance,
  );
  const inFrame = (rect: Rect) => !frameRect || contains(frameRect, rect);
  let chosen = candidates.find(
    (candidate) => inFrame(candidate.rect) && collision(candidate.rect, obstacles) === 0,
  );
  const warnings: string[] = [];
  if (!chosen) {
    // Never throw on a crowded board: take the least-covered spot and say so,
    // the lint will point at what it overlaps.
    let best = candidates[0];
    let bestScore = Infinity;
    for (const candidate of candidates) {
      const score =
        collision(candidate.rect, obstacles) + (inFrame(candidate.rect) ? 0 : 1e6);
      if (score < bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    chosen = best;
    warnings.push(
      `no free spot for callout "${id}" within ${maxDistance}px of "${anchor.id}"; ` +
        "it overlaps other elements — raise maxDistance, pick another side or make room",
    );
  }

  const box = chosen.rect;
  const span = sharedSpan(chosen.side, box, anchorRect);
  // Bounds only: the core routes the bound arrow itself.
  const mid = span ? (span[0] + span[1]) / 2 : undefined;
  const horizontal = chosen.side === "left" || chosen.side === "right";
  const start: Point = horizontal
    ? [chosen.side === "right" ? box.minX : box.maxX, mid ?? (box.minY + box.maxY) / 2]
    : [mid ?? (box.minX + box.maxX) / 2, chosen.side === "bottom" ? box.minY : box.maxY];
  const end: Point = horizontal
    ? [chosen.side === "right" ? anchorRect.maxX : anchorRect.minX, mid ?? (anchorRect.minY + anchorRect.maxY) / 2]
    : [mid ?? (anchorRect.minX + anchorRect.maxX) / 2, chosen.side === "bottom" ? anchorRect.maxY : anchorRect.minY];

  const boxItem: PlannedItem = {
    id,
    type: "rectangle",
    x: box.minX,
    y: box.minY,
    width,
    height,
    frameId,
    backgroundColor: style.backgroundColor,
    strokeColor: style.strokeColor,
    strokeWidth: 1,
    strokeStyle: "solid",
    fillStyle: "solid",
    roughness: 0,
    opacity: 100,
    roundness: { type: 3 },
    label: input.text,
    labelFontSize: fontSize,
    labelFontFamily: DEFAULT_FONT_FAMILY,
    labelColor: style.labelColor,
    textAlign: "center",
    verticalAlign: "middle",
    customData: { kind: "callout" },
  };
  const pointer: PlannedItem = {
    id: `${id}:ptr`,
    type: "arrow",
    fromId: id,
    toId: anchor.id,
    startAnchor: { side: OPPOSITE[chosen.side] },
    endAnchor: { side: chosen.side },
    ...(span ? { route: "straight" as const } : {}),
    frameId,
    strokeColor: style.strokeColor,
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    startArrowhead: null,
    endArrowhead: "arrow",
    customData: { kind: "callout" },
  };

  const previousBounds = liveBoundsOf([id, `${id}:ptr`], byId);
  return {
    items: [boxItem, pointer],
    removeIds: [],
    bounds: unionBounds([
      { x: box.minX, y: box.minY, width, height },
      {
        x: Math.min(start[0], end[0]),
        y: Math.min(start[1], end[1]),
        width: Math.abs(end[0] - start[0]),
        height: Math.abs(end[1] - start[1]),
      },
    ]),
    ...(previousBounds ? { previousBounds } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
};
