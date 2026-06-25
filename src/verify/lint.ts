import type {ExcalidrawElement} from "../types";
import {
  ARROWHEADS,
  asLinear,
  asText,
  BOUND_TEXT_PADDING,
  type Bounds,
  FILL_STYLES,
  FONT_LINE_HEIGHTS,
  isBindable,
  isLinear,
  isTransparent,
  MAX_BINDING_DISTANCE,
  type Point,
  ROUGHNESS_VALUES,
  STROKE_STYLES,
} from "./model";
import {
  boundsArea,
  boundsContain,
  distanceToElement,
  getCommonBounds,
  getElementBounds,
  intersectionArea,
  pointInElement,
} from "./geometry";
import {bindingGap} from "./bindings";
import {contrastRatio, parseColor} from "./colors";
import {getBoundTextMaxHeight, getBoundTextMaxWidth, measureText, wrapText,} from "./textMetrics";

export type Severity = "error" | "warning" | "info";

export type LintFinding = {
  code: string;
  severity: Severity;
  elementIds: string[];
  message: string;
  suggestion?: Record<string, unknown>;
};

export type LintOptions = {
  disabledRules?: string[];
  viewBackgroundColor?: string;
};

export type LintScopeOptions = LintOptions & {
  ids?: string[];
  region?: Bounds;
  codes?: string[];
  minSeverity?: Severity;
  summaryOnly?: boolean;
};

const SEVERITY_RANK: Record<Severity, number> = {
  error: 3,
  warning: 2,
  info: 1,
};

const boundsIntersect = (a: Bounds, b: Bounds): boolean =>
  a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

const scopeIdSet = (
  live: readonly ExcalidrawElement[],
  options: LintScopeOptions,
): Set<string> | null => {
  if (options.ids && options.ids.length) {
    return new Set(options.ids);
  }
  if (options.region) {
    const set = new Set<string>();
    for (const element of live) {
      if (boundsIntersect(getElementBounds(element), options.region)) {
        set.add(element.id);
      }
    }
    return set;
  }
  return null;
};

const OVERLAP_RATIO = 0.15;
const DUP_POS = 1.5;
const DUP_SIZE = 1.5;
const ALIGN_SNAP = 4;
const ALIGN_MIN = 1;
const OPAQUE_OCCLUSION_OPACITY = 90;
const SOLID_BACKING_OPACITY = 60;
const OUTLIER_ABS_GAP = 4000;
const MAX_FONTS = 2;
const MAX_STROKE_COLORS = 6;
const MAX_PAIRWISE_ELEMENTS = 1500;
const MAX_ALIGNMENT_FINDINGS = 25;
const OVERFLOW_EPSILON = 1;

const OVERLAP_TYPES = new Set(["rectangle", "ellipse", "diamond", "image"]);

const notDeleted = (element: ExcalidrawElement): boolean => !element.isDeleted;

const sharesGroup = (a: ExcalidrawElement, b: ExcalidrawElement): boolean => {
  const ga = a.groupIds ?? [];
  const gb = new Set(b.groupIds ?? []);
  return ga.some((id) => gb.has(id));
};

const textContent = (element: ExcalidrawElement): string =>
  typeof asText(element).text === "string" ? (asText(element).text as string) : "";

const fontSizeOf = (element: ExcalidrawElement): number =>
  typeof asText(element).fontSize === "number"
    ? (asText(element).fontSize as number)
    : 20;

const fontFamilyOf = (element: ExcalidrawElement): number | undefined =>
  typeof asText(element).fontFamily === "number"
    ? (asText(element).fontFamily as number)
    : undefined;

const globalEndpoint = (
  arrow: ExcalidrawElement,
  which: "start" | "end",
): Point | null => {
  const points = asLinear(arrow).points;
  if (!Array.isArray(points) || points.length === 0) {
    return null;
  }
  const p = which === "start" ? points[0] : points[points.length - 1];
  return [arrow.x + p[0], arrow.y + p[1]];
};

const overflowChecks = (
  element: ExcalidrawElement,
  byId: Map<string, ExcalidrawElement>,
): LintFinding[] => {
  if (element.type !== "text") {
    return [];
  }
  const text = textContent(element);
  if (!text.trim()) {
    return [];
  }
  const fontSize = fontSizeOf(element);
  const fontFamily = fontFamilyOf(element);
  const containerId = asText(element).containerId;

  if (typeof containerId === "string") {
    const container = byId.get(containerId);
    if (!container) {
      return [];
    }
    const isArrowLabel = container.type === "arrow" || container.type === "line";
    const maxWidth = getBoundTextMaxWidth(container, fontSize);
    const wrapped = wrapText(text, fontSize, fontFamily, maxWidth);
    const measured = measureText(wrapped, fontSize, fontFamily);
    const widthOverflow = measured.width > maxWidth + OVERFLOW_EPSILON;
    const maxHeight = isArrowLabel ? 0 : getBoundTextMaxHeight(container);
    const heightOverflow =
      !isArrowLabel && maxHeight > 0 && measured.height > maxHeight + OVERFLOW_EPSILON;
    if (widthOverflow || heightOverflow) {
      const neededHeight =
        Math.ceil(measured.height) + BOUND_TEXT_PADDING * 2;
      return [
        {
          code: "text_overflow",
          severity: "warning",
          elementIds: [element.id, container.id],
          message: `Text does not fit its ${container.type} container (needs ~${Math.ceil(measured.width)} wide, container fits ${Math.round(maxWidth)}).`,
          suggestion: {
            action: "resize",
            id: container.id,
            height: Math.max(container.height || 0, neededHeight),
          },
        },
      ];
    }
    return [];
  }

  if (asText(element).autoResize === false && (element.width || 0) > 0) {
    const wrapped = wrapText(text, fontSize, fontFamily, element.width || 0);
    const measured = measureText(wrapped, fontSize, fontFamily);
    if (measured.height > (element.height || 0) + OVERFLOW_EPSILON) {
      return [
        {
          code: "text_overflow",
          severity: "warning",
          elementIds: [element.id],
          message: `Wrapped text is taller (${Math.ceil(measured.height)}) than the text box height (${Math.round(element.height || 0)}).`,
          suggestion: {
            action: "resize",
            id: element.id,
            height: Math.ceil(measured.height),
          },
        },
      ];
    }
  }
  return [];
};

const structuralChecks = (
  element: ExcalidrawElement,
  byId: Map<string, ExcalidrawElement>,
): LintFinding[] => {
  const findings: LintFinding[] = [];
  const sized = new Set([
    "rectangle",
    "ellipse",
    "diamond",
    "image",
    "frame",
    "magicframe",
    "text",
  ]);

  if (sized.has(element.type) && ((element.width || 0) <= 0 || (element.height || 0) <= 0)) {
    findings.push({
      code: "degenerate_size",
      severity: "error",
      elementIds: [element.id],
      message: `${element.type} has non-positive size (${element.width}×${element.height}).`,
    });
  }

  if (element.type === "text" && !textContent(element).trim()) {
    findings.push({
      code: "empty_text",
      severity: "error",
      elementIds: [element.id],
      message: "Text element has no visible text.",
      suggestion: { action: "delete", id: element.id },
    });
  }

  if ((element.opacity ?? 100) <= 0) {
    findings.push({
      code: "invisible_opacity",
      severity: "warning",
      elementIds: [element.id],
      message: "Element opacity is 0 (invisible).",
    });
  }

  const opacity = element.opacity ?? 100;
  if (opacity < 0 || opacity > 100) {
    findings.push({
      code: "out_of_range",
      severity: "warning",
      elementIds: [element.id],
      message: `opacity ${opacity} is outside 0–100.`,
    });
  }
  if (!ROUGHNESS_VALUES.has(element.roughness)) {
    findings.push({
      code: "out_of_range",
      severity: "warning",
      elementIds: [element.id],
      message: `roughness ${element.roughness} is not one of 0, 1, 2.`,
    });
  }
  if ((element.strokeWidth || 0) <= 0 && !isTransparent(element.strokeColor)) {
    findings.push({
      code: "out_of_range",
      severity: "warning",
      elementIds: [element.id],
      message: "strokeWidth is non-positive.",
    });
  }
  if (element.type === "text" && fontSizeOf(element) <= 0) {
    findings.push({
      code: "out_of_range",
      severity: "warning",
      elementIds: [element.id],
      message: "fontSize is non-positive.",
    });
  }

  if (!FILL_STYLES.has(element.fillStyle)) {
    findings.push({
      code: "invalid_enum",
      severity: "warning",
      elementIds: [element.id],
      message: `Unknown fillStyle "${element.fillStyle}".`,
    });
  }
  if (!STROKE_STYLES.has(element.strokeStyle)) {
    findings.push({
      code: "invalid_enum",
      severity: "warning",
      elementIds: [element.id],
      message: `Unknown strokeStyle "${element.strokeStyle}".`,
    });
  }
  if (element.type === "text") {
    const family = fontFamilyOf(element);
    if (family !== undefined && !(family in FONT_LINE_HEIGHTS)) {
      findings.push({
        code: "invalid_enum",
        severity: "warning",
        elementIds: [element.id],
        message: `Unknown fontFamily ${family}.`,
      });
    }
  }

  if (isLinear(element)) {
    findings.push(...arrowChecks(element, byId));
  }

  findings.push(...overflowChecks(element, byId));
  return findings;
};

const arrowChecks = (
  arrow: ExcalidrawElement,
  byId: Map<string, ExcalidrawElement>,
): LintFinding[] => {
  const findings: LintFinding[] = [];
  const linear = asLinear(arrow);

  const bounds = getElementBounds(arrow);
  const points = linear.points;
  const zeroLength =
    (bounds[2] - bounds[0] === 0 && bounds[3] - bounds[1] === 0) ||
    !Array.isArray(points) ||
    points.length < 2;
  if (zeroLength) {
    findings.push({
      code: "arrow_zero_length",
      severity: "warning",
      elementIds: [arrow.id],
      message: `${arrow.type} has zero length and will not be visible.`,
    });
  }

  for (const arrowhead of [linear.startArrowhead, linear.endArrowhead]) {
    if (arrowhead && !ARROWHEADS.has(arrowhead)) {
      findings.push({
        code: "invalid_enum",
        severity: "warning",
        elementIds: [arrow.id],
        message: `Unknown arrowhead "${arrowhead}".`,
      });
    }
  }

  const sides: Array<["start" | "end", typeof linear.startBinding]> = [
    ["start", linear.startBinding],
    ["end", linear.endBinding],
  ];

  for (const [side, binding] of sides) {
    if (binding) {
      if (!binding.mode || !binding.fixedPoint) {
        findings.push({
          code: "binding_invalid",
          severity: "error",
          elementIds: [arrow.id],
          message: `${side} binding is missing mode/fixedPoint and will be dropped on load.`,
        });
        continue;
      }
      const target = byId.get(binding.elementId);
      if (!target || target.isDeleted) {
        findings.push({
          code: "arrow_dangling_binding",
          severity: "error",
          elementIds: [arrow.id],
          message: `${side} binding references a missing element (${binding.elementId}).`,
          suggestion: { action: "unbind", id: arrow.id, side },
        });
        continue;
      }
      const backref = Array.isArray(target.boundElements)
        ? target.boundElements.some((entry) => entry.id === arrow.id)
        : false;
      if (!backref) {
        findings.push({
          code: "binding_backref_missing",
          severity: "error",
          elementIds: [arrow.id, target.id],
          message: `${target.type} is missing a boundElements back-reference to this arrow; the arrow will not follow it when moved.`,
          suggestion: { action: "rebind", arrowId: arrow.id, targetId: target.id },
        });
      }
    } else {
      const endpoint = globalEndpoint(arrow, side);
      if (!endpoint) {
        continue;
      }
      let nearest: { id: string; distance: number } | null = null;
      for (const candidate of byId.values()) {
        if (candidate.id === arrow.id || candidate.isDeleted) {
          continue;
        }
        if (!isBindable(candidate) || candidate.type === "text") {
          continue;
        }
        const distance = distanceToElement(candidate, endpoint[0], endpoint[1]);
        if (!nearest || distance < nearest.distance) {
          nearest = { id: candidate.id, distance };
        }
      }
      if (nearest) {
        const target = byId.get(nearest.id);
        const gap = target ? bindingGap(target) + 1 : 6;
        if (nearest.distance <= gap) {
          findings.push({
            code: "arrow_unbound_endpoint",
            severity: "warning",
            elementIds: [arrow.id, nearest.id],
            message: `${side} of the arrow touches an element but is not bound; it will not stay attached when that element moves.`,
            suggestion: { action: "connect", arrowId: arrow.id, side, targetId: nearest.id },
          });
        } else if (nearest.distance <= MAX_BINDING_DISTANCE) {
          findings.push({
            code: "arrow_unbound_endpoint",
            severity: "info",
            elementIds: [arrow.id, nearest.id],
            message: `${side} of the arrow is within binding range of an element but not bound.`,
            suggestion: { action: "connect", arrowId: arrow.id, side, targetId: nearest.id },
          });
        }
      }
    }
  }
  return findings;
};

const staleBackrefChecks = (
  elements: readonly ExcalidrawElement[],
  byId: Map<string, ExcalidrawElement>,
): LintFinding[] => {
  const findings: LintFinding[] = [];
  for (const element of elements) {
    if (!Array.isArray(element.boundElements)) {
      continue;
    }
    for (const entry of element.boundElements) {
      if (entry.type !== "arrow") {
        continue;
      }
      const arrow = byId.get(entry.id);
      if (!arrow || arrow.isDeleted) {
        findings.push({
          code: "binding_backref_missing",
          severity: "error",
          elementIds: [element.id],
          message: `boundElements lists arrow ${entry.id} which no longer exists.`,
          suggestion: { action: "rebind", targetId: element.id, arrowId: entry.id },
        });
        continue;
      }
      const linear = asLinear(arrow);
      const boundHere =
        linear.startBinding?.elementId === element.id ||
        linear.endBinding?.elementId === element.id;
      if (!boundHere) {
        findings.push({
          code: "binding_backref_missing",
          severity: "error",
          elementIds: [element.id, arrow.id],
          message: `${element.type} references arrow ${entry.id} but the arrow has no binding back to it.`,
          suggestion: { action: "rebind", targetId: element.id, arrowId: arrow.id },
        });
      }
    }
  }
  return findings;
};

const isBoundTextOf = (
  text: ExcalidrawElement,
  container: ExcalidrawElement,
): boolean => asText(text).containerId === container.id;

const eligibleForOverlap = (element: ExcalidrawElement): boolean =>
  OVERLAP_TYPES.has(element.type) ||
  (element.type === "text" && typeof asText(element).containerId !== "string");

const isContainedLabel = (
  a: ExcalidrawElement,
  b: ExcalidrawElement,
  aBounds: ReturnType<typeof getElementBounds>,
  bBounds: ReturnType<typeof getElementBounds>,
): boolean => {
  if ((a.type === "text") === (b.type === "text")) {
    return false;
  }
  const [text, shape, textBounds, shapeBounds] =
    a.type === "text" ? [a, b, aBounds, bBounds] : [b, a, bBounds, aBounds];
  return OVERLAP_TYPES.has(shape.type) && boundsContain(shapeBounds, textBounds);
};

const pairwiseChecks = (
  elements: readonly ExcalidrawElement[],
): LintFinding[] => {
  const findings: LintFinding[] = [];
  const overlapCandidates = elements.filter(eligibleForOverlap);
  const boundsById = new Map<string, ReturnType<typeof getElementBounds>>();
  for (const element of elements) {
    boundsById.set(element.id, getElementBounds(element));
  }

  let alignmentCount = 0;

  for (let i = 0; i < overlapCandidates.length; i++) {
    for (let j = i + 1; j < overlapCandidates.length; j++) {
      const a = overlapCandidates[i];
      const b = overlapCandidates[j];
      if (sharesGroup(a, b)) {
        continue;
      }
      if (a.frameId === b.id || b.frameId === a.id) {
        continue;
      }
      if (isBoundTextOf(a, b) || isBoundTextOf(b, a)) {
        continue;
      }
      const ba = boundsById.get(a.id)!;
      const bb = boundsById.get(b.id)!;
      const inter = intersectionArea(ba, bb);
      if (inter > 0 && !isContainedLabel(a, b, ba, bb)) {
        const ratio = inter / Math.max(1, Math.min(boundsArea(ba), boundsArea(bb)));
        if (ratio > OVERLAP_RATIO) {
          findings.push({
            code: "overlap",
            severity: "warning",
            elementIds: [a.id, b.id],
            message: `${a.type} and ${b.type} overlap by ${Math.round(ratio * 100)}% of the smaller element.`,
            suggestion: {
              action: "move",
              id: b.id,
              dx: Math.ceil(ba[2] - bb[0] + 20),
              dy: 0,
            },
          });
        }
      }

      if (
        a.type === b.type &&
        Math.abs(a.x - b.x) <= DUP_POS &&
        Math.abs(a.y - b.y) <= DUP_POS &&
        Math.abs((a.width || 0) - (b.width || 0)) <= DUP_SIZE &&
        Math.abs((a.height || 0) - (b.height || 0)) <= DUP_SIZE &&
        a.strokeColor === b.strokeColor &&
        a.backgroundColor === b.backgroundColor &&
        textContent(a) === textContent(b)
      ) {
        findings.push({
          code: "duplicate",
          severity: "warning",
          elementIds: [a.id, b.id],
          message: `${a.type} appears duplicated (near-identical position, size and style).`,
          suggestion: { action: "delete", id: b.id },
        });
      }

      if (alignmentCount < MAX_ALIGNMENT_FINDINGS) {
        const near = nearMissAlignment(a, b);
        if (near) {
          alignmentCount++;
          findings.push(near);
        }
      }
    }
  }

  findings.push(...occlusionChecks(elements, boundsById));
  return findings;
};

const alignFinding = (
  edge: string,
  label: string,
  diff: number,
  ids: [string, string],
): LintFinding => ({
  code: "alignment_near_miss",
  severity: "info",
  elementIds: ids,
  message: `${label} are ${diff.toFixed(1)}px apart — likely meant to align.`,
  suggestion: { action: "align", edge, ids },
});

// Coords are [edge1, center, edge2]. Edges of differently-sized elements
// diverge by the size difference, so flagging them when the pair is already
// centred is noise: talk about the centre when centres align, edges only when
// centres are far apart.
const nearMissOnAxis = (
  aCoords: readonly number[],
  bCoords: readonly number[],
  edges: readonly string[],
  ids: [string, string],
): LintFinding | null => {
  const diffs = aCoords.map((v, i) => Math.abs(v - bCoords[i]));
  const centerDiff = diffs[1];
  if (centerDiff < ALIGN_MIN) {
    return null;
  }
  if (centerDiff <= ALIGN_SNAP) {
    return alignFinding(edges[1], edges[1], centerDiff, ids);
  }
  const edgeIndices = [0, 2];
  if (edgeIndices.some((k) => diffs[k] < ALIGN_MIN)) {
    return null;
  }
  for (const k of edgeIndices) {
    if (diffs[k] <= ALIGN_SNAP) {
      return alignFinding(edges[k], `${edges[k]} edges`, diffs[k], ids);
    }
  }
  return null;
};

const nearMissAlignment = (
  a: ExcalidrawElement,
  b: ExcalidrawElement,
): LintFinding | null => {
  const ids: [string, string] = [a.id, b.id];
  const horizontal = nearMissOnAxis(
    [a.x, a.x + (a.width || 0) / 2, a.x + (a.width || 0)],
    [b.x, b.x + (b.width || 0) / 2, b.x + (b.width || 0)],
    ["left", "centerX", "right"],
    ids,
  );
  if (horizontal) {
    return horizontal;
  }
  return nearMissOnAxis(
    [a.y, a.y + (a.height || 0) / 2, a.y + (a.height || 0)],
    [b.y, b.y + (b.height || 0) / 2, b.y + (b.height || 0)],
    ["top", "centerY", "bottom"],
    ids,
  );
};

const occlusionChecks = (
  elements: readonly ExcalidrawElement[],
  boundsById: Map<string, ReturnType<typeof getElementBounds>>,
): LintFinding[] => {
  const findings: LintFinding[] = [];
  const order = new Map<string, number>();
  elements.forEach((element, i) => order.set(element.id, i));

  const isAbove = (a: ExcalidrawElement, b: ExcalidrawElement): boolean => {
    if (typeof a.index === "string" && typeof b.index === "string") {
      return a.index > b.index;
    }
    return (order.get(a.id) ?? 0) > (order.get(b.id) ?? 0);
  };

  const opaque = elements.filter(
    (e) =>
      !isTransparent(e.backgroundColor) &&
      e.fillStyle === "solid" &&
      (e.opacity ?? 100) >= OPAQUE_OCCLUSION_OPACITY &&
      OVERLAP_TYPES.has(e.type),
  );
  for (const cover of opaque) {
    for (const under of elements) {
      if (under.id === cover.id || under.isDeleted || isLinear(under)) {
        continue;
      }
      if (under.frameId === cover.id || sharesGroup(cover, under)) {
        continue;
      }
      if (isBoundTextOf(under, cover)) {
        continue;
      }
      if (!isAbove(cover, under)) {
        continue;
      }
      const coverBounds = boundsById.get(cover.id)!;
      const underBounds = boundsById.get(under.id)!;
      if (!boundsContain(coverBounds, underBounds)) {
        continue;
      }
      if (cover.type === "ellipse" || cover.type === "diamond") {
        const corners: Array<[number, number]> = [
          [underBounds[0], underBounds[1]],
          [underBounds[2], underBounds[1]],
          [underBounds[2], underBounds[3]],
          [underBounds[0], underBounds[3]],
        ];
        if (!corners.every(([cx, cy]) => pointInElement(cover, cx, cy))) {
          continue;
        }
      }
      findings.push({
        code: "occlusion",
        severity: "warning",
        elementIds: [cover.id, under.id],
        message: `${cover.type} fully covers ${under.type} on top of it; the lower element is hidden.`,
        suggestion: { action: "send_back", id: cover.id },
      });
    }
  }
  return findings;
};

const outlierChecks = (
  elements: readonly ExcalidrawElement[],
): LintFinding[] => {
  if (elements.length < 3) {
    return [];
  }
  const findings: LintFinding[] = [];
  const bounds = elements.map((e) => getElementBounds(e));
  for (let i = 0; i < elements.length; i++) {
    const common = getCommonBounds(
      elements.filter((_, idx) => idx !== i),
    );
    const me = bounds[i];
    const gapX = Math.max(common[0] - me[2], me[0] - common[2], 0);
    const gapY = Math.max(common[1] - me[3], me[1] - common[3], 0);
    const gap = Math.max(gapX, gapY);
    const diag = Math.hypot(common[2] - common[0], common[3] - common[1]);
    if (gap > Math.max(OUTLIER_ABS_GAP, diag * 2)) {
      findings.push({
        code: "off_canvas_outlier",
        severity: "warning",
        elementIds: [elements[i].id],
        message: `${elements[i].type} is ${Math.round(gap)}px away from every other element; likely misplaced.`,
        suggestion: { action: "review", id: elements[i].id },
      });
    }
  }
  return findings;
};

const isAboveByZ = (
  a: ExcalidrawElement,
  b: ExcalidrawElement,
): boolean =>
  typeof a.index === "string" && typeof b.index === "string"
    ? a.index > b.index
    : false;

const backingColor = (
  text: ExcalidrawElement,
  scene: readonly ExcalidrawElement[],
  boundsById: Map<string, ReturnType<typeof getElementBounds>>,
  fallback: string,
): string => {
  const textBounds = boundsById.get(text.id) ?? getElementBounds(text);
  let best: ExcalidrawElement | null = null;
  for (const candidate of scene) {
    if (
      candidate.id === text.id ||
      !OVERLAP_TYPES.has(candidate.type) ||
      isTransparent(candidate.backgroundColor) ||
      candidate.fillStyle !== "solid" ||
      (candidate.opacity ?? 100) < SOLID_BACKING_OPACITY ||
      !isAboveByZ(text, candidate)
    ) {
      continue;
    }
    const candidateBounds = boundsById.get(candidate.id) ?? getElementBounds(candidate);
    if (!boundsContain(candidateBounds, textBounds)) {
      continue;
    }
    if (!best || (typeof candidate.index === "string" && candidate.index > (best.index ?? ""))) {
      best = candidate;
    }
  }
  return best ? best.backgroundColor : fallback;
};

const contrastChecks = (
  texts: readonly ExcalidrawElement[],
  scene: readonly ExcalidrawElement[],
  viewBackgroundColor: string,
): LintFinding[] => {
  const findings: LintFinding[] = [];
  const boundsById = new Map<string, ReturnType<typeof getElementBounds>>();
  for (const element of scene) {
    boundsById.set(element.id, getElementBounds(element));
  }
  for (const element of texts) {
    if (element.type !== "text" || !textContent(element).trim()) {
      continue;
    }
    const fg = parseColor(element.strokeColor);
    if (!fg) {
      continue;
    }
    const bg = parseColor(
      backingColor(element, scene, boundsById, viewBackgroundColor),
    );
    if (!bg) {
      continue;
    }
    const ratio = contrastRatio(fg, bg);
    const threshold = fontSizeOf(element) >= 24 ? 3 : 4.5;
    if (ratio < threshold) {
      findings.push({
        code: "low_contrast",
        severity: "warning",
        elementIds: [element.id],
        message: `Text contrast ${ratio.toFixed(2)}:1 against its background is below the ${threshold}:1 readability threshold.`,
        suggestion: { action: "recolor", id: element.id },
      });
    }
  }
  return findings;
};

const styleChecks = (
  elements: readonly ExcalidrawElement[],
): LintFinding[] => {
  const findings: LintFinding[] = [];
  const texts = elements.filter((e) => e.type === "text");
  const fonts = new Set(texts.map((e) => fontFamilyOf(e) ?? 5));
  if (fonts.size > MAX_FONTS) {
    findings.push({
      code: "style_many_fonts",
      severity: "info",
      elementIds: texts.map((e) => e.id),
      message: `${fonts.size} different font families are used; consider unifying for a consistent look.`,
    });
  }
  const strokes = new Set(
    elements
      .filter((e) => !isTransparent(e.strokeColor))
      .map((e) => e.strokeColor),
  );
  if (strokes.size > MAX_STROKE_COLORS) {
    findings.push({
      code: "style_many_stroke_colors",
      severity: "info",
      elementIds: [],
      message: `${strokes.size} distinct stroke colors are used; a tighter palette usually reads better.`,
    });
  }
  return findings;
};

export const buildConnectivityGraph = (
  elements: readonly ExcalidrawElement[],
): { nodeCount: number; edgeCount: number; isolated: string[] } => {
  const nodes = elements.filter(
    (e) => isBindable(e) && e.type !== "text",
  );
  const nodeIds = new Set(nodes.map((e) => e.id));
  const connected = new Set<string>();
  let edgeCount = 0;
  for (const element of elements) {
    if (!isLinear(element)) {
      continue;
    }
    const linear = asLinear(element);
    const from = linear.startBinding?.elementId;
    const to = linear.endBinding?.elementId;
    if (from && to && nodeIds.has(from) && nodeIds.has(to)) {
      edgeCount++;
      connected.add(from);
      connected.add(to);
    }
  }
  return {
    nodeCount: nodes.length,
    edgeCount,
    isolated: nodes.filter((n) => !connected.has(n.id)).map((n) => n.id),
  };
};

export const lintScene = (
  elements: readonly ExcalidrawElement[],
  options: LintScopeOptions = {},
): {
  findings: LintFinding[];
  summary: { errors: number; warnings: number; infos: number };
  graph: { nodeCount: number; edgeCount: number; isolated: string[] };
  scope?: { kind: "ids" | "region"; matched: number };
} => {
  const disabled = new Set(options.disabledRules ?? []);
  const live = elements.filter(notDeleted);
  const byId = new Map(live.map((e) => [e.id, e]));
  const viewBackgroundColor = options.viewBackgroundColor ?? "#ffffff";

  let findings: LintFinding[] = [];
  for (const element of live) {
    findings.push(...structuralChecks(element, byId));
  }
  findings.push(...staleBackrefChecks(live, byId));

  if (live.length <= MAX_PAIRWISE_ELEMENTS) {
    findings.push(...pairwiseChecks(live));
    findings.push(...outlierChecks(live));
  } else {
    findings.push({
      code: "scene_too_large",
      severity: "info",
      elementIds: [],
      message: `Scene has ${live.length} elements; pairwise checks (overlap, duplicate, occlusion, alignment, outlier) were skipped.`,
    });
  }
  findings.push(...contrastChecks(live, live, viewBackgroundColor));
  findings.push(...styleChecks(live));

  findings = findings.filter((f) => !disabled.has(f.code));

  const scope = scopeIdSet(live, options);
  if (scope) {
    findings = findings.filter((f) => f.elementIds.some((id) => scope.has(id)));
  }
  if (options.codes && options.codes.length) {
    const allow = new Set(options.codes);
    findings = findings.filter((f) => allow.has(f.code));
  }
  if (options.minSeverity) {
    const floor = SEVERITY_RANK[options.minSeverity];
    findings = findings.filter((f) => SEVERITY_RANK[f.severity] >= floor);
  }

  const summary = { errors: 0, warnings: 0, infos: 0 };
  for (const finding of findings) {
    if (finding.severity === "error") {
      summary.errors++;
    } else if (finding.severity === "warning") {
      summary.warnings++;
    } else {
      summary.infos++;
    }
  }

  return {
    findings: options.summaryOnly ? [] : findings,
    summary,
    graph: buildConnectivityGraph(live),
    ...(scope
      ? { scope: { kind: options.ids?.length ? "ids" : "region", matched: scope.size } as const }
      : {}),
  };
};

export const lintElement = (
  element: ExcalidrawElement,
  scene: readonly ExcalidrawElement[],
  options: LintOptions = {},
): LintFinding[] => {
  const disabled = new Set(options.disabledRules ?? []);
  const live = scene.filter(notDeleted);
  const byId = new Map(live.map((e) => [e.id, e]));
  byId.set(element.id, element);
  const viewBackgroundColor = options.viewBackgroundColor ?? "#ffffff";

  const findings: LintFinding[] = [];
  findings.push(...structuralChecks(element, byId));

  const myBounds = getElementBounds(element);
  if (eligibleForOverlap(element)) {
    for (const other of live) {
      if (
        other.id === element.id ||
        !eligibleForOverlap(other) ||
        sharesGroup(element, other) ||
        other.frameId === element.id ||
        element.frameId === other.id ||
        isBoundTextOf(element, other) ||
        isBoundTextOf(other, element)
      ) {
        continue;
      }
      const otherBounds = getElementBounds(other);
      const inter = intersectionArea(myBounds, otherBounds);
      if (inter > 0 && !isContainedLabel(element, other, myBounds, otherBounds)) {
        const ratio =
          inter / Math.max(1, Math.min(boundsArea(myBounds), boundsArea(otherBounds)));
        if (ratio > OVERLAP_RATIO) {
          findings.push({
            code: "overlap",
            severity: "warning",
            elementIds: [element.id, other.id],
            message: `Overlaps ${other.type} by ${Math.round(ratio * 100)}% of the smaller element.`,
            suggestion: { action: "move", id: element.id },
          });
        }
      }
    }
  }

  findings.push(...contrastChecks([element], [...byId.values()], viewBackgroundColor));
  return findings.filter((f) => !disabled.has(f.code));
};
