import type {ExcalidrawElement} from "../types";
import type {Suggestion} from "../toolSchemas";
import type {BoardProfile} from "../profile";
import {type ElementKind, kindOf, tableRefOf} from "../customData";
import {
    asLinear,
    asText,
    BOUND_TEXT_PADDING,
    type Bounds,
    DEFAULT_FONT_FAMILY,
    DEFAULT_FONT_SIZE,
    isLinear,
    isTransparent,
    type Point,
} from "./model";
import {getElementBounds, globalLinearPoints} from "./geometry";
import {getBoundTextMaxHeight, getBoundTextMaxWidth, measureText, normalizeText, wrapText,} from "./textMetrics";
import type {Severity} from "./lintProfiles";
import {arrowLabelAnchor, containerCoords} from "../engine/boundText";

export type LintFinding = {
  code: string;
  severity: Severity;
  elementIds: string[];
  message: string;
  // Sub-classification of a code, e.g. text_overflow "tight" | "overflow" or
  // the anchor of an alignment_near_miss. Part of findingKey.
  kind?: string;
  suggestion?: Suggestion;
  alternative?: Suggestion;
  details?: Record<string, unknown>;
};

export type LintContext = {
  live: ExcalidrawElement[];
  byId: Map<string, ExcalidrawElement>;
  // Includes tombstones, so integrity rules can say "deleted" vs "missing".
  anyById: Map<string, ExcalidrawElement>;
  order: Map<string, number>;
  scope: Set<string> | null;
  scoped: ExcalidrawElement[];
  minPadding: number;
  viewBackgroundColor: string;
  stored?: readonly ExcalidrawElement[];
  // The board/series style contract; the rules flagged needsProfile only run
  // when it is here.
  boardProfile?: BoardProfile;
  frameChildren: Map<string, ExcalidrawElement[]>;
  groupMembers: Map<string, ExcalidrawElement[]>;
  arrowsBoundTo: Map<string, ExcalidrawElement[]>;
  textsByContainer: Map<string, ExcalidrawElement[]>;
  on: (code: string) => boolean;
  inScope: (id: string) => boolean;
  // The element or one of its direct references (container, binding target,
  // boundElements entry) is in scope: only then can its per-element findings
  // touch the scope, so everything else is skipped on scoped runs.
  relevant: (element: ExcalidrawElement) => boolean;
  bounds: (element: ExcalidrawElement) => Bounds;
  labelOf: (container: ExcalidrawElement) => ExcalidrawElement | undefined;
  // Texts whose findings can touch the scope: scoped texts and the labels of
  // scoped containers.
  scopedTexts: () => ExcalidrawElement[];
  emit: (finding: LintFinding) => void;
};

const push = <K, V>(map: Map<K, V[]>, key: K, value: V): void => {
  const list = map.get(key);
  if (list) {
    list.push(value);
  } else {
    map.set(key, [value]);
  }
};

export const buildLintContext = (
  elements: readonly ExcalidrawElement[],
  options: {
    scope: Set<string> | null;
    active: Set<string>;
    minPadding: number;
    viewBackgroundColor: string;
    stored?: readonly ExcalidrawElement[];
    boardProfile?: BoardProfile;
    sink: LintFinding[];
  },
): LintContext => {
  const live = elements.filter((element) => !element.isDeleted);
  const byId = new Map(live.map((element) => [element.id, element]));
  const anyById = new Map(elements.map((element) => [element.id, element]));
  const order = new Map(live.map((element, i) => [element.id, i]));
  const frameChildren = new Map<string, ExcalidrawElement[]>();
  const groupMembers = new Map<string, ExcalidrawElement[]>();
  const arrowsBoundTo = new Map<string, ExcalidrawElement[]>();
  const textsByContainer = new Map<string, ExcalidrawElement[]>();
  for (const element of live) {
    if (typeof element.frameId === "string") {
      push(frameChildren, element.frameId, element);
    }
    for (const groupId of element.groupIds ?? []) {
      push(groupMembers, groupId, element);
    }
    if (isLinear(element)) {
      const linear = asLinear(element);
      const targets = new Set(
        [linear.startBinding?.elementId, linear.endBinding?.elementId].filter(
          (id): id is string => typeof id === "string",
        ),
      );
      for (const target of targets) {
        push(arrowsBoundTo, target, element);
      }
    }
    const containerId = asText(element).containerId;
    if (element.type === "text" && typeof containerId === "string") {
      push(textsByContainer, containerId, element);
    }
  }
  const boundsCache = new Map<string, Bounds>();
  const { scope } = options;
  let scopedTexts: ExcalidrawElement[] | undefined;
  return {
    live,
    byId,
    anyById,
    order,
    scope,
    scoped: scope ? live.filter((element) => scope.has(element.id)) : live,
    minPadding: options.minPadding,
    viewBackgroundColor: options.viewBackgroundColor,
    stored: options.stored,
    ...(options.boardProfile ? { boardProfile: options.boardProfile } : {}),
    frameChildren,
    groupMembers,
    arrowsBoundTo,
    textsByContainer,
    on: (code) => options.active.has(code),
    inScope: (id) => !scope || scope.has(id),
    relevant: (element) => {
      if (!scope || scope.has(element.id)) {
        return true;
      }
      const containerId = asText(element).containerId;
      if (typeof containerId === "string" && scope.has(containerId)) {
        return true;
      }
      if (isLinear(element)) {
        const linear = asLinear(element);
        if (
          (linear.startBinding && scope.has(linear.startBinding.elementId)) ||
          (linear.endBinding && scope.has(linear.endBinding.elementId))
        ) {
          return true;
        }
      }
      return (element.boundElements ?? []).some((entry) => scope.has(entry.id));
    },
    bounds: (element) => {
      let cached = boundsCache.get(element.id);
      if (!cached) {
        cached = getElementBounds(element);
        boundsCache.set(element.id, cached);
      }
      return cached;
    },
    labelOf: (container) => {
      const texts = textsByContainer.get(container.id);
      if (!texts?.length) {
        return undefined;
      }
      const listed = new Set((container.boundElements ?? []).map((entry) => entry.id));
      return texts.find((text) => listed.has(text.id)) ?? texts[0];
    },
    scopedTexts: () => {
      scopedTexts ??= live.filter((element) => {
        if (element.type !== "text") {
          return false;
        }
        if (!scope || scope.has(element.id)) {
          return true;
        }
        const containerId = asText(element).containerId;
        return typeof containerId === "string" && scope.has(containerId);
      });
      return scopedTexts;
    },
    emit: (finding) => {
      options.sink.push(finding);
    },
  };
};

// Pairs (a, b) with a before b in z-order; with a scope only pairs touching it,
// so a scoped run costs O(n·k) instead of O(n²).
export const forEachPair = (
  ctx: LintContext,
  candidates: readonly ExcalidrawElement[],
  visit: (a: ExcalidrawElement, b: ExcalidrawElement) => void,
): void => {
  const rank = (element: ExcalidrawElement) => ctx.order.get(element.id) ?? 0;
  if (!ctx.scope) {
    const sorted = [...candidates].sort((a, b) => rank(a) - rank(b));
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        visit(sorted[i], sorted[j]);
      }
    }
    return;
  }
  const seen = new Set<string>();
  for (const a of candidates) {
    if (!ctx.scope.has(a.id)) {
      continue;
    }
    for (const b of candidates) {
      if (a.id === b.id) {
        continue;
      }
      const [first, second] = rank(a) <= rank(b) ? [a, b] : [b, a];
      const key = `${first.id}|${second.id}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      visit(first, second);
    }
  }
};

// Partners worth pairing with `element`: every candidate when it is in scope,
// only the scoped subset otherwise (pass it precomputed to stay O(k)).
export const partnersOf = (
  ctx: LintContext,
  element: ExcalidrawElement,
  candidates: readonly ExcalidrawElement[],
  scopedCandidates?: readonly ExcalidrawElement[],
): readonly ExcalidrawElement[] =>
  ctx.inScope(element.id)
    ? candidates
    : scopedCandidates ?? candidates.filter((c) => ctx.scope!.has(c.id));

// ---- element facts ------------------------------------------------------

// Kinds that exist to hold other elements: full nesting inside them is layout,
// not an overlap, and they are not nodes of the graph.
export const NESTING_KINDS = new Set<ElementKind>([
  "container",
  "lane",
  "group-frame",
  "table",
  "legend",
  "annotation",
  "code",
]);

export const NON_NODE_KINDS = new Set<ElementKind>([
  "table",
  "table-cell",
  "legend",
  "divider",
  "annotation",
  "code",
  "callout",
  "badge",
  "group-frame",
  "lane",
  "container",
]);

// Region-like boxes an arrow may legitimately pass through or end inside.
export const REGION_KINDS = new Set<ElementKind>([
  "container",
  "lane",
  "group-frame",
  "table",
  "table-cell",
  "divider",
]);

export const SHAPE_TYPES = new Set(["rectangle", "ellipse", "diamond", "image"]);

export const isDivider = (element: ExcalidrawElement): boolean =>
  kindOf(element) === "divider";

// Parts of a planned composite (set_table, set_legend, code card, badge):
// their geometry is computed, so hand-placement rules (alignment, padding,
// arrow binding) do not apply to them.
export const COMPOSITE_KINDS = new Set<ElementKind>(["table", "table-cell", "divider", "legend", "code", "badge"]);

export const isCompositePart = (element: ExcalidrawElement): boolean => {
  const kind = kindOf(element);
  return !!kind && COMPOSITE_KINDS.has(kind);
};

export const tableIdOf = (element: ExcalidrawElement): string | undefined =>
  tableRefOf(element)?.tableId;

export const textContent = (element: ExcalidrawElement): string =>
  typeof asText(element).text === "string" ? (asText(element).text as string) : "";

// What the client re-wraps from: originalText when present.
export const labelSource = (element: ExcalidrawElement): string => {
  const original = asText(element).originalText;
  return typeof original === "string" && original.trim() ? original : textContent(element);
};

export const fontSizeOf = (element: ExcalidrawElement): number =>
  typeof asText(element).fontSize === "number"
    ? (asText(element).fontSize as number)
    : DEFAULT_FONT_SIZE;

export const fontFamilyOf = (element: ExcalidrawElement): number | undefined =>
  typeof asText(element).fontFamily === "number"
    ? (asText(element).fontFamily as number)
    : undefined;

export const containerIdOf = (element: ExcalidrawElement): string | undefined => {
  const id = asText(element).containerId;
  return element.type === "text" && typeof id === "string" ? id : undefined;
};

export const isBoundText = (element: ExcalidrawElement): boolean =>
  containerIdOf(element) !== undefined;

export const isFilled = (element: ExcalidrawElement): boolean =>
  !isTransparent(element.backgroundColor);

export const isInvisibleBox = (element: ExcalidrawElement): boolean =>
  !isFilled(element) &&
  (isTransparent(element.strokeColor) || (element.strokeWidth || 0) <= 0);

// Arrow rules apply to arrows and to lines used as connectors; a free line is
// decoration and a divider is structure.
export const isConnector = (element: ExcalidrawElement): boolean => {
  // A legend's line/arrow is a sample of a style, not a connection.
  if (!isLinear(element) || isDivider(element) || kindOf(element) === "legend") {
    return false;
  }
  if (element.type === "arrow") {
    return true;
  }
  const linear = asLinear(element);
  return !!(linear.startBinding || linear.endBinding);
};

export const sharesGroup = (a: ExcalidrawElement, b: ExcalidrawElement): boolean => {
  const gb = new Set(b.groupIds ?? []);
  return (a.groupIds ?? []).some((id) => gb.has(id));
};

export const frameBounds = (frame: ExcalidrawElement): Bounds => [
  frame.x,
  frame.y,
  frame.x + (frame.width || 0),
  frame.y + (frame.height || 0),
];


// ---- geometry helpers ---------------------------------------------------

export const syntheticRect = (bounds: Bounds, id = "__rect"): ExcalidrawElement =>
  ({
    id,
    type: "rectangle",
    x: bounds[0],
    y: bounds[1],
    width: Math.max(0, bounds[2] - bounds[0]),
    height: Math.max(0, bounds[3] - bounds[1]),
    angle: 0,
  }) as ExcalidrawElement;

export const inflateElement = (
  element: ExcalidrawElement,
  by: number,
): ExcalidrawElement =>
  ({
    ...element,
    x: element.x - by,
    y: element.y - by,
    width: Math.max(0, (element.width || 0) + by * 2),
    height: Math.max(0, (element.height || 0) + by * 2),
  }) as ExcalidrawElement;

export const boundsIntersect = (a: Bounds, b: Bounds): boolean =>
  a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

export const expandBounds = (b: Bounds, by: number): Bounds => [
  b[0] - by,
  b[1] - by,
  b[2] + by,
  b[3] + by,
];

export const unionBounds = (a: Bounds, b: Bounds): Bounds => [
  Math.min(a[0], b[0]),
  Math.min(a[1], b[1]),
  Math.max(a[2], b[2]),
  Math.max(a[3], b[3]),
];

export const distanceToSegment = (p: Point, a: Point, b: Point): number => {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    return Math.hypot(p[0] - a[0], p[1] - a[1]);
  }
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
};

export const distanceToPath = (p: Point, path: readonly Point[]): number => {
  let min = Infinity;
  for (let i = 0; i < path.length - 1; i++) {
    min = Math.min(min, distanceToSegment(p, path[i], path[i + 1]));
  }
  return path.length === 1 ? Math.hypot(p[0] - path[0][0], p[1] - path[0][1]) : min;
};

export const segmentIntersection = (
  a1: Point,
  a2: Point,
  b1: Point,
  b2: Point,
): Point | null => {
  const rx = a2[0] - a1[0];
  const ry = a2[1] - a1[1];
  const sx = b2[0] - b1[0];
  const sy = b2[1] - b1[1];
  const denominator = rx * sy - ry * sx;
  if (Math.abs(denominator) < 1e-9) {
    return null;
  }
  const qx = b1[0] - a1[0];
  const qy = b1[1] - a1[1];
  const t = (qx * sy - qy * sx) / denominator;
  const u = (qx * ry - qy * rx) / denominator;
  if (t < 0 || t > 1 || u < 0 || u > 1) {
    return null;
  }
  return [a1[0] + t * rx, a1[1] + t * ry];
};

export const pathLength = (path: readonly Point[]): number => {
  let total = 0;
  for (let i = 0; i < path.length - 1; i++) {
    total += Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]);
  }
  return total;
};

export const MOVE_MARGIN = 20;

// Smallest single-axis shift that takes `move` clear of `fixed`.
export const separationFor = (
  move: Bounds,
  fixed: Bounds,
  margin = MOVE_MARGIN,
): { dx: number; dy: number } => {
  const pushes = [
    { dx: Math.ceil(fixed[2] - move[0] + margin), dy: 0 },
    { dx: -Math.ceil(move[2] - fixed[0] + margin), dy: 0 },
    { dx: 0, dy: Math.ceil(fixed[3] - move[1] + margin) },
    { dx: 0, dy: -Math.ceil(move[3] - fixed[1] + margin) },
  ];
  return pushes.reduce((best, next) =>
    Math.abs(next.dx) + Math.abs(next.dy) < Math.abs(best.dx) + Math.abs(best.dy) ? next : best,
  );
};

// ---- label geometry (client formula) -----------------------------------

// The client's getContainerCoords / arrow-label anchor, shared with the write
// engine so the lint measures labels exactly where the engine puts them.
export const labelAreaOrigin = (container: ExcalidrawElement): Point => containerCoords(container);

export const arrowLabelCenter = (arrow: ExcalidrawElement): Point => arrowLabelAnchor(arrow);

export type LabelLayout = {
  box: Bounds;
  // The label area plus the client's fixed padding: what "free space around
  // the text" is measured against.
  contentBox: Bounds;
  lines: string[];
  width: number;
  height: number;
  maxWidth: number;
  maxHeight: number;
  softWrapped: boolean;
  source: string;
};

export const layoutLabelIn = (
  container: ExcalidrawElement,
  text: ExcalidrawElement,
): LabelLayout => {
  const fontSize = fontSizeOf(text);
  const fontFamily = fontFamilyOf(text) ?? DEFAULT_FONT_FAMILY;
  const source = labelSource(text);
  const maxWidth = getBoundTextMaxWidth(container, fontSize);
  const wrapped = wrapText(source, fontSize, fontFamily, maxWidth);
  const measured = measureText(wrapped, fontSize, fontFamily);
  const lines = wrapped.split("\n");
  const softWrapped = lines.length > normalizeText(source).split("\n").length;
  if (isLinear(container)) {
    const [cx, cy] = arrowLabelCenter(container);
    const box: Bounds = [
      cx - measured.width / 2,
      cy - measured.height / 2,
      cx + measured.width / 2,
      cy + measured.height / 2,
    ];
    return {
      box,
      contentBox: box,
      lines,
      width: measured.width,
      height: measured.height,
      maxWidth,
      maxHeight: Infinity,
      softWrapped,
      source,
    };
  }
  const maxHeight = getBoundTextMaxHeight(container);
  const [ox, oy] = labelAreaOrigin(container);
  const view = asText(text);
  const x =
    view.textAlign === "left"
      ? ox
      : view.textAlign === "right"
        ? ox + (maxWidth - measured.width)
        : ox + (maxWidth / 2 - measured.width / 2);
  const y =
    view.verticalAlign === "top"
      ? oy
      : view.verticalAlign === "bottom"
        ? oy + (maxHeight - measured.height)
        : oy + (maxHeight / 2 - measured.height / 2);
  return {
    box: [x, y, x + measured.width, y + measured.height],
    contentBox: [
      ox - BOUND_TEXT_PADDING,
      oy - BOUND_TEXT_PADDING,
      ox + maxWidth + BOUND_TEXT_PADDING,
      oy + maxHeight + BOUND_TEXT_PADDING,
    ],
    lines,
    width: measured.width,
    height: measured.height,
    maxWidth,
    maxHeight,
    softWrapped,
    source,
  };
};

// Standalone text box as the client lays it out: auto-resizing text is as wide
// as its longest line, fixed-width text wraps inside its width.
export const standaloneTextBox = (text: ExcalidrawElement): Bounds => {
  const fontSize = fontSizeOf(text);
  const fontFamily = fontFamilyOf(text);
  const fixed = asText(text).autoResize === false && (text.width || 0) > 0;
  const content = fixed
    ? wrapText(textContent(text), fontSize, fontFamily, text.width || 0)
    : textContent(text);
  const measured = measureText(content, fontSize, fontFamily);
  const width = fixed ? text.width || 0 : measured.width;
  return [text.x, text.y, text.x + width, text.y + measured.height];
};

// ---- suggestion builders ------------------------------------------------

export const round = (value: number): number => Math.round(value);

export const updateSuggestion = (
  elements: Array<{ id: string } & Record<string, unknown>>,
  risk: "safe" | "review" = "review",
  note?: string,
): Suggestion => ({
  tool: "update_elements",
  args: { elements },
  risk,
  ...(note ? { note } : {}),
});

export const moveSuggestion = (
  ids: string[],
  dx: number,
  dy: number,
  risk: "safe" | "review" = "review",
  note?: string,
): Suggestion => ({
  tool: "move_elements",
  args: {
    target: { ids },
    ...(dx ? { dx: round(dx) } : {}),
    ...(dy ? { dy: round(dy) } : {}),
  },
  risk,
  ...(note ? { note } : {}),
});

export const repairSuggestion = (code: string, ids: string[]): Suggestion => ({
  tool: "repair_scene",
  args: { codes: [code], target: { ids: [...new Set(ids)] } },
  risk: "safe",
});

export const deleteSuggestion = (
  ids: string[],
  risk: "safe" | "review" = "review",
  note?: string,
): Suggestion => ({
  tool: "delete_elements",
  args: { ids },
  risk,
  ...(note ? { note } : {}),
});

export const reorderSuggestion = (
  ids: string[],
  position: "above" | "below" | "front" | "back",
  anchorId?: string,
): Suggestion => ({
  tool: "reorder",
  args: { ids, position, ...(anchorId ? { anchorId } : {}) },
  risk: "safe",
});

export const reasonSuggestion = (reason: string): Suggestion => ({ reason });
