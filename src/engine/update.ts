import type {ExcalidrawElement} from "../types";
import {applyUpdate, markDeleted} from "../elements";
import {customDataOf, LABEL_ID_SUFFIX, labelIdFor} from "../customData";
import {UPDATE_PATCH_FIELDS} from "../toolSchemas";
import {asLinear, asText, CONTAINER_TYPES, DEFAULT_FONT_FAMILY, DEFAULT_FONT_SIZE, isLinear, type Point,} from "../verify/model";
import {getCommonBounds} from "../verify/geometry";
import {getBoundTextMaxWidth, layoutText} from "../verify/textMetrics";
import {type Anchor, inferRoute, planHalfBound, reshapeFreeArrow, type RouteKind} from "./arrows";
import {
  asTextAlign,
  asVerticalAlign,
  bakeLineBreaks,
  COMFORT_PADDING,
  comfortableDimension,
  computeContainerDimensionForBoundText,
  type LabelStyle,
  labelStyleOf,
  type WrapMode,
} from "./boundText";
import {expandStyleFrom, mergedCustomData, roleStyle} from "./common";
import {attachLabel, type CreateContext, planArrowBetween, removeBackref, resolveBindable, spreadAnchors} from "./create";
import {invalidArgs, notFound} from "./errors";
import {boundTextOf, followShapes, labelSource, relayoutLabel} from "./follow";
import {moveElements} from "./move";
import {insertIntoStack, removeFromStack} from "./stack";
import type {SceneTxn} from "./txn";

export type Patch = { id: string } & Record<string, unknown>;

const KNOWN = new Set<string>(UPDATE_PATCH_FIELDS);

const READ_ONLY_HINTS: Record<string, string> = {
  version: "the server bumps versions itself",
  versionNonce: "the server sets it",
  updated: "the server sets it",
  seed: "not editable",
  isDeleted: "delete with delete_elements, bring back with restore",
  boundElements: "back-references are maintained by the server; bind with fromId/toId or containerId, fix with repair_scene",
  originalText: "set `text` (or `label` on the container) — originalText follows",
  elbowed: "use route",
};

const GEOMETRY = ["x", "y", "width", "height", "angle"] as const;
const PLAIN_STYLE = [
  "strokeColor",
  "backgroundColor",
  "fillStyle",
  "strokeWidth",
  "strokeStyle",
  "roughness",
  "opacity",
  "roundness",
  "locked",
  "name",
  "index",
  "groupIds",
  "fileId",
  "scale",
] as const;
const TEXT_FIELDS = ["text", "fontSize", "fontFamily", "textAlign", "verticalAlign", "lineHeight", "autoResize"] as const;
const LABEL_STYLE_FIELDS = ["fontSize", "fontFamily", "textAlign", "verticalAlign"] as const;
const ARROW_FIELDS = [
  "fromId",
  "toId",
  "startBinding",
  "endBinding",
  "startAnchor",
  "endAnchor",
  "bindMode",
  "waypoints",
  "route",
] as const;

const SHAPE_TYPES = new Set(["rectangle", "ellipse", "diamond"]);

export const canChangeType = (from: string, to: string): boolean =>
  from === to ||
  (SHAPE_TYPES.has(from) && SHAPE_TYPES.has(to)) ||
  (from === "text" && SHAPE_TYPES.has(to)) ||
  (SHAPE_TYPES.has(from) && to === "text") ||
  (from === "arrow" && to === "line") ||
  (from === "line" && to === "arrow");

export type UpdateContext = CreateContext & {
  strict?: "warn" | "error";
};

export const resolveElementId = (txn: SceneTxn, id: string): string => {
  if (txn.live(id) || !id.endsWith(LABEL_ID_SUFFIX)) {
    return id;
  }
  // `<containerId>:label` addresses a container's label even when the label
  // itself was created with a random id (older boards, the browser).
  const container = txn.live(id.slice(0, -LABEL_ID_SUFFIX.length));
  const label = container ? boundTextOf(txn, container) : undefined;
  return label?.id ?? id;
};

const has = (patch: Patch, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(patch, key) && patch[key] !== undefined;

const valuesEqual = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

// `expect` precondition: the patch applies only if the element still has the
// expected values; a patch whose target values are all already present is
// reported as alreadyApplied rather than applied twice.
const checkExpect = (txn: SceneTxn, current: ExcalidrawElement, patch: Patch): boolean => {
  const expect = patch.expect as Record<string, unknown> | undefined;
  if (!expect || typeof expect !== "object") {
    return true;
  }
  const actual: Record<string, unknown> = {};
  let mismatch = false;
  for (const [key, value] of Object.entries(expect)) {
    const now =
      key === "label"
        ? (() => {
            const text = boundTextOf(txn, current);
            return text ? labelSource(text) : undefined;
          })()
        : (current as Record<string, unknown>)[key];
    if (!valuesEqual(now, value)) {
      mismatch = true;
      actual[key] = now;
    }
  }
  if (!mismatch) {
    return true;
  }
  const targets = Object.entries(patch).filter(([key]) => key !== "id" && key !== "expect");
  const applied = targets.length > 0 && targets.every(([key, value]) => {
    const now =
      key === "label"
        ? (() => {
            const text = boundTextOf(txn, current);
            return text ? labelSource(text) : undefined;
          })()
        : (current as Record<string, unknown>)[key];
    return valuesEqual(now, value);
  });
  if (applied) {
    txn.report.alreadyApplied.push(current.id);
  } else {
    txn.report.skipped.push({ id: current.id, reason: "expect_mismatch", actual });
  }
  return false;
};

// ---- type change -------------------------------------------------------

// applyUpdate never changes `type` (patches are not allowed to), so a type
// change sets it explicitly on the freshly bumped copy.
const retype = (element: ExcalidrawElement, type: string): ExcalidrawElement => ({ ...element, type });

const changeType = (txn: SceneTxn, current: ExcalidrawElement, type: string): ExcalidrawElement => {
  const from = current.type;
  if (from === type) {
    return current;
  }
  if (SHAPE_TYPES.has(from) && SHAPE_TYPES.has(type)) {
    const next = retype(applyUpdate(current, {}), type);
    txn.put(next);
    followShapes(txn, [next.id]);
    return next;
  }
  if (from === "text" && SHAPE_TYPES.has(type)) {
    const view = asText(current);
    if (typeof view.containerId === "string") {
      throw invalidArgs(`${current.id} is a label; change the type of its container ${view.containerId} instead`, {
        ids: [current.id],
      });
    }
    const source = String(view.originalText ?? view.text ?? "");
    const fontSize = view.fontSize ?? DEFAULT_FONT_SIZE;
    const fontFamily = view.fontFamily ?? DEFAULT_FONT_FAMILY;
    const width = computeContainerDimensionForBoundText(current.width || 0, type);
    const height = computeContainerDimensionForBoundText(current.height || 0, type);
    const cx = current.x + (current.width || 0) / 2;
    const cy = current.y + (current.height || 0) / 2;
    const container = retype(applyUpdate(current, {
      x: cx - width / 2,
      y: cy - height / 2,
      width,
      height,
      strokeColor: current.strokeColor,
      backgroundColor: "transparent",
      text: undefined,
      originalText: undefined,
      fontSize: undefined,
      fontFamily: undefined,
      textAlign: undefined,
      verticalAlign: undefined,
      lineHeight: undefined,
      autoResize: undefined,
      containerId: undefined,
      baseline: undefined,
    } as Partial<ExcalidrawElement>), type);
    for (const key of ["text", "originalText", "fontSize", "fontFamily", "textAlign", "verticalAlign", "lineHeight", "autoResize", "containerId", "baseline"]) {
      delete (container as Record<string, unknown>)[key];
    }
    txn.put(container);
    attachLabel(txn, container.id, {
      text: source,
      color: current.strokeColor,
      fontSize,
      fontFamily,
      textAlign: asTextAlign(view.textAlign),
      verticalAlign: "middle",
    });
    followShapes(txn, [container.id], { skipLabels: true });
    return txn.live(container.id) ?? container;
  }
  if (SHAPE_TYPES.has(from) && type === "text") {
    const label = boundTextOf(txn, current);
    if (!label) {
      throw invalidArgs(`${current.id} has no label to turn into text`, { ids: [current.id] });
    }
    const view = asText(label);
    const source = labelSource(label);
    const layout = layoutText(source, view.fontSize ?? DEFAULT_FONT_SIZE, view.fontFamily ?? DEFAULT_FONT_FAMILY);
    const text = retype(applyUpdate(current, {
      x: label.x,
      y: label.y,
      width: layout.width,
      height: layout.height,
      text: layout.text,
      originalText: source,
      fontSize: view.fontSize ?? DEFAULT_FONT_SIZE,
      fontFamily: view.fontFamily ?? DEFAULT_FONT_FAMILY,
      textAlign: view.textAlign ?? "left",
      verticalAlign: "top",
      lineHeight: layout.lineHeight,
      autoResize: true,
      containerId: null,
      strokeColor: label.strokeColor,
      backgroundColor: "transparent",
      boundElements: (current.boundElements ?? []).filter((ref) => ref.id !== label.id),
    } as Partial<ExcalidrawElement>), "text");
    txn.put(text);
    txn.put(markDeleted(label));
    txn.report.deleted.add(label.id);
    followShapes(txn, [text.id], { skipLabels: true });
    return text;
  }
  if (from === "arrow" && type === "line") {
    const linear = asLinear(current);
    for (const binding of [linear.startBinding, linear.endBinding]) {
      if (binding) {
        removeBackref(txn, binding.elementId, current.id);
      }
    }
    const label = boundTextOf(txn, current);
    if (label) {
      txn.put(applyUpdate(label, { containerId: null } as Partial<ExcalidrawElement>));
      txn.report.collateral.push({ id: label.id, reason: "lines cannot hold labels: it became free text" });
    }
    const next = retype(applyUpdate(txn.live(current.id) ?? current, {
      startBinding: null,
      endBinding: null,
      startArrowhead: null,
      endArrowhead: null,
      boundElements: (current.boundElements ?? []).filter((ref) => ref.id !== label?.id),
    } as Partial<ExcalidrawElement>), "line");
    txn.put(next);
    return next;
  }
  if (from === "line" && type === "arrow") {
    const next = retype(applyUpdate(current, {
      endArrowhead: "arrow",
      elbowed: false,
    } as Partial<ExcalidrawElement>), "arrow");
    txn.put(next);
    return next;
  }
  throw invalidArgs(
    `cannot change ${current.id} from ${from} to ${type}; allowed: rectangle/ellipse/diamond ↔ each other, text ↔ rectangle/ellipse/diamond, arrow ↔ line`,
    { ids: [current.id], field: "type" },
  );
};

// ---- arrows ------------------------------------------------------------

const bindingTarget = (value: unknown): string | null | undefined => {
  if (value === null) {
    return null;
  }
  if (value && typeof value === "object" && typeof (value as { elementId?: unknown }).elementId === "string") {
    return (value as { elementId: string }).elementId;
  }
  return undefined;
};

const bindingFixed = (value: unknown): Point | undefined => {
  const fixedPoint = (value as { fixedPoint?: unknown } | undefined)?.fixedPoint;
  return Array.isArray(fixedPoint) && fixedPoint.length === 2 ? (fixedPoint as Point) : undefined;
};

const rebindArrow = (
  txn: SceneTxn,
  current: ExcalidrawElement,
  patch: Patch,
  anchors: Map<string, Anchor>,
): void => {
  if (!isLinear(current)) {
    for (const field of ARROW_FIELDS) {
      if (has(patch, field)) {
        txn.report.ignore(current.id, field, `${current.type} is not an arrow`);
      }
    }
    return;
  }
  const linear = asLinear(current);
  const oldFrom = linear.startBinding?.elementId ?? null;
  const oldTo = linear.endBinding?.elementId ?? null;
  const nextFrom =
    (patch.fromId as string | undefined) ??
    (has(patch, "startBinding") ? bindingTarget(patch.startBinding) : undefined) ??
    (patch.startBinding === null ? null : oldFrom);
  const nextTo =
    (patch.toId as string | undefined) ??
    (has(patch, "endBinding") ? bindingTarget(patch.endBinding) : undefined) ??
    (patch.endBinding === null ? null : oldTo);
  const fromChanged = nextFrom !== oldFrom;
  const toChanged = nextTo !== oldTo;
  const waypoints = patch.waypoints as Point[] | undefined;
  let route = patch.route as RouteKind | undefined;
  const startAnchor = anchors.get(`${current.id}:start`) ?? (patch.startAnchor as Anchor | undefined);
  const endAnchor = anchors.get(`${current.id}:end`) ?? (patch.endAnchor as Anchor | undefined);

  if (current.type === "line" && (nextFrom || nextTo) && (fromChanged || toChanged)) {
    txn.report.ignore(current.id, fromChanged ? "fromId" : "toId", "lines cannot bind to shapes", 'change the type: {type:"arrow"}');
    return;
  }

  // Keep the path's character when only one detail changes: an elbow stays
  // an elbow, a hand-made detour keeps its bends while the ends stay bound.
  let keptWaypoints: Point[] | undefined;
  if (waypoints === undefined && route === undefined) {
    const shape = inferRoute(current);
    if (shape === "orthogonal") {
      route = "orthogonal";
    } else if (shape === "waypoints" && !fromChanged && !toChanged) {
      const points = linear.points ?? [];
      keptWaypoints = points.slice(1, -1).map(([px, py]) => [current.x + px, current.y + py] as Point);
    }
  }

  if (nextFrom && nextTo) {
    const plan = planArrowBetween(txn, {
      arrowId: current.id,
      fromId: nextFrom,
      toId: nextTo,
      mode: (patch.bindMode as "inside" | "orbit" | "skip" | undefined) ?? linear.startBinding?.mode,
      waypoints: waypoints ?? keptWaypoints,
      route,
      startAnchor,
      endAnchor,
      startFixed:
        startAnchor || fromChanged
          ? bindingFixed(patch.startBinding)
          : linear.startBinding?.fixedPoint,
      endFixed:
        endAnchor || toChanged ? bindingFixed(patch.endBinding) : linear.endBinding?.fixedPoint,
    });
    const { warnings: _warnings, ...geometry } = plan;
    txn.put(applyUpdate(txn.live(current.id) ?? current, geometry));
  } else {
    // Half-bound or free: keep the free ends, reshape the detour, and bind the
    // end that now has a target.
    let base = txn.live(current.id) ?? current;
    if (waypoints !== undefined || route !== undefined) {
      base = applyUpdate(base, reshapeFreeArrow(base, { waypoints, route: route === "straight" ? "direct" : route }));
    }
    const patchBindings: Record<string, unknown> = {
      ...(nextFrom === null ? { startBinding: null } : {}),
      ...(nextTo === null ? { endBinding: null } : {}),
    };
    const mode = (patch.bindMode as "inside" | "orbit" | "skip" | undefined) ?? linear.startBinding?.mode ?? linear.endBinding?.mode;
    for (const [which, target, changed, anchor] of [
      ["start", nextFrom, fromChanged, startAnchor],
      ["end", nextTo, toChanged, endAnchor],
    ] as const) {
      if (!target || (!changed && !anchor)) continue;
      const shape = resolveBindable(txn, target, which === "start" ? "arrow source" : "arrow target");
      const half = planHalfBound(base, which, shape, { mode, anchor });
      base = applyUpdate(base, { ...half.geometry, [`${which}Binding`]: half.binding } as Partial<ExcalidrawElement>);
    }
    txn.put(applyUpdate(base, patchBindings as Partial<ExcalidrawElement>));
  }
  if (fromChanged && oldFrom) removeBackref(txn, oldFrom, current.id);
  if (toChanged && oldTo) removeBackref(txn, oldTo, current.id);
  for (const target of [nextFrom, nextTo]) {
    if (!target) continue;
    const shape = txn.live(target);
    if (shape && !(shape.boundElements ?? []).some((ref) => ref.id === current.id)) {
      txn.put(applyUpdate(shape, { boundElements: [...(shape.boundElements ?? []), { id: current.id, type: "arrow" }] }));
    }
  }
  txn.report.rerouted.add(current.id);
  relayoutLabel(txn, current.id);
};

// ---- labels ------------------------------------------------------------

const updateLabel = (txn: SceneTxn, container: ExcalidrawElement, patch: Patch, roleLabelColor?: string): void => {
  const style: Partial<LabelStyle> = {};
  if (typeof patch.labelFontSize === "number") style.fontSize = patch.labelFontSize;
  else if (typeof patch.fontSize === "number") style.fontSize = patch.fontSize;
  if (typeof patch.labelFontFamily === "number") style.fontFamily = patch.labelFontFamily;
  else if (typeof patch.fontFamily === "number") style.fontFamily = patch.fontFamily;
  if (has(patch, "textAlign")) style.textAlign = asTextAlign(patch.textAlign);
  if (has(patch, "verticalAlign")) style.verticalAlign = asVerticalAlign(patch.verticalAlign);
  const color = (patch.labelColor as string | undefined) ?? roleLabelColor;
  const existing = boundTextOf(txn, container);
  const wrap = patch.wrap as WrapMode | undefined;
  const nowrap = patch.nowrap as string[] | undefined;
  let text = typeof patch.label === "string" ? patch.label : undefined;
  if (existing && (wrap === "balanced" || nowrap?.length)) {
    const base = labelStyleOf(existing);
    text = bakeLineBreaks(
      (text ?? labelSource(existing)).replace(/\s*\n\s*/g, " "),
      style.fontSize ?? base.fontSize,
      style.fontFamily ?? base.fontFamily,
      getBoundTextMaxWidth(container, style.fontSize ?? base.fontSize),
      { wrap, nowrap },
    );
  }
  if (!existing) {
    if (text === undefined) {
      for (const field of ["labelFontSize", "labelFontFamily", "labelColor", ...LABEL_STYLE_FIELDS]) {
        if (has(patch, field)) {
          txn.report.ignore(container.id, field, `${container.id} has no label`, "add one with `label`");
        }
      }
      return;
    }
    const base = labelStyleOf(undefined);
    attachLabel(txn, container.id, {
      text,
      color: color ?? undefined,
      fontSize: style.fontSize ?? base.fontSize,
      fontFamily: style.fontFamily ?? base.fontFamily,
      textAlign: style.textAlign ?? base.textAlign,
      verticalAlign: style.verticalAlign ?? base.verticalAlign,
      fit: patch.fit as "none" | "width" | "height" | "both" | undefined,
      wrap,
      nowrap,
    });
    return;
  }
  const touchesLabel =
    text !== undefined || Object.keys(style).length > 0 || color !== undefined;
  if (!touchesLabel) {
    return;
  }
  relayoutLabel(txn, container.id, {
    text,
    style,
    keepContainerHeight: has(patch, "height") || patch.fit === "none",
    keepContainerWidth: has(patch, "width") || patch.fit !== "width" && patch.fit !== "both",
    extraTextPatch: color !== undefined ? { strokeColor: color } : undefined,
  });
};

// Grow a container so its label fits (I20): height keeps the width and adds
// lines, width widens to the longest line, both does both.
const fitToLabel = (txn: SceneTxn, id: string, fit: string): void => {
  if (fit === "none") return;
  const container = txn.live(id);
  if (!container) return;
  const label = boundTextOf(txn, container);
  if (!label) {
    txn.report.ignore(id, "fit", `${id} has no label to fit`);
    return;
  }
  const view = asText(label);
  const source = labelSource(label);
  const fontSize = view.fontSize ?? DEFAULT_FONT_SIZE;
  const fontFamily = view.fontFamily ?? DEFAULT_FONT_FAMILY;
  const before = { width: container.width, height: container.height };
  const unwrapped = layoutText(source, fontSize, fontFamily);
  const patch: Partial<ExcalidrawElement> = {};
  if (fit === "width" || fit === "both") {
    const width = comfortableDimension(unwrapped.width, container.type);
    if (width !== container.width) patch.width = width;
  }
  if (fit === "height" || fit === "both") {
    const width = patch.width ?? container.width;
    const probe = { ...container, width } as ExcalidrawElement;
    const layoutWidth = Math.max(1, getBoundTextMaxWidth(probe, fontSize) - 2 * (COMFORT_PADDING - 5));
    const wrapped = layoutText(source, fontSize, fontFamily, layoutWidth);
    const height = comfortableDimension(wrapped.height, probe.type);
    if (height !== container.height) patch.height = height;
  }
  if (!Object.keys(patch).length) return;
  txn.put(applyUpdate(container, patch));
  followShapes(txn, [id]);
  const after = txn.live(id)!;
  txn.report.fit.push({
    id,
    ...(after.height > before.height || after.width > before.width
      ? { grewTo: { width: after.width, height: after.height } }
      : {}),
  });
};

// ---- frames ------------------------------------------------------------

export const fitFrameToChildren = (
  txn: SceneTxn,
  frameId: string,
  options: { padding?: number; titleGap?: number; grow?: "right" | "down" | "both"; shrink?: boolean } = {},
): void => {
  const frame = txn.live(frameId);
  if (!frame || frame.type !== "frame") {
    throw invalidArgs(`${frameId} is not a frame`, { ids: [frameId] });
  }
  const children = txn.liveElements().filter((element) => element.frameId === frameId);
  if (!children.length) {
    return;
  }
  const padding = options.padding ?? 24;
  const titleGap = options.titleGap ?? 0;
  const [x1, y1, x2, y2] = getCommonBounds(children);
  const want = {
    x: x1 - padding,
    y: y1 - padding - titleGap,
    width: x2 - x1 + padding * 2,
    height: y2 - y1 + padding * 2 + titleGap,
  };
  const grow = options.grow ?? "both";
  const shrink = options.shrink ?? true;
  const next: Partial<ExcalidrawElement> = {};
  const right = Math.max(want.x + want.width, shrink ? -Infinity : frame.x + frame.width);
  const bottom = Math.max(want.y + want.height, shrink ? -Infinity : frame.y + frame.height);
  const left = shrink ? want.x : Math.min(want.x, frame.x);
  const top = shrink ? want.y : Math.min(want.y, frame.y);
  if (grow === "both" || grow === "right") {
    next.x = left;
    next.width = right - left;
  }
  if (grow === "both" || grow === "down") {
    next.y = top;
    next.height = bottom - top;
  }
  txn.put(applyUpdate(frame, next));
};

// ---- containerId -------------------------------------------------------

const bindTextTo = (txn: SceneTxn, text: ExcalidrawElement, containerId: string | null): void => {
  const view = asText(text);
  const currentContainer = typeof view.containerId === "string" ? view.containerId : null;
  if (containerId === currentContainer) {
    return;
  }
  if (currentContainer) {
    removeBackref(txn, currentContainer, text.id);
  }
  if (containerId === null) {
    txn.put(applyUpdate(txn.live(text.id) ?? text, { containerId: null, autoResize: true } as Partial<ExcalidrawElement>));
    return;
  }
  const container = txn.live(containerId);
  if (!container) {
    throw notFound(`container not found: ${containerId}`, [containerId]);
  }
  if (!CONTAINER_TYPES.has(container.type) && container.type !== "arrow") {
    throw invalidArgs(`${containerId} (${container.type}) cannot hold a label`, { ids: [containerId] });
  }
  const existing = boundTextOf(txn, container);
  if (existing && existing.id !== text.id) {
    throw invalidArgs(`${containerId} already has a label (${existing.id})`, { ids: [containerId, existing.id] });
  }
  txn.put(
    applyUpdate(txn.live(text.id) ?? text, {
      containerId,
      frameId: container.frameId ?? null,
      originalText: labelSource(text).replace(/\s*\n\s*/g, " "),
      textAlign: container.type === "arrow" ? "center" : view.textAlign ?? "center",
      verticalAlign: "middle",
      angle: 0,
    } as Partial<ExcalidrawElement>),
  );
  txn.put(
    applyUpdate(container, {
      boundElements: [...(container.boundElements ?? []), { id: text.id, type: "text" }],
    }),
  );
  txn.report.labels[containerId] = text.id;
  relayoutLabel(txn, containerId);
};

// ---- the patch loop ----------------------------------------------------

export const updateItems = (
  txn: SceneTxn,
  patches: Patch[],
  ctx: UpdateContext = {},
): { updated: string[] } => {
  const updated: string[] = [];
  const anchorRequests: Array<{ key: string; shapeId: string; anchor: Anchor | undefined; ownArrowId?: string }> = [];
  for (const patch of patches) {
    const id = resolveElementId(txn, String(patch.id));
    const current = txn.live(id);
    if (!current || !isLinear(current)) continue;
    const linear = asLinear(current);
    const from = (patch.fromId as string | undefined) ?? linear.startBinding?.elementId;
    const to = (patch.toId as string | undefined) ?? linear.endBinding?.elementId;
    if (from && patch.startAnchor) anchorRequests.push({ key: `${id}:start`, shapeId: from, anchor: patch.startAnchor as Anchor, ownArrowId: id });
    if (to && patch.endAnchor) anchorRequests.push({ key: `${id}:end`, shapeId: to, anchor: patch.endAnchor as Anchor, ownArrowId: id });
  }
  const anchors = spreadAnchors(txn, anchorRequests);

  for (const rawPatch of patches) {
    const id = resolveElementId(txn, String(rawPatch.id));
    const patch: Patch = expandStyleFrom(txn, { ...rawPatch, id }, (element) => boundTextOf(txn, element));
    let current = txn.live(id);
    if (!current) {
      txn.report.missing.push(String(rawPatch.id));
      continue;
    }
    if (!checkExpect(txn, current, patch)) {
      continue;
    }
    for (const key of Object.keys(patch)) {
      if (key === "id") continue;
      if (!KNOWN.has(key)) {
        const hint = READ_ONLY_HINTS[key];
        txn.report.ignore(id, key, hint ? "not writable" : "unknown field", hint);
      }
    }

    // 1. type
    if (has(patch, "type") && patch.type !== current.type) {
      current = changeType(txn, current, String(patch.type));
    }

    const isText = current.type === "text";
    const isBoundText = isText && typeof asText(current).containerId === "string";
    const canHoldLabel = CONTAINER_TYPES.has(current.type) || current.type === "arrow";

    // 2. plain fields
    const plain: Record<string, unknown> = {};
    for (const key of PLAIN_STYLE) {
      if (has(patch, key)) plain[key] = patch[key];
    }
    for (const key of GEOMETRY) {
      if (has(patch, key)) plain[key] = patch[key];
    }
    if (isBoundText) {
      for (const key of ["x", "y", "width", "height"]) {
        if (key in plain) {
          delete plain[key];
          txn.report.ignore(id, key, "a label is positioned by its container", `move or resize ${asText(current).containerId} instead`);
        }
      }
    }
    if (has(patch, "points")) {
      if (isLinear(current)) {
        const points = patch.points as Point[];
        plain.points = points;
        const xs = points.map(([px]) => px);
        const ys = points.map(([, py]) => py);
        plain.width = Math.max(...xs) - Math.min(...xs);
        plain.height = Math.max(...ys) - Math.min(...ys);
      } else {
        txn.report.ignore(id, "points", `${current.type} has no points`);
      }
    }
    if (has(patch, "startArrowhead") || has(patch, "endArrowhead")) {
      if (isLinear(current)) {
        if (has(patch, "startArrowhead")) plain.startArrowhead = patch.startArrowhead;
        if (has(patch, "endArrowhead")) plain.endArrowhead = patch.endArrowhead;
      } else {
        txn.report.ignore(id, has(patch, "startArrowhead") ? "startArrowhead" : "endArrowhead", `${current.type} has no arrowheads`);
      }
    }
    if (has(patch, "link")) {
      const link = patch.link;
      if (link === null || typeof link === "string") {
        plain.link = link;
      } else if (link && typeof link === "object") {
        const target = link as { boardId: string; frameId?: string };
        const url = ctx.linkFor?.(target.boardId, target.frameId);
        if (url) plain.link = url;
        else txn.report.ignore(id, "link", "the server has no public app URL configured to build board links");
      }
    }
    // Text fields on a text element; on a container they style its label.
    if (isText) {
      for (const key of TEXT_FIELDS) {
        if (has(patch, key)) plain[key] = patch[key];
      }
    } else if (has(patch, "text")) {
      txn.report.ignore(id, "text", `${current.type} has no text of its own`, canHoldLabel ? "set `label`" : undefined);
    }
    // Role recolors from the palette and is remembered on the element.
    let roleLabelColor: string | undefined;
    let style: ReturnType<typeof roleStyle> | undefined;
    if (has(patch, "role") || has(patch, "surface") || has(patch, "tone")) {
      const stored = current.customData as { role?: unknown; tone?: unknown } | undefined;
      style = roleStyle(current.type, {
        role: has(patch, "surface") ? undefined : patch.role ?? stored?.role,
        tone: has(patch, "tone") ? patch.tone : has(patch, "role") ? undefined : stored?.tone,
        surface: patch.surface,
        strokeColor: patch.strokeColor,
        backgroundColor: patch.backgroundColor,
        labelColor: patch.labelColor,
      });
      if (!style.role && !style.surface) {
        txn.report.ignore(id, "tone", "a tone needs a role", "pass role with tone");
      }
      if (style.strokeColor) plain.strokeColor = style.strokeColor;
      if (style.backgroundColor && !isText) plain.backgroundColor = style.backgroundColor;
      roleLabelColor = style.labelColor;
    }
    const customData = mergedCustomData(current, patch, style);
    if (customData) plain.customData = customData;
    if (has(patch, "frameId")) {
      const frameId = patch.frameId as string | null;
      if (frameId !== null && txn.live(frameId)?.type !== "frame") {
        throw notFound(`frame not found: ${frameId}`, [frameId]);
      }
      plain.frameId = frameId;
    }
    const geometryChanged = GEOMETRY.some((key) => key in plain && plain[key] !== (current as Record<string, unknown>)[key]);

    if (Object.keys(plain).length) {
      let next = applyUpdate(current, plain as Partial<ExcalidrawElement>);
      // Standalone text re-measures when its content or font changed.
      if (isText && !isBoundText && ["text", "fontSize", "fontFamily"].some((key) => key in plain)) {
        const view = asText(next);
        const fixedWidth =
          typeof plain.width === "number" ? (plain.width as number) : view.autoResize === false ? next.width : undefined;
        const layout = layoutText(
          String(plain.text ?? view.originalText ?? view.text ?? ""),
          view.fontSize ?? DEFAULT_FONT_SIZE,
          view.fontFamily ?? DEFAULT_FONT_FAMILY,
          fixedWidth,
        );
        next = {
          ...next,
          text: layout.text,
          originalText: typeof plain.text === "string" ? plain.text : view.originalText ?? layout.text,
          width: typeof plain.width === "number" ? (plain.width as number) : layout.width,
          height: typeof plain.height === "number" ? (plain.height as number) : layout.height,
          lineHeight: typeof plain.lineHeight === "number" ? (plain.lineHeight as number) : layout.lineHeight,
        };
      }
      txn.put(next);
      current = next;
      // A label rides with its container's frame.
      if ("frameId" in plain && !isText) {
        const label = boundTextOf(txn, current);
        if (label && label.frameId !== current.frameId) {
          txn.put(applyUpdate(label, { frameId: current.frameId ?? null }));
        }
      }
      if ("groupIds" in plain && !isText) {
        const label = boundTextOf(txn, current);
        if (label) {
          txn.put(applyUpdate(label, { groupIds: current.groupIds ?? [] }));
        }
      }
    }

    // 3. bound text edited directly: text and originalText move together and
    // the label is re-laid out inside its container.
    if (isBoundText) {
      const containerId = asText(current).containerId as string;
      const style: Partial<LabelStyle> = {};
      if (has(patch, "fontSize")) style.fontSize = patch.fontSize as number;
      if (has(patch, "fontFamily")) style.fontFamily = patch.fontFamily as number;
      if (has(patch, "textAlign")) style.textAlign = asTextAlign(patch.textAlign);
      if (has(patch, "verticalAlign")) style.verticalAlign = asVerticalAlign(patch.verticalAlign);
      if (has(patch, "text") || Object.keys(style).length) {
        relayoutLabel(txn, containerId, {
          text: has(patch, "text") ? String(patch.text) : undefined,
          style,
        });
      }
    }

    // 4. label on a container
    if (canHoldLabel) {
      const touches =
        has(patch, "label") ||
        has(patch, "labelFontSize") ||
        has(patch, "labelFontFamily") ||
        has(patch, "labelColor") ||
        roleLabelColor !== undefined ||
        has(patch, "wrap") ||
        has(patch, "nowrap") ||
        LABEL_STYLE_FIELDS.some((key) => has(patch, key));
      if (touches) {
        updateLabel(txn, txn.live(id)!, patch, roleLabelColor);
      }
    } else if (!isText) {
      for (const field of ["label", "labelFontSize", "labelFontFamily", "labelColor", ...LABEL_STYLE_FIELDS]) {
        if (has(patch, field)) {
          txn.report.ignore(id, field, `a ${current.type} cannot hold a label`);
        }
      }
    }

    // 5. arrow bindings and routes
    if (ARROW_FIELDS.some((key) => has(patch, key)) || anchors.has(`${id}:start`) || anchors.has(`${id}:end`)) {
      rebindArrow(txn, txn.live(id)!, patch, anchors);
    }

    // 6. text ↔ container binding
    if (has(patch, "containerId") || patch.containerId === null) {
      if (current.type !== "text") {
        txn.report.ignore(id, "containerId", "only text binds to a container");
      } else {
        bindTextTo(txn, txn.live(id)!, (patch.containerId as string | null) ?? null);
      }
    }

    // 7. geometry follow-ups: label and bound arrows follow the shape. An
    // explicit size in the same patch wins over growing the box to its label.
    if (geometryChanged && !isBoundText) {
      if (isLinear(current)) {
        relayoutLabel(txn, id);
      } else {
        relayoutLabel(txn, id, {
          keepContainerHeight: has(patch, "height"),
          keepContainerWidth: has(patch, "width"),
        });
        followShapes(txn, [id], { skipLabels: true });
      }
    }

    // 8. dx/dy: the same operation as move_elements
    if (has(patch, "dx") || has(patch, "dy")) {
      moveElements(txn, [txn.live(id)!], Number(patch.dx ?? 0), Number(patch.dy ?? 0));
    }

    // 9. fit
    if (has(patch, "fit") && canHoldLabel) {
      fitToLabel(txn, id, String(patch.fit));
    }

    // 10. stack membership
    if (has(patch, "stack") || patch.stack === null) {
      const stack = patch.stack as { id: string; insertAt?: number } | null;
      if (stack === null) {
        removeFromStack(txn, id);
      } else {
        insertIntoStack(txn, stack.id, id, stack.insertAt);
      }
    }

    // 11. frame refit
    if (has(patch, "fitToChildren")) {
      fitFrameToChildren(txn, id, patch.fitToChildren as Parameters<typeof fitFrameToChildren>[2]);
    }

    updated.push(id);
  }
  return { updated };
};

export const labelIdOf = labelIdFor;
export const customDataFor = customDataOf;
