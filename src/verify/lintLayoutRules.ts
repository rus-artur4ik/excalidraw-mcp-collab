import type {ExcalidrawElement} from "../types";
import {kindOf, roleOf, slotOf} from "../customData";
import {asText, BOUND_TEXT_PADDING, type Bounds, DEFAULT_FONT_FAMILY, isFrameLike, isLinear, isTransparent, MONOSPACE_FAMILIES,} from "./model";
import {boundsArea, boundsContain, getCommonBounds, intersectionArea, pointInElement} from "./geometry";
import {contrastRatio, parseColor, suggestReadableColor} from "./colors";
import * as styles from "./styles";
import {getLineWidth, normalizeText, wrapText} from "./textMetrics";
import {
    containerIdOf,
    deleteSuggestion,
    fontFamilyOf,
    fontSizeOf,
    forEachPair,
    frameBounds,
    isBoundText,
    isCompositePart,
    isDivider,
    isFilled,
    labelSource,
    layoutLabelIn,
    type LintContext,
    moveSuggestion,
    NESTING_KINDS,
    reasonSuggestion,
    reorderSuggestion,
    separationFor,
    SHAPE_TYPES,
    sharesGroup,
    tableIdOf,
    textContent,
    updateSuggestion,
} from "./lintContext";

const OVERLAP_RATIO = 0.15;
const DUP_POS = 1.5;
const DUP_SIZE = 1.5;
const OPAQUE_OCCLUSION_OPACITY = 90;
const SOLID_BACKING_OPACITY = 60;
const OUTLIER_ABS_GAP = 4000;
const OUTLIER_RETURN_GAP = 80;
const ALIGN_SNAP = 4;
const ALIGN_MIN = 1;
const MAX_ALIGNMENT_FINDINGS = 25;
const MAX_FONTS = 2;
const MAX_LISTED_IDS = 50;
const LINE_LENGTH_MAX = 80;
const LINE_LENGTH_TARGET = 70;
const SHAPE_FACTOR: Record<string, number> = { ellipse: Math.SQRT2, diamond: 2 };

const ordered = (ctx: LintContext, elements: readonly ExcalidrawElement[]) =>
  [...elements].sort((a, b) => (ctx.order.get(a.id) ?? 0) - (ctx.order.get(b.id) ?? 0));

// Shapes and free text: the things a person places and aligns by hand.
const isPlaced = (element: ExcalidrawElement): boolean =>
  (SHAPE_TYPES.has(element.type) || (element.type === "text" && !isBoundText(element))) &&
  !isDivider(element) &&
  !isCompositePart(element);

// ---- overlap, duplicate, occlusion ---------------------------------------

// Filled boxes and structural kinds hold things by design; so does an
// unfilled dashed/dotted box, which is how create_diagram drew group
// clusters before kinds existed.
const nestingContainer = (outer: ExcalidrawElement): boolean => {
  const kind = kindOf(outer);
  return (
    isFilled(outer) ||
    !!(kind && NESTING_KINDS.has(kind)) ||
    (SHAPE_TYPES.has(outer.type) && outer.type !== "image" && outer.strokeStyle !== "solid")
  );
};

const overlapExempt = (
  a: ExcalidrawElement,
  b: ExcalidrawElement,
  ba: Bounds,
  bb: Bounds,
): boolean => {
  if (sharesGroup(a, b) || a.frameId === b.id || b.frameId === a.id) {
    return true;
  }
  const tableA = tableIdOf(a);
  if (tableA && tableA === tableIdOf(b)) {
    return true;
  }
  // Intended nesting: a text on a shape, or anything fully inside a filled or
  // structural container.
  if (boundsContain(ba, bb) && (b.type === "text" || nestingContainer(a))) {
    return true;
  }
  return boundsContain(bb, ba) && (a.type === "text" || nestingContainer(b));
};

const overlapCandidate = (element: ExcalidrawElement): boolean => {
  const kind = kindOf(element);
  return isPlaced(element) && kind !== "table-cell" && kind !== "badge";
};

const overlapRules = (ctx: LintContext): void => {
  const overlapOn = ctx.on("overlap");
  const duplicateOn = ctx.on("duplicate");
  if (!overlapOn && !duplicateOn) {
    return;
  }
  const candidates = ctx.live.filter(overlapCandidate);
  forEachPair(ctx, candidates, (a, b) => {
    const ba = ctx.bounds(a);
    const bb = ctx.bounds(b);
    const inter = intersectionArea(ba, bb);
    if (inter <= 0) {
      return;
    }
    if (
      duplicateOn &&
      a.type === b.type &&
      Math.abs(a.x - b.x) <= DUP_POS &&
      Math.abs(a.y - b.y) <= DUP_POS &&
      Math.abs((a.width || 0) - (b.width || 0)) <= DUP_SIZE &&
      Math.abs((a.height || 0) - (b.height || 0)) <= DUP_SIZE &&
      a.strokeColor === b.strokeColor &&
      a.backgroundColor === b.backgroundColor &&
      textContent(a) === textContent(b)
    ) {
      // Keep the copy that more things are attached to.
      const victim = (b.boundElements ?? []).length > (a.boundElements ?? []).length ? a : b;
      ctx.emit({
        code: "duplicate",
        severity: "warning",
        elementIds: [a.id, b.id],
        message: `${a.type} appears duplicated (near-identical position, size and style).`,
        suggestion: deleteSuggestion([victim.id], "review"),
      });
      return;
    }
    if (!overlapOn || overlapExempt(a, b, ba, bb)) {
      return;
    }
    const ratio = inter / Math.max(1, Math.min(boundsArea(ba), boundsArea(bb)));
    if (ratio <= OVERLAP_RATIO) {
      return;
    }
    const [smaller, larger] = boundsArea(ba) <= boundsArea(bb) ? [a, b] : [b, a];
    const { dx, dy } = separationFor(ctx.bounds(smaller), ctx.bounds(larger));
    ctx.emit({
      code: "overlap",
      severity: "warning",
      elementIds: [a.id, b.id],
      message: `${a.type} and ${b.type} overlap by ${Math.round(ratio * 100)}% of the smaller element.`,
      suggestion: moveSuggestion([smaller.id], dx, dy, "review", `Moves ${smaller.id} clear; its label and arrows come along.`),
    });
  });
};

const isAbove = (ctx: LintContext, a: ExcalidrawElement, b: ExcalidrawElement): boolean =>
  typeof a.index === "string" && typeof b.index === "string"
    ? a.index > b.index
    : (ctx.order.get(a.id) ?? 0) > (ctx.order.get(b.id) ?? 0);

const occlusionRule = (ctx: LintContext): void => {
  if (!ctx.on("occlusion")) {
    return;
  }
  const covers = ctx.live.filter(
    (element) =>
      SHAPE_TYPES.has(element.type) &&
      isFilled(element) &&
      element.fillStyle === "solid" &&
      (element.opacity ?? 100) >= OPAQUE_OCCLUSION_OPACITY,
  );
  for (const cover of covers) {
    const coverBounds = ctx.bounds(cover);
    const unders = ctx.inScope(cover.id) ? ctx.live : ctx.scoped;
    for (const under of unders) {
      if (
        under.id === cover.id ||
        isLinear(under) ||
        isFrameLike(under) ||
        under.frameId === cover.id ||
        sharesGroup(cover, under) ||
        containerIdOf(under) === cover.id ||
        !isAbove(ctx, cover, under)
      ) {
        continue;
      }
      const underBounds = ctx.bounds(under);
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
      ctx.emit({
        code: "occlusion",
        severity: "warning",
        elementIds: [cover.id, under.id],
        message: `${cover.type} fully covers ${under.type} ${under.id} and is stacked above it; the lower element is hidden.`,
        suggestion: reorderSuggestion([cover.id], "below", under.id),
      });
    }
  }
};

// ---- outliers -------------------------------------------------------------

const outlierRule = (ctx: LintContext): void => {
  if (!ctx.on("off_canvas_outlier")) {
    return;
  }
  const elements = ctx.live.filter((element) => !isBoundText(element));
  if (elements.length < 3) {
    return;
  }
  // Common bounds of "everything but i" from the two best values per edge,
  // so the whole pass is O(n).
  type Best = { value: number; id: string };
  const edges = [0, 1, 2, 3].map(() => [] as Best[]);
  for (const element of elements) {
    const b = ctx.bounds(element);
    for (let edge = 0; edge < 4; edge++) {
      const list = edges[edge];
      const better = (x: number, y: number) => (edge < 2 ? x < y : x > y);
      list.push({ value: b[edge], id: element.id });
      list.sort((p, q) => (better(p.value, q.value) ? -1 : better(q.value, p.value) ? 1 : 0));
      if (list.length > 2) {
        list.pop();
      }
    }
  }
  const without = (id: string): Bounds =>
    edges.map((list) => (list[0].id === id ? list[1] : list[0]).value) as Bounds;
  for (const element of elements) {
    if (!ctx.inScope(element.id)) {
      continue;
    }
    const me = ctx.bounds(element);
    const common = without(element.id);
    const gapX = Math.max(common[0] - me[2], me[0] - common[2], 0);
    const gapY = Math.max(common[1] - me[3], me[1] - common[3], 0);
    const gap = Math.max(gapX, gapY);
    const diag = Math.hypot(common[2] - common[0], common[3] - common[1]);
    if (gap <= Math.max(OUTLIER_ABS_GAP, diag * 2)) {
      continue;
    }
    const dx =
      me[2] < common[0]
        ? common[0] - OUTLIER_RETURN_GAP - me[2]
        : me[0] > common[2]
          ? common[2] + OUTLIER_RETURN_GAP - me[0]
          : 0;
    const dy =
      me[3] < common[1]
        ? common[1] - OUTLIER_RETURN_GAP - me[3]
        : me[1] > common[3]
          ? common[3] + OUTLIER_RETURN_GAP - me[1]
          : 0;
    ctx.emit({
      code: "off_canvas_outlier",
      severity: "warning",
      elementIds: [element.id],
      message: `${element.type} is ${Math.round(gap)}px away from every other element; likely misplaced.`,
      suggestion: moveSuggestion([element.id], dx, dy, "review", "Brings it back next to the rest of the board."),
    });
  }
};

// ---- alignment and rhythm ---------------------------------------------------

type Cohort = { key: string; members: ExcalidrawElement[] };

// Elements that share a frame, a group or a table: the only sets where a few
// px of misalignment is a defect rather than a coincidence.
const cohortsOf = (ctx: LintContext, include: (element: ExcalidrawElement) => boolean): Cohort[] => {
  const cohorts: Cohort[] = [];
  for (const [frameId, children] of ctx.frameChildren) {
    cohorts.push({ key: `frame ${frameId}`, members: children.filter(include) });
  }
  for (const [groupId, members] of ctx.groupMembers) {
    cohorts.push({ key: `group ${groupId}`, members: members.filter(include) });
  }
  const tables = new Map<string, ExcalidrawElement[]>();
  for (const element of ctx.live) {
    const tableId = tableIdOf(element);
    if (tableId && include(element)) {
      tables.set(tableId, [...(tables.get(tableId) ?? []), element]);
    }
  }
  for (const [tableId, members] of tables) {
    cohorts.push({ key: `table ${tableId}`, members });
  }
  return cohorts
    .filter((cohort) => cohort.members.length >= 2)
    .filter((cohort) => !ctx.scope || cohort.members.some((m) => ctx.scope!.has(m.id)))
    .sort((a, b) => a.key.localeCompare(b.key));
};

type Anchor = "left" | "centerX" | "right" | "top" | "centerY" | "bottom";

const anchorsOf = (element: ExcalidrawElement, axis: "x" | "y"): Partial<Record<Anchor, number>> => {
  const w = element.width || 0;
  const h = element.height || 0;
  if (axis === "y") {
    return { top: element.y, centerY: element.y + h / 2, bottom: element.y + h };
  }
  if (element.type === "text") {
    // Text aligns on the edge it is anchored to, not on its box center.
    const align = asText(element).textAlign;
    return align === "left"
      ? { left: element.x }
      : align === "right"
        ? { right: element.x + w }
        : { centerX: element.x + w / 2 };
  }
  return { left: element.x, centerX: element.x + w / 2, right: element.x + w };
};

const AXIS_ANCHORS: Record<"x" | "y", Anchor[]> = {
  x: ["centerX", "left", "right"],
  y: ["centerY", "top", "bottom"],
};

const clustersOf = <T>(items: Array<{ value: number; item: T }>, snap: number) => {
  const sorted = [...items].sort((a, b) => a.value - b.value);
  const clusters: Array<Array<{ value: number; item: T }>> = [];
  for (const entry of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && entry.value - last[last.length - 1].value <= snap) {
      last.push(entry);
    } else {
      clusters.push([entry]);
    }
  }
  return clusters;
};

const alignmentRule = (ctx: LintContext): void => {
  if (!ctx.on("alignment_near_miss")) {
    return;
  }
  const reported = new Set<string>();
  let count = 0;
  for (const cohort of cohortsOf(ctx, isPlaced)) {
    for (const axis of ["x", "y"] as const) {
      const anchors = new Map(cohort.members.map((m) => [m.id, anchorsOf(m, axis)]));
      for (const anchor of AXIS_ANCHORS[axis]) {
        if (count >= MAX_ALIGNMENT_FINDINGS) {
          return;
        }
        const values = cohort.members
          .map((item) => ({ item, value: anchors.get(item.id)![anchor] }))
          .filter((entry): entry is { item: ExcalidrawElement; value: number } => entry.value !== undefined);
        for (const cluster of clustersOf(values, ALIGN_SNAP)) {
          if (cluster.length < 2) {
            continue;
          }
          const span = cluster[cluster.length - 1].value - cluster[0].value;
          if (span < ALIGN_MIN || span > ALIGN_SNAP + 1) {
            continue;
          }
          const members = cluster.map((entry) => entry.item);
          // Already exactly aligned on another anchor of this axis: the
          // difference here is only their size difference.
          const alignedElsewhere = AXIS_ANCHORS[axis].some((other) => {
            if (other === anchor) {
              return false;
            }
            const vs = members.map((m) => anchors.get(m.id)![other]);
            return (
              vs.every((v) => v !== undefined) &&
              Math.max(...(vs as number[])) - Math.min(...(vs as number[])) < ALIGN_MIN
            );
          });
          const key = `${axis}|${members.map((m) => m.id).sort().join(",")}`;
          if (alignedElsewhere || reported.has(key)) {
            continue;
          }
          reported.add(key);
          // Snap to the value most members already share; ties go to the
          // earliest element.
          const buckets = new Map<number, ExcalidrawElement[]>();
          for (const entry of cluster) {
            const bucket = Math.round(entry.value * 2) / 2;
            buckets.set(bucket, [...(buckets.get(bucket) ?? []), entry.item]);
          }
          const rank = (list: ExcalidrawElement[]) => Math.min(...list.map((m) => ctx.order.get(m.id) ?? 0));
          const [target] = [...buckets.entries()].sort(
            (p, q) => q[1].length - p[1].length || rank(p[1]) - rank(q[1]),
          )[0];
          const patches = cluster
            .filter((entry) => Math.abs(entry.value - target) >= 0.5)
            .map((entry) => ({
              id: entry.item.id,
              [axis]: Math.round((entry.item[axis] + (target - entry.value)) * 100) / 100,
            }));
          count++;
          ctx.emit({
            code: "alignment_near_miss",
            severity: "warning",
            elementIds: ordered(ctx, members).map((m) => m.id),
            kind: anchor,
            message: `${members.length} elements of ${cohort.key} are ${span.toFixed(1)}px off a shared ${anchor} — likely meant to align.`,
            suggestion: updateSuggestion(patches, "safe", `Snaps ${anchor} to ${target}.`),
          });
        }
      }
    }
  }
};

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const gapRule = (ctx: LintContext): void => {
  if (!ctx.on("gap_irregular")) {
    return;
  }
  const include = (element: ExcalidrawElement) =>
    isPlaced(element) && !tableIdOf(element) && kindOf(element) !== "table-cell";
  const reported = new Set<string>();
  for (const cohort of cohortsOf(ctx, include)) {
    if (cohort.members.length < 3) {
      continue;
    }
    for (const along of ["y", "x"] as const) {
      const across = along === "y" ? "x" : "y";
      const size = along === "y" ? "height" : "width";
      const crossSize = along === "y" ? "width" : "height";
      const lines: ExcalidrawElement[][] = [];
      for (const pick of ["start", "center"] as const) {
        const values = cohort.members.map((item) => ({
          item,
          value: item[across] + (pick === "center" ? (item[crossSize] || 0) / 2 : 0),
        }));
        for (const cluster of clustersOf(values, ALIGN_SNAP)) {
          if (cluster.length >= 3) {
            lines.push(cluster.map((entry) => entry.item));
          }
        }
      }
      for (const line of lines) {
        const key = `${along}|${line.map((m) => m.id).sort().join(",")}`;
        if (reported.has(key)) {
          continue;
        }
        reported.add(key);
        const sorted = [...line].sort((a, b) => a[along] - b[along]);
        const gaps = sorted
          .slice(0, -1)
          .map((m, i) => sorted[i + 1][along] - (m[along] + (m[size] || 0)));
        if (gaps.some((gap) => gap <= 0)) {
          continue;
        }
        const typical = median(gaps);
        // A gap far above the typical one is a section break, not noise.
        const considered = gaps
          .map((gap, i) => ({ gap, i }))
          .filter(({ gap }) => gaps.length === 2 || gap <= typical * 3);
        if (gaps.length === 2 && Math.max(...gaps) > Math.min(...gaps) * 3) {
          continue;
        }
        const worst = considered.reduce((best, next) =>
          Math.abs(next.gap - typical) > Math.abs(best.gap - typical) ? next : best,
        );
        const deviation = Math.abs(worst.gap - typical);
        if (deviation <= Math.max(8, typical * 0.35)) {
          continue;
        }
        const movers = sorted.slice(worst.i + 1).map((m) => m.id);
        const delta = Math.round(typical - worst.gap);
        ctx.emit({
          code: "gap_irregular",
          severity: "info",
          elementIds: ordered(ctx, sorted).map((m) => m.id),
          kind: along === "y" ? "column" : "row",
          message: `Gaps in this ${along === "y" ? "column" : "row"} of ${cohort.key} are ${gaps.map((gap) => Math.round(gap)).join(", ")}px; ${Math.round(worst.gap)} breaks the rhythm of ~${Math.round(typical)}.`,
          suggestion: moveSuggestion(
            movers,
            along === "x" ? delta : 0,
            along === "y" ? delta : 0,
            "review",
            "Evens out the worst gap by moving everything after it.",
          ),
        });
      }
    }
  }
};

const framePaddingRule = (ctx: LintContext): void => {
  if (!ctx.on("frame_padding_asymmetric")) {
    return;
  }
  for (const [frameId, children] of ctx.frameChildren) {
    const frame = ctx.byId.get(frameId);
    if (!frame || !isFrameLike(frame) || frame.angle) {
      continue;
    }
    if (ctx.scope && !ctx.scope.has(frameId) && !children.some((c) => ctx.scope!.has(c.id))) {
      continue;
    }
    const content = children.filter((child) => !isBoundText(child));
    if (!content.length) {
      continue;
    }
    const cb = getCommonBounds(content);
    const fb = frameBounds(frame);
    const pads = { left: cb[0] - fb[0], right: fb[2] - cb[2], top: cb[1] - fb[1], bottom: fb[3] - cb[3] };
    if (Object.values(pads).some((pad) => pad < 0)) {
      continue;
    }
    const uneven = (a: number, b: number) =>
      Math.abs(a - b) >= 12 && Math.max(a, b) >= Math.min(a, b) * 1.4;
    const horizontal = uneven(pads.left, pads.right);
    const vertical = uneven(pads.top, pads.bottom);
    if (!horizontal && !vertical) {
      continue;
    }
    const smaller = [
      ...(horizontal ? [Math.min(pads.left, pads.right)] : []),
      ...(vertical ? [Math.min(pads.top, pads.bottom)] : []),
    ];
    const padding = Math.max(16, Math.round(Math.min(...smaller)));
    const describe = (a: string, b: string) =>
      `${a} ${Math.round(pads[a as keyof typeof pads])} vs ${b} ${Math.round(pads[b as keyof typeof pads])}`;
    ctx.emit({
      code: "frame_padding_asymmetric",
      severity: "info",
      elementIds: [frameId],
      kind: horizontal && vertical ? "both" : horizontal ? "horizontal" : "vertical",
      message: `Frame padding is uneven: ${[
        ...(horizontal ? [describe("left", "right")] : []),
        ...(vertical ? [describe("top", "bottom")] : []),
      ].join("; ")}px.`,
      suggestion: updateSuggestion([{ id: frameId, fitToChildren: { padding } }], "review", `Refits the frame with ${padding}px on every side.`),
    });
  }
};

// ---- contrast -------------------------------------------------------------

const CONTRAST_CANDIDATES = ["#1e1e1e", "#ffffff", ...styles.PALETTE_STROKES];

const BACKING_CELL = 400;

const isBacking = (candidate: ExcalidrawElement): boolean =>
  SHAPE_TYPES.has(candidate.type) &&
  isFilled(candidate) &&
  candidate.fillStyle === "solid" &&
  (candidate.opacity ?? 100) >= SOLID_BACKING_OPACITY &&
  typeof candidate.index === "string";

const cellKey = (cx: number, cy: number): string => `${cx}:${cy}`;

// Filled shapes bucketed by grid cell, so finding what sits under a text is
// O(1) per text instead of a scan of the scene.
const backingIndex = (ctx: LintContext) => {
  const cells = new Map<string, ExcalidrawElement[]>();
  for (const candidate of ctx.live) {
    if (!isBacking(candidate)) {
      continue;
    }
    const [x1, y1, x2, y2] = ctx.bounds(candidate);
    for (let cx = Math.floor(x1 / BACKING_CELL); cx <= Math.floor(x2 / BACKING_CELL); cx++) {
      for (let cy = Math.floor(y1 / BACKING_CELL); cy <= Math.floor(y2 / BACKING_CELL); cy++) {
        const key = cellKey(cx, cy);
        const list = cells.get(key);
        if (list) {
          list.push(candidate);
        } else {
          cells.set(key, [candidate]);
        }
      }
    }
  }
  return (text: ExcalidrawElement): ExcalidrawElement | null => {
    const textBounds = ctx.bounds(text);
    const key = cellKey(Math.floor(textBounds[0] / BACKING_CELL), Math.floor(textBounds[1] / BACKING_CELL));
    let best: ExcalidrawElement | null = null;
    for (const candidate of cells.get(key) ?? []) {
      if (
        candidate.id === text.id ||
        typeof text.index !== "string" ||
        !(text.index > (candidate.index as string)) ||
        !boundsContain(ctx.bounds(candidate), textBounds)
      ) {
        continue;
      }
      if (!best || (candidate.index as string) > (best.index ?? "")) {
        best = candidate;
      }
    }
    return best;
  };
};

const contrastRule = (ctx: LintContext): void => {
  if (!ctx.on("low_contrast")) {
    return;
  }
  const backingOf = backingIndex(ctx);
  // Scoped: the scoped texts plus any text lying on a scoped filled shape
  // (recoloring a box can make the text on it unreadable).
  let texts = ctx.scopedTexts();
  if (ctx.scope) {
    const scopedBackings = ctx.scoped.filter(isBacking);
    if (scopedBackings.length) {
      const seen = new Set(texts.map((text) => text.id));
      const extra = ctx.live.filter(
        (element) =>
          element.type === "text" &&
          !seen.has(element.id) &&
          scopedBackings.some((backing) => boundsContain(ctx.bounds(backing), ctx.bounds(element))),
      );
      texts = [...texts, ...extra];
    }
  }
  for (const text of texts) {
    if (!textContent(text).trim()) {
      continue;
    }
    const fg = parseColor(text.strokeColor);
    if (!fg) {
      continue;
    }
    const backing = backingOf(text);
    const bg = parseColor(backing ? backing.backgroundColor : ctx.viewBackgroundColor);
    if (!bg) {
      continue;
    }
    const ratio = contrastRatio(fg, bg);
    const threshold = fontSizeOf(text) >= 24 ? 3 : 4.5;
    if (ratio >= threshold) {
      continue;
    }
    const readable = suggestReadableColor(fg, bg, threshold, CONTRAST_CANDIDATES);
    ctx.emit({
      code: "low_contrast",
      severity: "warning",
      elementIds: backing ? [text.id, backing.id] : [text.id],
      message: `Text contrast ${ratio.toFixed(2)}:1 against ${backing ? `${backing.id}'s fill` : "the canvas"} is below the ${threshold}:1 readability threshold.`,
      suggestion: readable
        ? updateSuggestion([{ id: text.id, strokeColor: readable }], "safe")
        : reasonSuggestion("No palette color reaches the threshold on this background; change the background instead."),
    });
  }
};

// ---- style consistency ------------------------------------------------------

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export const normalizeHex = (color: string): string | null => {
  const value = color.trim().toLowerCase();
  if (!HEX.test(value)) {
    return null;
  }
  if (value.length === 4) {
    return `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`;
  }
  return value.slice(0, 7);
};

// Every color literal styles.ts exports counts as palette, so surfaces and
// tones added there later are tolerated without touching the lint.
const collectColors = (value: unknown, out: Set<string>, depth = 0): void => {
  if (depth > 4 || value === null || value === undefined) {
    return;
  }
  if (typeof value === "string") {
    const hex = normalizeHex(value);
    if (hex) {
      out.add(hex);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectColors(item, out, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value)) collectColors(item, out, depth + 1);
  }
};

const PALETTE = (() => {
  const colors = new Set<string>(["#000000", "#1e1e1e", "#ffffff"]);
  collectColors(Object.values(styles), colors);
  // Tone variants (e.g. subtle fills) may only be reachable through
  // resolveRole(name, tone); ask it for every role × tone it knows.
  const exported = styles as unknown as Record<string, unknown>;
  const resolve = exported.resolveRole;
  const tones = Array.isArray(exported.ROLE_TONES) ? (exported.ROLE_TONES as unknown[]) : ["solid"];
  if (typeof resolve === "function") {
    for (const role of Object.keys(styles.STYLE_ROLES)) {
      for (const tone of tones) {
        try {
          collectColors(resolve(role, tone), colors);
        } catch {
          // An unknown tone is simply not part of the palette.
        }
      }
    }
  }
  return colors;
})();

const STROKE_PALETTE = (() => {
  const colors = new Set<string>(["#1e1e1e"]);
  for (const role of Object.values(styles.STYLE_ROLES)) {
    for (const color of [role.strokeColor, role.labelColor]) {
      const hex = normalizeHex(color);
      if (hex) colors.add(hex);
    }
  }
  return [...colors];
})();

const FILL_PALETTE = [...PALETTE].filter((color) => !STROKE_PALETTE.includes(color) || color === "#ffffff");

const nearestColor = (color: string, palette: readonly string[]): string | null => {
  const rgb = parseColor(color);
  if (!rgb) {
    return null;
  }
  let best: { color: string; distance: number } | null = null;
  for (const candidate of palette) {
    const other = parseColor(candidate);
    if (!other) continue;
    const distance = Math.hypot(rgb.r - other.r, rgb.g - other.g, rgb.b - other.b);
    if (!best || distance < best.distance) {
      best = { color: candidate, distance };
    }
  }
  return best?.color ?? null;
};

const paletteRule = (ctx: LintContext): void => {
  if (!ctx.on("style_off_palette_color")) {
    return;
  }
  const tolerated = new Set(PALETTE);
  const view = normalizeHex(ctx.viewBackgroundColor);
  if (view) tolerated.add(view);
  const users = new Map<string, Array<{ element: ExcalidrawElement; field: "strokeColor" | "backgroundColor" }>>();
  for (const element of ctx.scoped) {
    if (isFrameLike(element) || element.type === "image") {
      continue;
    }
    for (const field of ["strokeColor", "backgroundColor"] as const) {
      const raw = element[field];
      if (isTransparent(raw)) {
        continue;
      }
      const hex = normalizeHex(raw);
      if (!hex || tolerated.has(hex)) {
        continue;
      }
      users.set(hex, [...(users.get(hex) ?? []), { element, field }]);
    }
  }
  for (const [color, uses] of [...users.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const ids = ordered(ctx, [...new Set(uses.map((use) => use.element))]).map((e) => e.id);
    const patches = new Map<string, Record<string, unknown> & { id: string }>();
    for (const { element, field } of uses) {
      const nearest = nearestColor(color, field === "strokeColor" ? STROKE_PALETTE : FILL_PALETTE);
      if (nearest && patches.size < MAX_LISTED_IDS) {
        patches.set(element.id, { ...(patches.get(element.id) ?? { id: element.id }), [field]: nearest });
      }
    }
    ctx.emit({
      code: "style_off_palette_color",
      severity: "info",
      elementIds: ids.slice(0, MAX_LISTED_IDS),
      kind: color,
      message: `${color} is not a role or palette color (${ids.length} element${ids.length > 1 ? "s" : ""}); use a role instead of a hand-picked hex.`,
      suggestion: updateSuggestion([...patches.values()], "review", "Recolors to the nearest palette color; setting a `role` is usually better."),
    });
  }
};

const fontsRule = (ctx: LintContext): void => {
  if (!ctx.on("style_many_fonts")) {
    return;
  }
  const texts = ctx.live.filter((element) => element.type === "text");
  const counts = new Map<number, number>();
  for (const text of texts) {
    const family = fontFamilyOf(text) ?? DEFAULT_FONT_FAMILY;
    counts.set(family, (counts.get(family) ?? 0) + 1);
  }
  if (counts.size <= MAX_FONTS) {
    return;
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const kept = new Set(ranked.slice(0, MAX_FONTS).map(([family]) => family));
  const majority = ranked[0][0];
  const minority = ctx.scoped.filter(
    (text) => text.type === "text" && !kept.has(fontFamilyOf(text) ?? DEFAULT_FONT_FAMILY),
  );
  if (!minority.length) {
    return;
  }
  const listed = ordered(ctx, minority).slice(0, MAX_LISTED_IDS);
  ctx.emit({
    code: "style_many_fonts",
    severity: "info",
    elementIds: listed.map((text) => text.id),
    message: `${counts.size} different font families are used; these texts use a family outside the main ${MAX_FONTS}.`,
    suggestion: updateSuggestion(
      listed.map((text) => ({ id: text.id, fontFamily: majority })),
      "review",
    ),
  });
};

const roleKeyOf = (ctx: LintContext, text: ExcalidrawElement): string | undefined => {
  const containerId = containerIdOf(text);
  const container = containerId ? ctx.byId.get(containerId) : undefined;
  const role = roleOf(text) ?? (container ? roleOf(container) : undefined);
  const slot = slotOf(text) ?? (container ? slotOf(container) : undefined);
  if (slot) {
    return `slot ${slot}`;
  }
  return role ? `role ${role}` : undefined;
};

const fontSizeOutlierRule = (ctx: LintContext, extraKeys: Map<string, string>): void => {
  if (!ctx.on("style_font_size_outlier")) {
    return;
  }
  const groups = new Map<string, ExcalidrawElement[]>();
  for (const text of ctx.live) {
    if (text.type !== "text" || !textContent(text).trim()) {
      continue;
    }
    const key = extraKeys.get(text.id) ?? roleKeyOf(ctx, text);
    if (key) {
      groups.set(key, [...(groups.get(key) ?? []), text]);
    }
  }
  for (const [key, texts] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (texts.length < 3) {
      continue;
    }
    const counts = new Map<number, number>();
    for (const text of texts) {
      counts.set(fontSizeOf(text), (counts.get(fontSizeOf(text)) ?? 0) + 1);
    }
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    if (ranked.length < 2 || ranked[0][1] < 2 || ranked[0][1] === ranked[1][1]) {
      continue;
    }
    const majority = ranked[0][0];
    const outliers = ordered(ctx, texts.filter((text) => fontSizeOf(text) !== majority));
    ctx.emit({
      code: "style_font_size_outlier",
      severity: "info",
      elementIds: outliers.map((text) => text.id),
      kind: key,
      message: `${outliers.length} of ${texts.length} texts with ${key} use a font size other than ${majority} (${[...new Set(outliers.map(fontSizeOf))].join(", ")}).`,
      suggestion: updateSuggestion(outliers.map((text) => ({ id: text.id, fontSize: majority })), "review"),
    });
  }
};

// ---- typography -------------------------------------------------------------

const BREAK_LEADERS = /^[—–·→]/u;

type WrappedLine = { text: string; soft: boolean; midWord: boolean };

const wrapWithBreaks = (
  source: string,
  fontSize: number,
  fontFamily: number | undefined,
  maxWidth: number,
): WrappedLine[] => {
  const lines: WrappedLine[] = [];
  for (const hard of normalizeText(source).split("\n")) {
    const soft = wrapText(hard, fontSize, fontFamily, maxWidth).split("\n");
    let cursor = 0;
    soft.forEach((line, k) => {
      const at = line ? hard.indexOf(line, cursor) : cursor;
      const midWord = k > 0 && at === cursor && at > 0 && /\S/.test(hard[at - 1] ?? "") && /\S/.test(hard[at] ?? "");
      lines.push({ text: line, soft: k > 0, midWord });
      cursor = at >= 0 ? at + line.length : cursor;
    });
  }
  return lines;
};

const containerWidthFor = (container: ExcalidrawElement, textWidth: number): number =>
  Math.ceil((textWidth + BOUND_TEXT_PADDING * 2) * (SHAPE_FACTOR[container.type] ?? 1)) + 1;

const firstToken = (line: string): string => line.trim().split(/\s+/)[0] ?? "";

const badBreakRule = (ctx: LintContext): void => {
  if (!ctx.on("text_bad_break")) {
    return;
  }
  for (const text of ctx.scopedTexts()) {
    const containerId = containerIdOf(text);
    const container = containerId ? ctx.byId.get(containerId) : undefined;
    const fixed = !container && asText(text).autoResize === false && (text.width || 0) > 0;
    if (!container && !fixed) {
      continue;
    }
    const fontSize = fontSizeOf(text);
    const fontFamily = fontFamilyOf(text) ?? DEFAULT_FONT_FAMILY;
    const source = container ? labelSource(text) : textContent(text);
    if (!source.trim()) {
      continue;
    }
    const maxWidth = container ? layoutLabelIn(container, text).maxWidth : text.width || 0;
    const lines = wrapWithBreaks(source, fontSize, fontFamily, maxWidth);
    let problem: { kind: string; message: string; needed: number } | null = null;
    for (let i = 1; i < lines.length && !problem; i++) {
      const line = lines[i];
      if (!line.soft) {
        continue;
      }
      const previous = lines[i - 1].text;
      if (line.midWord) {
        // A word wider than the box: text_overflow already covers containers.
        if (container && !isLinear(container)) {
          continue;
        }
        const longest = Math.max(...source.split(/\s+/).map((word) => getLineWidth(word, fontSize, fontFamily)));
        problem = { kind: "mid_word", message: `"${previous}|${line.text}" is split mid-word by wrapping.`, needed: longest };
      } else if (BREAK_LEADERS.test(line.text.trim())) {
        problem = {
          kind: "leading_symbol",
          message: `A wrapped line starts with "${line.text.trim()[0]}"; the symbol belongs with the words before it.`,
          needed: getLineWidth(`${previous} ${firstToken(line.text)}`, fontSize, fontFamily),
        };
      }
    }
    if (!problem && lines.length >= 2 && lines.length <= 3) {
      const last = lines[lines.length - 1];
      const previous = lines[lines.length - 2].text;
      const lonely = last.text.trim();
      if (last.soft && !/\s/.test(lonely) && [...lonely].length <= 8 && /\s/.test(previous.trim())) {
        problem = {
          kind: "widow",
          message: `The last line holds only "${lonely}".`,
          needed: getLineWidth(`${previous} ${lonely}`, fontSize, fontFamily),
        };
      }
    }
    if (!problem) {
      continue;
    }
    let suggestion;
    if (container && isLinear(container)) {
      suggestion = reasonSuggestion("Arrow labels wrap at 70% of the arrow's length: lengthen the arrow, shorten the label or add a manual line break.");
    } else if (container) {
      const width = containerWidthFor(container, problem.needed);
      suggestion =
        width > (container.width || 0) && width <= (container.width || 0) * 1.6
          ? updateSuggestion([{ id: container.id, width }], "review", "Widens the box so the break moves.")
          : reasonSuggestion(`Put a manual line break into the label of ${container.id} (update_elements {id, label}) so the lines break where they should.`);
    } else {
      const width = Math.ceil(problem.needed) + 1;
      suggestion =
        width > (text.width || 0)
          ? updateSuggestion([{ id: text.id, width, text: source }], "review")
          : reasonSuggestion("Insert a manual line break where the text should break.");
    }
    ctx.emit({
      code: "text_bad_break",
      severity: "info",
      elementIds: container ? [text.id, container.id] : [text.id],
      kind: problem.kind,
      message: problem.message,
      suggestion,
    });
  }
};

const isCodeText = (ctx: LintContext, text: ExcalidrawElement): boolean => {
  if (MONOSPACE_FAMILIES.has(fontFamilyOf(text) ?? 0)) {
    return true;
  }
  const containerId = containerIdOf(text);
  const container = containerId ? ctx.byId.get(containerId) : undefined;
  return kindOf(text) === "code" || (!!container && kindOf(container) === "code");
};

const lineLengthRule = (ctx: LintContext): void => {
  if (!ctx.on("line_length")) {
    return;
  }
  for (const text of ctx.scopedTexts()) {
    if (isCodeText(ctx, text)) {
      continue;
    }
    const containerId = containerIdOf(text);
    const container = containerId ? ctx.byId.get(containerId) : undefined;
    if (containerId && !container) {
      continue;
    }
    const fontSize = fontSizeOf(text);
    const fontFamily = fontFamilyOf(text);
    const lines = container
      ? layoutLabelIn(container, text).lines
      : asText(text).autoResize === false && (text.width || 0) > 0
        ? wrapText(textContent(text), fontSize, fontFamily, text.width || 0).split("\n")
        : normalizeText(textContent(text)).split("\n");
    const longest = lines.reduce((best, line) => ([...line.trim()].length > [...best.trim()].length ? line : best), "");
    const length = [...longest.trim()].length;
    if (length <= LINE_LENGTH_MAX) {
      continue;
    }
    const target = Math.ceil(getLineWidth([...longest.trim()].slice(0, LINE_LENGTH_TARGET).join(""), fontSize, fontFamily));
    const source = container ? labelSource(text) : textContent(text);
    let suggestion;
    if (container && isLinear(container)) {
      suggestion = reasonSuggestion("Shorten the arrow label; long sentences belong in a note next to the arrow.");
    } else if (container) {
      const width = containerWidthFor(container, target);
      suggestion =
        width < (container.width || 0)
          ? updateSuggestion([{ id: container.id, width, fit: "height" }], "review", `Narrows the box to ~${LINE_LENGTH_TARGET} characters per line.`)
          : reasonSuggestion("Split the text into shorter lines.");
    } else {
      suggestion = updateSuggestion(
        [{ id: text.id, autoResize: false, width: target, text: source }],
        "review",
        `Wraps the text at ~${LINE_LENGTH_TARGET} characters per line.`,
      );
    }
    ctx.emit({
      code: "line_length",
      severity: "info",
      elementIds: container ? [text.id, container.id] : [text.id],
      message: `A line of this text is ${length} characters long; lines over ${LINE_LENGTH_MAX} are hard to read.`,
      suggestion,
    });
  }
};

export const layoutRules = (ctx: LintContext, fontSizeKeys: Map<string, string>): void => {
  overlapRules(ctx);
  occlusionRule(ctx);
  outlierRule(ctx);
  alignmentRule(ctx);
  gapRule(ctx);
  framePaddingRule(ctx);
  contrastRule(ctx);
  paletteRule(ctx);
  fontsRule(ctx);
  fontSizeOutlierRule(ctx, fontSizeKeys);
  badBreakRule(ctx);
  lineLengthRule(ctx);
};
