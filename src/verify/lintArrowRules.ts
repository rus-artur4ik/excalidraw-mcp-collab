import type {ExcalidrawElement} from "../types";
import {kindOf} from "../customData";
import {asLinear, type Bounds, isBindable, isFrameLike, isLinear, MAX_BINDING_DISTANCE, type Point,} from "./model";
import {boundsContain, distanceToElement, globalLinearPoints, pointInElement, segmentElementOverlap,} from "./geometry";
import {bindingGap, planArrowPath} from "./bindings";
import {
    arrowLabelCenter,
    boundsIntersect,
    containerIdOf,
    deleteSuggestion,
    distanceToPath,
    expandBounds,
    forEachPair,
    inflateElement,
    isConnector,
    isDivider,
    layoutLabelIn,
    type LintContext,
    NESTING_KINDS,
    partnersOf,
    pathLength,
    reasonSuggestion,
    REGION_KINDS,
    repairSuggestion,
    round,
    segmentIntersection,
    separationFor,
    SHAPE_TYPES,
    sharesGroup,
    standaloneTextBox,
    syntheticRect,
    textContent,
    updateSuggestion,
} from "./lintContext";

const CROSSING_MIN_CHORD = 4;
const REROUTE_MARGIN = 24;
const TEXT_REROUTE_MARGIN = 16;
const DETOUR_CLEARANCE = 4;
const GRAZE_DISTANCE = 6;
const MIN_SEGMENT = 8;
const DEEP_INSIDE = 8;
const CONVERGE_DISTANCE = 16;
const LABEL_FAR = 24;
const FREE_LABEL_RANGE = 120;
const AXIS_TOLERANCE = 2;
const LABEL_SEPARATION = 8;

type Side = "start" | "end";

const endpoint = (path: readonly Point[], side: Side): Point =>
  side === "start" ? path[0] : path[path.length - 1];

const hasArrowhead = (arrow: ExcalidrawElement, side: Side): boolean => {
  const linear = asLinear(arrow);
  return !!(side === "start" ? linear.startArrowhead : linear.endArrowhead);
};

const bindingOf = (arrow: ExcalidrawElement, side: Side) => {
  const linear = asLinear(arrow);
  return side === "start" ? linear.startBinding : linear.endBinding;
};

const endpointField = (side: Side): "fromId" | "toId" => (side === "start" ? "fromId" : "toId");

const roundPoint = ([x, y]: Point): Point => [round(x), round(y)];

// ---- obstacles and detours -----------------------------------------------

type Obstacle = { id: string; shape: ExcalidrawElement; bounds: Bounds };

const exemptIds = (ctx: LintContext, arrow: ExcalidrawElement): Set<string> => {
  const linear = asLinear(arrow);
  const exempt = new Set<string>([arrow.id]);
  for (const binding of [linear.startBinding, linear.endBinding]) {
    if (binding) {
      exempt.add(binding.elementId);
    }
  }
  for (const entry of arrow.boundElements ?? []) {
    exempt.add(entry.id);
  }
  for (const text of ctx.textsByContainer.get(arrow.id) ?? []) {
    exempt.add(text.id);
  }
  return exempt;
};

const isShapeObstacle = (element: ExcalidrawElement): boolean => {
  const kind = kindOf(element);
  return SHAPE_TYPES.has(element.type) && !(kind && REGION_KINDS.has(kind));
};

// A shape the arrow may pass through without it being a crossing.
const exemptObstacle = (
  arrow: ExcalidrawElement,
  path: readonly Point[],
  arrowBounds: Bounds,
  obstacle: ExcalidrawElement,
  obstacleBounds: Bounds,
  exempt: Set<string>,
): boolean =>
  exempt.has(obstacle.id) ||
  (obstacle.boundElements ?? []).some((entry) => entry.id === arrow.id) ||
  // A shape enclosing the whole arrow is a backdrop; an endpoint inside a
  // shape is arrow_endpoint_inside_node's job.
  boundsContain(obstacleBounds, arrowBounds) ||
  pointInElement(obstacle, path[0][0], path[0][1]) ||
  pointInElement(obstacle, path[path.length - 1][0], path[path.length - 1][1]);

const chordThrough = (shape: ExcalidrawElement, path: readonly Point[]): number => {
  let chord = 0;
  for (let i = 0; i < path.length - 1; i++) {
    chord += segmentElementOverlap(shape, path[i], path[i + 1]);
  }
  return chord;
};

const pathBounds = (path: readonly Point[]): Bounds => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of path) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return [minX, minY, maxX, maxY];
};

// Candidate lists shared by every arrow of one run, with their scoped subsets.
type Candidates = {
  obstacles: ExcalidrawElement[];
  scopedObstacles: ExcalidrawElement[];
  nodes: ExcalidrawElement[];
  scopedNodes: ExcalidrawElement[];
  texts: ExcalidrawElement[];
  scopedTexts: ExcalidrawElement[];
};

type ArrowGeometryCache = {
  path: Point[];
  bounds: Bounds;
  exempt: Set<string>;
  candidates: Candidates;
  pool?: Obstacle[];
};

// The path the write pipeline will produce for these waypoints: a bound arrow
// re-aims its ends at the first/last waypoint, a free one keeps its ends.
const plannedPath = (
  ctx: LintContext,
  arrow: ExcalidrawElement,
  path: readonly Point[],
  waypoints: readonly Point[],
): Point[] => {
  const linear = asLinear(arrow);
  const from = linear.startBinding ? ctx.byId.get(linear.startBinding.elementId) : undefined;
  const to = linear.endBinding ? ctx.byId.get(linear.endBinding.elementId) : undefined;
  if (from && to && from.id !== to.id) {
    const plan = planArrowPath(from, to, {
      waypoints: [...waypoints],
      mode: linear.startBinding?.mode ?? "orbit",
    });
    return plan.points.map(([px, py]) => [plan.x + px, plan.y + py] as Point);
  }
  return [path[0], ...waypoints, path[path.length - 1]];
};

const obstaclePool = (ctx: LintContext, arrow: ExcalidrawElement, geo: ArrowGeometryCache): Obstacle[] => {
  if (geo.pool) {
    return geo.pool;
  }
  const pool: Obstacle[] = [];
  for (const element of geo.candidates.obstacles) {
    const bounds = ctx.bounds(element);
    if (!exemptObstacle(arrow, geo.path, geo.bounds, element, bounds, geo.exempt)) {
      pool.push({ id: element.id, shape: element, bounds });
    }
  }
  geo.pool = pool;
  return pool;
};

type Detour = { waypoints: Point[]; clearsAll: boolean };

const detourCandidates = (
  path: readonly Point[],
  bounds: Bounds,
  margin: number,
  crossing: readonly number[],
): Point[][] => {
  const [x1, y1, x2, y2] = bounds;
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  const around: Point[] = [
    [x1 - margin, cy],
    [x2 + margin, cy],
    [cx, y1 - margin],
    [cx, y2 + margin],
    [x1 - margin, y1 - margin],
    [x2 + margin, y1 - margin],
    [x2 + margin, y2 + margin],
    [x1 - margin, y2 + margin],
  ];
  const orthogonal = (a: Point, b: Point): Point[][] => [
    [
      [a[0], y1 - margin],
      [b[0], y1 - margin],
    ],
    [
      [a[0], y2 + margin],
      [b[0], y2 + margin],
    ],
    [
      [x1 - margin, a[1]],
      [x1 - margin, b[1]],
    ],
    [
      [x2 + margin, a[1]],
      [x2 + margin, b[1]],
    ],
  ];
  const inner = path.slice(1, -1);
  const start = path[0];
  const end = path[path.length - 1];
  const candidates: Point[][] = [];
  for (const point of around) {
    candidates.push([point]);
  }
  candidates.push(...orthogonal(start, end));
  for (const i of crossing) {
    const before = inner.slice(0, i);
    const after = inner.slice(i);
    for (const point of around) {
      candidates.push([...before, point, ...after]);
    }
    for (const pair of orthogonal(path[i], path[i + 1])) {
      candidates.push([...before, ...pair, ...after]);
    }
  }
  const seen = new Set<string>();
  return candidates
    .map((waypoints) => waypoints.map(roundPoint))
    .filter((waypoints) => {
      const key = JSON.stringify(waypoints);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
};

// Best detour around `target`: it must keep `clearance` px off the target;
// among those, fewest other crossings, then shortest.
const planDetour = (
  ctx: LintContext,
  arrow: ExcalidrawElement,
  geo: ArrowGeometryCache,
  target: ExcalidrawElement,
  targetBounds: Bounds,
  margin: number,
  clearance: number,
): Detour | null => {
  const crossing: number[] = [];
  const inflatedTarget = inflateElement(target, clearance);
  for (let i = 0; i < geo.path.length - 1; i++) {
    if (segmentElementOverlap(inflatedTarget, geo.path[i], geo.path[i + 1]) > 0) {
      crossing.push(i);
    }
  }
  const pool = obstaclePool(ctx, arrow, geo);
  let best: { waypoints: Point[]; others: number; length: number } | null = null;
  for (const waypoints of detourCandidates(geo.path, targetBounds, margin, crossing)) {
    const path = plannedPath(ctx, arrow, geo.path, waypoints);
    if (chordThrough(inflatedTarget, path) > 0) {
      continue;
    }
    const extent = expandBounds(pathBounds(path), 1);
    let others = 0;
    for (const obstacle of pool) {
      if (obstacle.id === target.id || !boundsIntersect(obstacle.bounds, extent)) {
        continue;
      }
      if (chordThrough(obstacle.shape, path) >= CROSSING_MIN_CHORD) {
        others++;
      }
    }
    const length = pathLength(path);
    if (
      !best ||
      others < best.others ||
      (others === best.others && length < best.length - 0.5)
    ) {
      best = { waypoints, others, length };
    }
  }
  return best ? { waypoints: best.waypoints, clearsAll: best.others === 0 } : null;
};

const detourSuggestion = (arrow: ExcalidrawElement, detour: Detour | null, what: string) =>
  detour
    ? updateSuggestion(
        [{ id: arrow.id, waypoints: detour.waypoints }],
        detour.clearsAll ? "safe" : "review",
        detour.clearsAll
          ? `Routes around ${what}; bindings are kept.`
          : `Routes around ${what}; the new path still touches another shape.`,
      )
    : reasonSuggestion(
        `No one- or two-waypoint detour clears ${what}; move the shapes apart or route the arrow by hand with waypoints.`,
      );

// ---- per-arrow rules ------------------------------------------------------

const lengthRules = (ctx: LintContext, arrow: ExcalidrawElement, path: Point[]): boolean => {
  const bounds = ctx.bounds(arrow);
  const points = asLinear(arrow).points;
  const zero =
    (bounds[2] - bounds[0] === 0 && bounds[3] - bounds[1] === 0) ||
    !Array.isArray(points) ||
    points.length < 2;
  if (zero) {
    if (ctx.on("arrow_zero_length")) {
      const linear = asLinear(arrow);
      const from = linear.startBinding?.elementId;
      const to = linear.endBinding?.elementId;
      ctx.emit({
        code: "arrow_zero_length",
        severity: "warning",
        elementIds: [arrow.id],
        message: `${arrow.type} has zero length and will not be visible.`,
        suggestion:
          from && to && from !== to && ctx.byId.has(from) && ctx.byId.has(to)
            ? updateSuggestion([{ id: arrow.id, fromId: from, toId: to }], "review", "Re-binding both ends recomputes the path.")
            : deleteSuggestion([arrow.id], "review"),
      });
    }
    return true;
  }
  if (!ctx.on("arrow_degenerate_segment")) {
    return false;
  }
  const short: number[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    if (Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]) < MIN_SEGMENT) {
      short.push(i);
    }
  }
  if (!short.length) {
    return false;
  }
  const lengths = short.map((i) =>
    Math.round(Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1])),
  );
  if (path.length === 2) {
    const bound = !!(asLinear(arrow).startBinding || asLinear(arrow).endBinding);
    ctx.emit({
      code: "arrow_degenerate_segment",
      severity: "warning",
      elementIds: [arrow.id],
      kind: "arrow",
      message: `${arrow.type} is only ${lengths[0]}px long; its arrowhead swallows the line.`,
      suggestion: bound
        ? reasonSuggestion("Move the connected shapes further apart (move_elements) so the arrow gets room, or delete it.")
        : deleteSuggestion([arrow.id], "review"),
    });
    return false;
  }
  // Drop the inner point of each short segment so its neighbours merge.
  const dropped = new Set<number>();
  for (const i of short) {
    if (i + 1 <= path.length - 2) {
      dropped.add(i + 1);
    } else if (i >= 1) {
      dropped.add(i);
    }
  }
  const waypoints = path
    .slice(1, -1)
    .filter((_, k) => !dropped.has(k + 1))
    .map(roundPoint);
  ctx.emit({
    code: "arrow_degenerate_segment",
    severity: "warning",
    elementIds: [arrow.id],
    kind: "segment",
    message: `${arrow.type} has ${short.length === 1 ? "a segment" : `${short.length} segments`} shorter than ${MIN_SEGMENT}px (${lengths.join(", ")}px): a stub or a jog that reads as a glitch.`,
    suggestion: updateSuggestion([{ id: arrow.id, waypoints }], "review", "Removes the bend points of the short segments."),
  });
  return false;
};

const deepInside = (shape: ExcalidrawElement, point: Point): boolean =>
  (shape.width || 0) > DEEP_INSIDE * 2 &&
  (shape.height || 0) > DEEP_INSIDE * 2 &&
  pointInElement(inflateElement(shape, -DEEP_INSIDE), point[0], point[1]);

const endpointRules = (
  ctx: LintContext,
  arrow: ExcalidrawElement,
  path: Point[],
  candidates: Candidates,
): Set<Side> => {
  const inside = new Set<Side>();
  const arrowBounds = ctx.bounds(arrow);
  if (ctx.on("arrow_endpoint_inside_node")) {
    const shapes = partnersOf(ctx, arrow, candidates.nodes, candidates.scopedNodes);
    for (const side of ["start", "end"] as const) {
      const point = endpoint(path, side);
      const binding = bindingOf(arrow, side);
      const boundTarget = binding ? ctx.byId.get(binding.elementId) : undefined;
      let hit: ExcalidrawElement | null = null;
      for (const shape of shapes) {
        const bounds = ctx.bounds(shape);
        if (boundsContain(bounds, arrowBounds) || !deepInside(shape, point)) {
          continue;
        }
        if (binding?.elementId === shape.id && binding.mode === "inside") {
          continue;
        }
        if (boundTarget && boundTarget.id !== shape.id && boundsContain(bounds, ctx.bounds(boundTarget))) {
          continue;
        }
        const area = (bounds[2] - bounds[0]) * (bounds[3] - bounds[1]);
        if (!hit || area < (ctx.bounds(hit)[2] - ctx.bounds(hit)[0]) * (ctx.bounds(hit)[3] - ctx.bounds(hit)[1])) {
          hit = shape;
        }
      }
      if (!hit) {
        continue;
      }
      inside.add(side);
      const field = endpointField(side);
      ctx.emit({
        code: "arrow_endpoint_inside_node",
        severity: "warning",
        elementIds: [arrow.id, hit.id],
        kind: side,
        message: binding
          ? binding.elementId === hit.id
            ? `${side} of the ${arrow.type} is bound to ${hit.id} but its point sits deep inside it: the stored geometry is stale.`
            : `${side} of the ${arrow.type} is bound to ${binding.elementId} but ends deep inside ${hit.type} ${hit.id}.`
          : `${side} of the ${arrow.type} ends deep inside ${hit.type} ${hit.id} instead of at its edge.`,
        suggestion:
          !binding || binding.elementId === hit.id
            ? updateSuggestion([{ id: arrow.id, [field]: hit.id }], "review", `Binds the ${side} to the edge of ${hit.id}.`)
            : reasonSuggestion(`Decide which shape the ${side} belongs to: rebind it with update_elements {id: "${arrow.id}", ${field}: "…"} or move ${hit.id} away.`),
      });
    }
  }

  if (!ctx.on("arrow_unbound_endpoint") || arrow.type !== "arrow") {
    return inside;
  }
  for (const side of ["start", "end"] as const) {
    if (bindingOf(arrow, side) || inside.has(side) || !hasArrowhead(arrow, side)) {
      continue;
    }
    const point = endpoint(path, side);
    const reach: Bounds = [
      point[0] - MAX_BINDING_DISTANCE,
      point[1] - MAX_BINDING_DISTANCE,
      point[0] + MAX_BINDING_DISTANCE,
      point[1] + MAX_BINDING_DISTANCE,
    ];
    const eligible = (candidate: ExcalidrawElement) =>
      candidate.id !== arrow.id &&
      isBindable(candidate) &&
      candidate.type !== "text" &&
      !isFrameLike(candidate);
    // Out of scope: only pay for the full nearest search when a scoped shape
    // is within binding range at all.
    if (
      ctx.scope &&
      !ctx.scope.has(arrow.id) &&
      !ctx.scoped.some((c) => eligible(c) && distanceToElement(c, point[0], point[1]) <= MAX_BINDING_DISTANCE)
    ) {
      continue;
    }
    let nearest: { element: ExcalidrawElement; distance: number } | null = null;
    for (const candidate of ctx.live) {
      if (!eligible(candidate) || !boundsIntersect(ctx.bounds(candidate), reach)) {
        continue;
      }
      const distance = distanceToElement(candidate, point[0], point[1]);
      if (!nearest || distance < nearest.distance) {
        nearest = { element: candidate, distance };
      }
    }
    if (!nearest || nearest.distance > MAX_BINDING_DISTANCE) {
      continue;
    }
    const touching = nearest.distance <= bindingGap(nearest.element) + 1;
    ctx.emit({
      code: "arrow_unbound_endpoint",
      severity: touching ? "warning" : "info",
      elementIds: [arrow.id, nearest.element.id],
      kind: side,
      message: touching
        ? `${side} arrowhead touches ${nearest.element.id} but is not bound; it will not stay attached when that shape moves.`
        : `${side} arrowhead is within binding range of ${nearest.element.id} but not bound.`,
      suggestion: updateSuggestion(
        [{ id: arrow.id, [endpointField(side)]: nearest.element.id }],
        touching ? "safe" : "review",
      ),
    });
  }
  return inside;
};

const crossingRules = (
  ctx: LintContext,
  arrow: ExcalidrawElement,
  geo: ArrowGeometryCache,
): void => {
  const crossesOn = ctx.on("arrow_crosses_element");
  const grazesOn = ctx.on("arrow_grazes_element");
  const textOn = ctx.on("arrow_crosses_text");
  if (!crossesOn && !grazesOn && !textOn) {
    return;
  }
  const crossed = new Set<string>();
  const reach = expandBounds(geo.bounds, GRAZE_DISTANCE + 1);
  for (const obstacle of partnersOf(ctx, arrow, geo.candidates.obstacles, geo.candidates.scopedObstacles)) {
    const bounds = ctx.bounds(obstacle);
    if (!boundsIntersect(bounds, reach) || exemptObstacle(arrow, geo.path, geo.bounds, obstacle, bounds, geo.exempt)) {
      continue;
    }
    const chord = chordThrough(obstacle, geo.path);
    if (chord >= CROSSING_MIN_CHORD) {
      crossed.add(obstacle.id);
      if (crossesOn) {
        const margin = bindingGap(obstacle) + REROUTE_MARGIN;
        const detour = planDetour(ctx, arrow, geo, obstacle, bounds, margin, DETOUR_CLEARANCE);
        ctx.emit({
          code: "arrow_crosses_element",
          severity: "warning",
          elementIds: [arrow.id, obstacle.id],
          message: `${arrow.type} runs through ${obstacle.type} ${obstacle.id} for ~${Math.round(chord)}px; route it around instead of across.`,
          suggestion: detourSuggestion(arrow, detour, obstacle.id),
        });
      }
      continue;
    }
    if (grazesOn && chordThrough(inflateElement(obstacle, GRAZE_DISTANCE), geo.path) >= CROSSING_MIN_CHORD) {
      const detour = planDetour(ctx, arrow, geo, obstacle, bounds, bindingGap(obstacle) + REROUTE_MARGIN, GRAZE_DISTANCE);
      ctx.emit({
        code: "arrow_grazes_element",
        severity: "info",
        elementIds: [arrow.id, obstacle.id],
        message: `${arrow.type} passes within ${GRAZE_DISTANCE}px of ${obstacle.type} ${obstacle.id}; it reads as touching it.`,
        suggestion: detourSuggestion(arrow, detour, obstacle.id),
      });
    }
  }

  if (!textOn) {
    return;
  }
  const hasLabel = !!ctx.textsByContainer.get(arrow.id)?.length;
  for (const text of partnersOf(ctx, arrow, geo.candidates.texts, geo.candidates.scopedTexts)) {
    const containerId = containerIdOf(text);
    if (
      geo.exempt.has(text.id) ||
      (containerId && (geo.exempt.has(containerId) || crossed.has(containerId))) ||
      sharesGroup(text, arrow)
    ) {
      continue;
    }
    const container = containerId ? ctx.byId.get(containerId) : undefined;
    if (containerId && !container) {
      continue;
    }
    const box = container && !container.angle
      ? layoutLabelIn(container, text).box
      : container
        ? ctx.bounds(text)
        : standaloneTextBox(text);
    if (!boundsIntersect(box, geo.bounds) || boundsContain(box, geo.bounds)) {
      continue;
    }
    const rect = syntheticRect(box, text.id);
    if (
      pointInElement(rect, geo.path[0][0], geo.path[0][1]) ||
      pointInElement(rect, geo.path[geo.path.length - 1][0], geo.path[geo.path.length - 1][1])
    ) {
      continue;
    }
    const chord = chordThrough(rect, geo.path);
    if (chord < CROSSING_MIN_CHORD) {
      continue;
    }
    const detour = planDetour(ctx, arrow, geo, rect, box, TEXT_REROUTE_MARGIN, DETOUR_CLEARANCE);
    const center: Point = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
    // A free text sitting on an unlabelled arrow is almost always its label
    // drawn by hand (or by the old create_diagram): bind it instead.
    const likelyLabel =
      !container && !hasLabel && arrow.type === "arrow" && distanceToPath(center, geo.path) <= LABEL_FAR;
    ctx.emit({
      code: "arrow_crosses_text",
      severity: "warning",
      elementIds: container ? [arrow.id, text.id, container.id] : [arrow.id, text.id],
      message: likelyLabel
        ? `${arrow.type} runs through the free text "${truncate(textContent(text))}", which looks like its label but is not bound to it.`
        : `${arrow.type} runs through the text "${truncate(textContent(text))}" for ~${Math.round(chord)}px.`,
      suggestion: likelyLabel
        ? updateSuggestion([{ id: text.id, containerId: arrow.id }], "review", "Binds the text as the arrow's label, so the client places it on the line.")
        : detourSuggestion(arrow, detour, `the text ${text.id}`),
      ...(likelyLabel ? { alternative: detourSuggestion(arrow, detour, `the text ${text.id}`) } : {}),
    });
  }
};

const truncate = (value: string, max = 30): string => {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const isAxisAligned = (a: Point, b: Point): boolean =>
  Math.abs(a[0] - b[0]) <= AXIS_TOLERANCE || Math.abs(a[1] - b[1]) <= AXIS_TOLERANCE;

const diagonalRule = (ctx: LintContext, arrow: ExcalidrawElement, path: Point[]): void => {
  if (!ctx.on("arrow_diagonal_segment") || path.length < 3) {
    return;
  }
  const diagonal: number[] = [];
  let aligned = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i];
    const b = path[i + 1];
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < MIN_SEGMENT) {
      continue;
    }
    if (isAxisAligned(a, b)) {
      aligned++;
    } else {
      diagonal.push(i);
    }
  }
  if (!diagonal.length || !aligned) {
    return;
  }
  const horizontal = (i: number): boolean | null => {
    if (i < 0 || i >= path.length - 1) {
      return null;
    }
    const [a, b] = [path[i], path[i + 1]];
    if (!isAxisAligned(a, b)) {
      return null;
    }
    return Math.abs(a[1] - b[1]) <= AXIS_TOLERANCE;
  };
  // Replace each diagonal a→b by an elbow that keeps the path alternating.
  const result: Point[] = [path[0]];
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i];
    const b = path[i + 1];
    if (diagonal.includes(i)) {
      // Leave a on the axis the previous run did not use; with no previous
      // run, arrive at b on the axis the next run does not use.
      const previous = horizontal(i - 1);
      const verticalFirst = previous !== null ? previous : horizontal(i + 1) === false;
      result.push(verticalFirst ? [a[0], b[1]] : [b[0], a[1]]);
    }
    result.push(b);
  }
  ctx.emit({
    code: "arrow_diagonal_segment",
    severity: "info",
    elementIds: [arrow.id],
    message: `${arrow.type} mixes ${diagonal.length} diagonal segment${diagonal.length > 1 ? "s" : ""} into an otherwise orthogonal path.`,
    suggestion: updateSuggestion(
      [{ id: arrow.id, waypoints: result.slice(1, -1).map(roundPoint) }],
      "review",
      "Turns each diagonal into an elbow.",
    ),
  });
};

const labelFarRules = (ctx: LintContext): void => {
  if (!ctx.on("arrow_label_far")) {
    return;
  }
  for (const text of ctx.live) {
    if (text.type !== "text" || !textContent(text).trim()) {
      continue;
    }
    const containerId = containerIdOf(text);
    if (containerId) {
      const arrow = ctx.byId.get(containerId);
      if (!arrow || !isLinear(arrow)) {
        continue;
      }
      const center: Point = [text.x + (text.width || 0) / 2, text.y + (text.height || 0) / 2];
      const distance = distanceToPath(center, globalLinearPoints(arrow));
      if (distance > LABEL_FAR) {
        ctx.emit({
          code: "arrow_label_far",
          severity: "warning",
          elementIds: [text.id, arrow.id],
          kind: "bound",
          message: `Label of ${arrow.id} sits ${Math.round(distance)}px away from its line; the client will snap it back to the middle of the arrow.`,
          suggestion: repairSuggestion("arrow_label_far", [text.id, arrow.id]),
        });
      }
      continue;
    }
    if (!(text.groupIds ?? []).length) {
      continue;
    }
    const arrows = new Map<string, ExcalidrawElement>();
    for (const groupId of text.groupIds) {
      for (const member of ctx.groupMembers.get(groupId) ?? []) {
        if (member.type === "arrow" && isConnector(member)) {
          arrows.set(member.id, member);
        }
      }
    }
    if (arrows.size !== 1) {
      continue;
    }
    const [arrow] = arrows.values();
    if (ctx.textsByContainer.get(arrow.id)?.length) {
      continue;
    }
    const box = standaloneTextBox(text);
    const center: Point = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
    const distance = distanceToPath(center, globalLinearPoints(arrow));
    if (distance > FREE_LABEL_RANGE) {
      continue;
    }
    ctx.emit({
      code: "arrow_label_far",
      severity: distance > LABEL_FAR ? "warning" : "info",
      elementIds: [text.id, arrow.id],
      kind: "free",
      message: `Free text grouped with ${arrow.id} acts as its label (${Math.round(distance)}px from the line) but is not bound; it will not follow the arrow.`,
      suggestion: updateSuggestion([{ id: text.id, containerId: arrow.id }], "review", "Binds the text as the arrow's label."),
    });
  }
};

// ---- rules over several arrows -------------------------------------------

type Tip = { arrow: ExcalidrawElement; side: Side; point: Point };
type BoxSide = "top" | "right" | "bottom" | "left";

const boxSideOf = (bounds: Bounds, point: Point): BoxSide => {
  const distances: Array<[BoxSide, number]> = [
    ["left", Math.abs(point[0] - bounds[0])],
    ["right", Math.abs(bounds[2] - point[0])],
    ["top", Math.abs(point[1] - bounds[1])],
    ["bottom", Math.abs(bounds[3] - point[1])],
  ];
  return distances.reduce((best, next) => (next[1] < best[1] ? next : best))[0];
};

const convergeRule = (ctx: LintContext): void => {
  if (!ctx.on("arrowheads_converge")) {
    return;
  }
  for (const [targetId, arrows] of ctx.arrowsBoundTo) {
    const target = ctx.byId.get(targetId);
    if (!target || arrows.length < 2) {
      continue;
    }
    if (ctx.scope && !ctx.scope.has(targetId) && !arrows.some((arrow) => ctx.scope!.has(arrow.id))) {
      continue;
    }
    const bounds = ctx.bounds(target);
    const bySide = new Map<BoxSide, Tip[]>();
    for (const arrow of arrows) {
      if (!isConnector(arrow)) {
        continue;
      }
      const path = globalLinearPoints(arrow);
      for (const side of ["start", "end"] as const) {
        const binding = bindingOf(arrow, side);
        if (binding?.elementId !== targetId || binding.mode === "inside" || !hasArrowhead(arrow, side)) {
          continue;
        }
        const point = endpoint(path, side);
        const boxSide = boxSideOf(bounds, point);
        const list = bySide.get(boxSide) ?? [];
        list.push({ arrow, side, point });
        bySide.set(boxSide, list);
      }
    }
    for (const [boxSide, tips] of bySide) {
      if (tips.length < 2) {
        continue;
      }
      const along = (tip: Tip) => (boxSide === "top" || boxSide === "bottom" ? tip.point[0] : tip.point[1]);
      tips.sort((a, b) => along(a) - along(b));
      let closest = Infinity;
      for (let i = 0; i < tips.length - 1; i++) {
        closest = Math.min(
          closest,
          Math.hypot(tips[i + 1].point[0] - tips[i].point[0], tips[i + 1].point[1] - tips[i].point[1]),
        );
      }
      if (closest >= CONVERGE_DISTANCE) {
        continue;
      }
      const patches = tips.map((tip, i) => ({
        id: tip.arrow.id,
        [tip.side === "start" ? "startAnchor" : "endAnchor"]: {
          side: boxSide,
          at: Math.round(((i + 1) / (tips.length + 1)) * 100) / 100,
        },
      }));
      const merged = new Map<string, Record<string, unknown> & { id: string }>();
      for (const patch of patches) {
        merged.set(patch.id, { ...(merged.get(patch.id) ?? {}), ...patch });
      }
      ctx.emit({
        code: "arrowheads_converge",
        severity: "warning",
        elementIds: [targetId, ...new Set(tips.map((tip) => tip.arrow.id))],
        kind: boxSide,
        message: `${tips.length} arrowheads meet on the ${boxSide} side of ${targetId}, ${Math.round(closest)}px apart; they blur into one.`,
        suggestion: updateSuggestion([...merged.values()], "review", `Spreads the arrowheads evenly along the ${boxSide} side.`),
      });
    }
  }
};

const labelsCollideRule = (ctx: LintContext): void => {
  if (!ctx.on("arrow_labels_collide")) {
    return;
  }
  const labels: Array<{ text: ExcalidrawElement; arrow: ExcalidrawElement; box: Bounds }> = [];
  for (const text of ctx.live) {
    const containerId = containerIdOf(text);
    const arrow = containerId ? ctx.byId.get(containerId) : undefined;
    if (!arrow || !isLinear(arrow) || !textContent(text).trim()) {
      continue;
    }
    labels.push({ text, arrow, box: layoutLabelIn(arrow, text).box });
  }
  const scoped = (entry: (typeof labels)[number]) =>
    !ctx.scope || ctx.scope.has(entry.text.id) || ctx.scope.has(entry.arrow.id);
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      const a = labels[i];
      const b = labels[j];
      if (!scoped(a) && !scoped(b)) {
        continue;
      }
      const overlapX = Math.min(a.box[2], b.box[2]) - Math.max(a.box[0], b.box[0]);
      const overlapY = Math.min(a.box[3], b.box[3]) - Math.max(a.box[1], b.box[1]);
      if (overlapX <= 1 || overlapY <= 1) {
        continue;
      }
      ctx.emit({
        code: "arrow_labels_collide",
        severity: "warning",
        elementIds: [a.text.id, b.text.id, a.arrow.id, b.arrow.id],
        message: `Labels of ${a.arrow.id} and ${b.arrow.id} overlap (${Math.round(overlapX)}×${Math.round(overlapY)}px).`,
        suggestion: shiftLabelSuggestion(b.arrow, b.box, a.box),
      });
    }
  }
};

// A label sits on the middle point (odd count) or the middle segment (even
// count), so moving those points moves the label.
const shiftLabelSuggestion = (arrow: ExcalidrawElement, box: Bounds, other: Bounds) => {
  const { dx, dy } = separationFor(box, other, LABEL_SEPARATION);
  const path = globalLinearPoints(arrow);
  const shift = ([x, y]: Point): Point => [round(x + dx), round(y + dy)];
  let waypoints: Point[];
  if (path.length === 2) {
    const mid = arrowLabelCenter(arrow);
    waypoints = [shift(mid)];
  } else if (path.length % 2 === 1) {
    const k = Math.floor(path.length / 2);
    waypoints = path.slice(1, -1).map((point, i) => (i + 1 === k ? shift(point) : roundPoint(point)));
  } else {
    const k = path.length / 2;
    waypoints = path
      .slice(1, -1)
      .map((point, i) => (i + 1 === k - 1 || i + 1 === k ? shift(point) : roundPoint(point)));
  }
  return updateSuggestion([{ id: arrow.id, waypoints }], "review", "Bends the arrow so its label moves clear.");
};

const arrowsCrossRule = (ctx: LintContext, connectors: readonly ExcalidrawElement[]): void => {
  if (!ctx.on("arrow_crosses_arrow")) {
    return;
  }
  const paths = new Map(connectors.map((arrow) => [arrow.id, globalLinearPoints(arrow)]));
  forEachPair(ctx, connectors, (a, b) => {
    if (!boundsIntersect(ctx.bounds(a), ctx.bounds(b))) {
      return;
    }
    const pa = paths.get(a.id)!;
    const pb = paths.get(b.id)!;
    const ends = [pa[0], pa[pa.length - 1], pb[0], pb[pb.length - 1]];
    let crossings = 0;
    for (let i = 0; i < pa.length - 1; i++) {
      for (let j = 0; j < pb.length - 1; j++) {
        const hit = segmentIntersection(pa[i], pa[i + 1], pb[j], pb[j + 1]);
        if (hit && !ends.some((end) => Math.hypot(end[0] - hit[0], end[1] - hit[1]) <= 3)) {
          crossings++;
        }
      }
    }
    if (!crossings) {
      return;
    }
    ctx.emit({
      code: "arrow_crosses_arrow",
      severity: "info",
      elementIds: [a.id, b.id],
      message: `${a.id} and ${b.id} cross ${crossings === 1 ? "once" : `${crossings} times`}.`,
      suggestion: reasonSuggestion(
        "Crossings are sometimes unavoidable; reorder the nodes or give one arrow waypoints that go around the other's route.",
      ),
    });
  });
};

const isEndpointNode = (element: ExcalidrawElement): boolean => {
  const kind = kindOf(element);
  return SHAPE_TYPES.has(element.type) && !(kind && (NESTING_KINDS.has(kind) || kind === "divider"));
};

const candidatesOf = (ctx: LintContext): Candidates => {
  const scoped = (list: ExcalidrawElement[]) =>
    ctx.scope ? list.filter((element) => ctx.scope!.has(element.id)) : list;
  const obstacles = ctx.live.filter(isShapeObstacle);
  const nodes = ctx.live.filter(isEndpointNode);
  const texts = ctx.live.filter((element) => element.type === "text" && !!textContent(element).trim());
  const scopedTextIds = new Set(ctx.scopedTexts().map((text) => text.id));
  return {
    obstacles,
    scopedObstacles: scoped(obstacles),
    nodes,
    scopedNodes: scoped(nodes),
    texts,
    scopedTexts: texts.filter((text) => scopedTextIds.has(text.id)),
  };
};

export const arrowRules = (ctx: LintContext): void => {
  const connectors: ExcalidrawElement[] = [];
  const candidates = candidatesOf(ctx);
  for (const element of ctx.live) {
    if (!isLinear(element) || isDivider(element)) {
      continue;
    }
    const relevant = ctx.relevant(element);
    const path = globalLinearPoints(element);
    const zero = relevant && lengthRules(ctx, element, path);
    if (!isConnector(element)) {
      continue;
    }
    connectors.push(element);
    if (zero || path.length < 2) {
      continue;
    }
    // Out-of-scope arrows still pair with scoped shapes and texts.
    endpointRules(ctx, element, path, candidates);
    crossingRules(ctx, element, {
      path,
      bounds: ctx.bounds(element),
      exempt: exemptIds(ctx, element),
      candidates,
    });
    if (relevant) {
      diagonalRule(ctx, element, path);
    }
  }
  labelFarRules(ctx);
  convergeRule(ctx);
  labelsCollideRule(ctx);
  arrowsCrossRule(ctx, connectors);
};
