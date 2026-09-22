import {randomUUID} from "crypto";

import type {ExcalidrawElement} from "../types";
import {applyUpdate, type CreateAttrs} from "../elements";
import {labelIdFor} from "../customData";
import {asLinear, asText, CONTAINER_TYPES, DEFAULT_FONT_FAMILY, DEFAULT_FONT_SIZE, isBindable, isLinear, type Point,} from "../verify/model";
import {getBoundTextMaxWidth, getLineWidth, measureText, normalizeText} from "../verify/textMetrics";
import {type Anchor, anchorFixedPoint, planBoundArrowPath, type RouteKind, sideOfFixedPoint} from "./arrows";
import {
  asTextAlign,
  asVerticalAlign,
  bakeLineBreaks,
  comfortableDimension,
  layoutLabel,
  type WrapMode,
} from "./boundText";
import {expandStyleFrom, indexJustAbove, mergedCustomData, pickDefined, putNewElement, roleStyle} from "./common";
import {invalidArgs, notFound, ToolError} from "./errors";
import {boundTextOf, relayoutLabel} from "./follow";
import type {SceneTxn} from "./txn";

export type Fit = "none" | "width" | "height" | "both";

export type CreateItem = CreateAttrs & {
  kind?: string;
  slot?: string;
  protected?: boolean;
  tone?: string;
  surface?: string;
  startAnchor?: Anchor;
  endAnchor?: Anchor;
  route?: RouteKind;
  relative?: boolean;
  fit?: Fit;
};

export type OnExisting = "revive" | "error" | "replace";

export type CreateContext = {
  onExisting?: OnExisting;
  // Board-profile patterns that must never be split across lines.
  nowrap?: string[];
  linkFor?: (boardId: string, frameId?: string) => string | undefined;
  // Upsert path for onExisting:"replace" on a live id (the update engine).
  replace?: (txn: SceneTxn, id: string, item: CreateItem) => void;
};

const SERVER_KEYS = [
  "role",
  "tone",
  "surface",
  "label",
  "labelColor",
  "labelFontSize",
  "labelFontFamily",
  "lintIgnore",
  "kind",
  "slot",
  "protected",
  "fromId",
  "toId",
  "bindMode",
  "waypoints",
  "route",
  "startAnchor",
  "endAnchor",
  "relative",
  "fit",
  "styleFrom",
] as const;

const LABEL_STYLE_KEYS = ["fontSize", "fontFamily", "textAlign", "verticalAlign"] as const;

const withoutServerKeys = (item: CreateItem, dropLabelStyle: boolean): Record<string, unknown> => {
  const rest: Record<string, unknown> = { ...item };
  for (const key of SERVER_KEYS) {
    delete rest[key];
  }
  if (dropLabelStyle) {
    for (const key of LABEL_STYLE_KEYS) {
      delete rest[key];
    }
  }
  return rest;
};

type LabelSpec = {
  text: string;
  wrap?: WrapMode;
  nowrap?: string[];
  color?: string;
  fontSize: number;
  fontFamily: number;
  textAlign: "left" | "center" | "right";
  verticalAlign: "top" | "middle" | "bottom";
  fit?: Fit;
};

const labelSpecOf = (item: CreateItem, color?: string, nowrap?: string[]): LabelSpec => ({
  text: String(item.label ?? ""),
  color: (item.labelColor as string | undefined) ?? color,
  fontSize:
    (item.labelFontSize as number | undefined) ??
    (typeof item.fontSize === "number" ? item.fontSize : DEFAULT_FONT_SIZE),
  fontFamily:
    (item.labelFontFamily as number | undefined) ??
    (typeof item.fontFamily === "number" ? item.fontFamily : DEFAULT_FONT_FAMILY),
  textAlign: asTextAlign(item.textAlign),
  verticalAlign: asVerticalAlign(item.verticalAlign),
  fit: item.fit,
  wrap: (item as { wrap?: WrapMode }).wrap,
  nowrap: (item as { nowrap?: string[] }).nowrap ?? nowrap,
});

// Size a container so its label fits per `fit` before the label is laid out.
const fitContainer = (container: ExcalidrawElement, spec: LabelSpec): Partial<ExcalidrawElement> => {
  if (!spec.fit || spec.fit === "none" || spec.fit === "height" || isLinear(container)) {
    return {};
  }
  const lines = normalizeText(spec.text).split("\n");
  const widest = Math.max(...lines.map((line) => getLineWidth(line, spec.fontSize, spec.fontFamily)));
  const width = comfortableDimension(widest, container.type);
  if (spec.fit === "width") {
    return width > (container.width || 0) ? { width } : {};
  }
  const height = comfortableDimension(
    measureText(spec.text, spec.fontSize, spec.fontFamily).height,
    container.type,
  );
  return { width, height };
};

// Create the bound label of `container` (id `${container.id}:label`) and
// register it in the container's boundElements. The label inherits the
// container's frame so frame membership never diverges.
export const attachLabel = (
  txn: SceneTxn,
  containerId: string,
  specInput: LabelSpec,
  extra: Partial<ExcalidrawElement> = {},
): ExcalidrawElement => {
  let spec = specInput;
  let container = txn.live(containerId);
  if (!container) {
    throw notFound(`container not found: ${containerId}`, [containerId]);
  }
  if (!CONTAINER_TYPES.has(container.type) && container.type !== "arrow") {
    throw invalidArgs(`element ${containerId} (${container.type}) cannot hold a label; labels go on rectangle, ellipse, diamond or arrow`, {
      ids: [containerId],
    });
  }
  const existing = boundTextOf(txn, container);
  if (existing) {
    throw invalidArgs(
      `element ${containerId} already has a label (${existing.id}); change it with update_elements {id:"${containerId}", label}`,
      { ids: [containerId, existing.id] },
    );
  }
  if (spec.wrap === "balanced" || spec.nowrap?.length) {
    spec = {
      ...spec,
      text: bakeLineBreaks(spec.text, spec.fontSize, spec.fontFamily, getBoundTextMaxWidth(container, spec.fontSize), {
        wrap: spec.wrap,
        nowrap: spec.nowrap,
      }),
    };
  }
  if (spec.wrap === "none" && !spec.fit) {
    spec = { ...spec, fit: "width" };
  }
  const fitted = fitContainer(container, spec);
  if (Object.keys(fitted).length) {
    container = applyUpdate(container, fitted);
    txn.put(container);
    txn.report.fit.push({ id: container.id, grewTo: { width: container.width, height: container.height } });
  }
  const style = {
    fontSize: spec.fontSize,
    fontFamily: spec.fontFamily,
    textAlign: spec.textAlign,
    verticalAlign: spec.verticalAlign,
  };
  const layout = layoutLabel(container, spec.text, style);
  const wantedId = labelIdFor(container.id);
  const idTaken = !!txn.live(wantedId);
  const text = putNewElement(
    txn,
    {
      ...extra,
      id: idTaken ? randomUUID() : wantedId,
      type: "text",
      containerId: container.id,
      text: layout.text,
      originalText: spec.text,
      x: layout.x,
      y: layout.y,
      width: layout.width,
      height: layout.height,
      fontSize: spec.fontSize,
      fontFamily: spec.fontFamily,
      lineHeight: layout.lineHeight,
      strokeColor: spec.color ?? "#1e1e1e",
      textAlign: spec.textAlign,
      verticalAlign: spec.verticalAlign,
      autoResize: true,
      frameId: container.frameId ?? null,
      groupIds: container.groupIds ?? [],
      index: indexJustAbove(txn, container),
    },
    { inherit: false },
  );
  const refs = container.boundElements ?? [];
  container = applyUpdate(txn.live(container.id) ?? container, {
    boundElements: refs.some((ref) => ref.id === text.id) ? refs : [...refs, { id: text.id, type: "text" }],
  });
  txn.put(container);
  txn.report.labels[container.id] = text.id;
  // Let the container grow to the client's size for this label, and place it.
  relayoutLabel(txn, container.id, {
    keepContainerHeight: spec.fit === "none",
    keepContainerWidth: true,
  });
  return txn.live(text.id) ?? text;
};

const addBackref = (
  txn: SceneTxn,
  shapeId: string,
  ref: { id: string; type: string },
): void => {
  const shape = txn.live(shapeId);
  if (!shape) {
    return;
  }
  const refs = shape.boundElements ?? [];
  if (refs.some((entry) => entry.id === ref.id)) {
    return;
  }
  txn.put(applyUpdate(shape, { boundElements: [...refs, ref] }));
};

export const removeBackref = (txn: SceneTxn, shapeId: string, refId: string): void => {
  const shape = txn.live(shapeId);
  if (!shape || !(shape.boundElements ?? []).some((entry) => entry.id === refId)) {
    return;
  }
  const kept = (shape.boundElements ?? []).filter((entry) => entry.id !== refId);
  txn.put(applyUpdate(shape, { boundElements: kept.length ? kept : null }));
};

// Arrows on one side of a shape without an explicit `at` share it evenly
// instead of converging on the middle.
export const spreadAnchors = (
  txn: SceneTxn,
  requests: Array<{ key: string; shapeId: string; anchor: Anchor | undefined; ownArrowId?: string }>,
): Map<string, Anchor> => {
  const result = new Map<string, Anchor>();
  const bySide = new Map<string, typeof requests>();
  for (const request of requests) {
    if (!request.anchor || request.anchor.side === "center" || typeof request.anchor.at === "number") {
      if (request.anchor) {
        result.set(request.key, request.anchor);
      }
      continue;
    }
    const key = `${request.shapeId}|${request.anchor.side}`;
    const list = bySide.get(key) ?? [];
    list.push(request);
    bySide.set(key, list);
  }
  for (const [key, list] of bySide) {
    const [shapeId, side] = key.split("|") as [string, Anchor["side"]];
    const shape = txn.live(shapeId);
    const taken: number[] = [];
    for (const ref of shape?.boundElements ?? []) {
      if (ref.type !== "arrow" || list.some((request) => request.ownArrowId === ref.id)) {
        continue;
      }
      const arrow = txn.live(ref.id);
      if (!arrow) {
        continue;
      }
      const linear = asLinear(arrow);
      for (const binding of [linear.startBinding, linear.endBinding]) {
        if (binding?.elementId === shapeId && sideOfFixedPoint(binding.fixedPoint) === side) {
          const [fx, fy] = binding.fixedPoint;
          taken.push(side === "top" || side === "bottom" ? fx : fy);
        }
      }
    }
    const total = taken.length + list.length;
    const slots = Array.from({ length: total }, (_, i) => (i + 1) / (total + 1));
    const free = slots.filter(
      (slot) => !taken.some((at) => Math.abs(at - slot) < 0.5 / (total + 1)),
    );
    list.forEach((request, i) => {
      result.set(request.key, { side, at: free[i] ?? slots[Math.min(i, slots.length - 1)] });
    });
  }
  return result;
};

export type BindArrowInput = {
  arrowId: string;
  fromId: string;
  toId: string;
  mode?: "inside" | "orbit" | "skip";
  waypoints?: Point[];
  route?: RouteKind;
  startAnchor?: Anchor;
  endAnchor?: Anchor;
  startFixed?: Point;
  endFixed?: Point;
};

export const resolveBindable = (txn: SceneTxn, id: string, role: string): ExcalidrawElement => {
  const element = txn.live(id);
  if (!element) {
    throw notFound(`${role} not found: ${id}`, [id]);
  }
  if (!isBindable(element)) {
    throw invalidArgs(`${role} ${id} is a ${element.type}; arrows bind to shapes, text, images and frames`, {
      ids: [id],
    });
  }
  return element;
};

export const planArrowBetween = (txn: SceneTxn, input: BindArrowInput) => {
  if (input.fromId === input.toId) {
    throw invalidArgs("cannot connect an element to itself", { ids: [input.fromId] });
  }
  const from = resolveBindable(txn, input.fromId, "arrow source");
  const to = resolveBindable(txn, input.toId, "arrow target");
  const plan = planBoundArrowPath(from, to, {
    mode: input.mode,
    waypoints: input.waypoints,
    route: input.route,
    startAnchor: input.startAnchor,
    endAnchor: input.endAnchor,
    startFixed: input.startFixed,
    endFixed: input.endFixed,
  });
  for (const warning of plan.warnings) {
    txn.report.warnings.push(`${input.arrowId}: ${warning}`);
  }
  return plan;
};

const relativeOffset = (txn: SceneTxn, item: CreateItem): Point => {
  if (!item.relative) {
    return [0, 0];
  }
  if (typeof item.frameId !== "string") {
    throw invalidArgs("relative:true needs frameId (coordinates are measured from the frame's top-left corner)", {
      field: "relative",
    });
  }
  const frame = txn.live(item.frameId);
  if (!frame) {
    throw notFound(`frame not found: ${item.frameId}`, [item.frameId]);
  }
  return [frame.x, frame.y];
};

const resolveLink = (
  item: CreateItem,
  ctx: CreateContext,
): string | null | undefined => {
  const link = item.link as unknown;
  if (link === undefined || link === null || typeof link === "string") {
    return link as string | null | undefined;
  }
  const target = link as { boardId: string; frameId?: string };
  const url = ctx.linkFor?.(target.boardId, target.frameId);
  if (!url) {
    throw invalidArgs("cannot build a board link: the server has no public app URL configured", {
      field: "link",
    });
  }
  return url;
};

export const isBindingArrowItem = (item: CreateItem): boolean =>
  item.type === "arrow" && typeof item.fromId === "string" && typeof item.toId === "string";

export type CreateResult = { ids: string[] };

// Every key batch_create understands; the rest is reported, never written.
const CREATE_FIELDS = new Set([
  "type", "id", "role", "tone", "surface", "styleFrom", "kind", "slot", "protected",
  "x", "y", "width", "height", "relative", "angle",
  "strokeColor", "backgroundColor", "fillStyle", "strokeWidth", "strokeStyle", "roughness", "opacity", "roundness",
  "text", "originalText", "fontSize", "fontFamily", "textAlign", "verticalAlign", "lineHeight", "autoResize",
  "points", "waypoints", "route", "startAnchor", "endAnchor", "lintIgnore", "containerId",
  "label", "labelColor", "labelFontSize", "labelFontFamily", "fit", "wrap", "nowrap",
  "frameId", "fromId", "toId", "bindMode", "startArrowhead", "endArrowhead", "link",
  "fileId", "status", "scale", "groupIds", "name", "customData", "index", "locked",
]);

const dropUnknown = (txn: SceneTxn, item: CreateItem): CreateItem => {
  const unknown = Object.keys(item).filter((key) => !CREATE_FIELDS.has(key));
  if (!unknown.length) {
    return item;
  }
  const kept: Record<string, unknown> = { ...item };
  for (const key of unknown) {
    txn.report.ignore(typeof item.id === "string" ? item.id : `(new ${item.type})`, key, "unknown field");
    delete kept[key];
  }
  return kept as CreateItem;
};

export const createItems = (
  txn: SceneTxn,
  rawItems: CreateItem[],
  ctx: CreateContext = {},
): CreateResult => {
  const onExisting = ctx.onExisting ?? "revive";
  const ids: string[] = [];

  // Arrows whose `at` must be spread over a shared side get their anchors
  // resolved up front, for the whole call.
  const anchorRequests: Array<{ key: string; shapeId: string; anchor: Anchor | undefined }> = [];
  rawItems.forEach((item, i) => {
    if (isBindingArrowItem(item)) {
      anchorRequests.push({ key: `${i}:start`, shapeId: item.fromId as string, anchor: item.startAnchor });
      anchorRequests.push({ key: `${i}:end`, shapeId: item.toId as string, anchor: item.endAnchor });
    }
  });

  const processItem = (rawItem: CreateItem, index: number, anchors: Map<string, Anchor>) => {
    const item = expandStyleFrom(txn, dropUnknown(txn, rawItem), (element) => boundTextOf(txn, element));
    if (typeof item.type !== "string" || !item.type) {
      throw invalidArgs("every element needs a type", { field: "type" });
    }
    const explicitId = typeof item.id === "string" ? item.id : undefined;
    if (explicitId) {
      const previous = txn.get(explicitId);
      if (previous && !previous.isDeleted) {
        if (onExisting === "replace" && ctx.replace) {
          ctx.replace(txn, explicitId, item);
          ids.push(explicitId);
          return;
        }
        throw new ToolError(
          "conflict",
          `element ${explicitId} already exists; edit it with update_elements, or pass onExisting:"replace"`,
          { retryable: false, details: { ids: [explicitId], hint: "update_elements" } },
        );
      }
      if (previous && onExisting === "error") {
        throw new ToolError(
          "conflict",
          `element ${explicitId} was deleted; pass onExisting:"revive" (default) to bring the id back`,
          { retryable: false, details: { ids: [explicitId] } },
        );
      }
    }
    const style = roleStyle(item.type, item);
    const [offsetX, offsetY] = relativeOffset(txn, item);
    const link = resolveLink(item, ctx);
    const hasLabel = typeof item.label === "string";
    const base = withoutServerKeys(item, hasLabel);
    const customData = mergedCustomData(undefined, item as Record<string, unknown>, style);
    const attrs: Partial<ExcalidrawElement> & { type: string } = {
      ...base,
      ...pickDefined({
        strokeColor: style.strokeColor,
        backgroundColor: style.backgroundColor,
      }),
      ...(typeof item.x === "number" ? { x: item.x + offsetX } : {}),
      ...(typeof item.y === "number" ? { y: item.y + offsetY } : {}),
      ...(customData ? { customData } : {}),
      ...(link !== undefined ? { link } : {}),
      type: item.type,
    } as Partial<ExcalidrawElement> & { type: string };
    delete (attrs as Record<string, unknown>).link;
    if (link !== undefined) {
      attrs.link = link;
    }

    if (isBindingArrowItem(item)) {
      const arrowId = explicitId ?? randomUUID();
      const plan = planArrowBetween(txn, {
        arrowId,
        fromId: item.fromId as string,
        toId: item.toId as string,
        mode: item.bindMode,
        waypoints: item.waypoints,
        route: item.route,
        startAnchor: anchors.get(`${index}:start`) ?? item.startAnchor,
        endAnchor: anchors.get(`${index}:end`) ?? item.endAnchor,
      });
      const { warnings: _warnings, ...geometry } = plan;
      const arrow = putNewElement(txn, {
        ...attrs,
        ...geometry,
        id: arrowId,
        type: "arrow",
        elbowed: false,
        startArrowhead: item.startArrowhead ?? null,
        endArrowhead: item.endArrowhead === undefined ? "arrow" : item.endArrowhead,
      });
      addBackref(txn, item.fromId as string, { id: arrow.id, type: "arrow" });
      addBackref(txn, item.toId as string, { id: arrow.id, type: "arrow" });
      ids.push(arrow.id);
      if (hasLabel) {
        attachLabel(txn, arrow.id, labelSpecOf(item, style.labelColor, ctx.nowrap));
      }
      return;
    }

    if (item.type === "text" && typeof item.containerId === "string") {
      const container = txn.live(item.containerId);
      if (!container) {
        throw notFound(`container not found: ${item.containerId}`, [item.containerId]);
      }
      const label = attachLabel(txn, container.id, {
        text: String(item.text ?? item.label ?? ""),
        color: typeof item.strokeColor === "string" ? item.strokeColor : style.strokeColor,
        fontSize: typeof item.fontSize === "number" ? item.fontSize : DEFAULT_FONT_SIZE,
        fontFamily: typeof item.fontFamily === "number" ? item.fontFamily : DEFAULT_FONT_FAMILY,
        textAlign: asTextAlign(item.textAlign),
        verticalAlign: asVerticalAlign(item.verticalAlign),
      });
      ids.push(label.id);
      return;
    }

    if (item.type === "line" && (item.fromId || item.toId)) {
      throw invalidArgs("only arrows bind to shapes; use type:\"arrow\" (set endArrowhead:null for a plain connector)", {
        field: "fromId",
      });
    }

    if (item.type !== "text" && typeof (attrs as Record<string, unknown>).text === "string") {
      txn.report.ignore(explicitId ?? `(new ${item.type})`, "text", `a ${item.type} has no text of its own`, "use `label`");
      delete (attrs as Record<string, unknown>).text;
      delete (attrs as Record<string, unknown>).originalText;
    }
    const element = putNewElement(txn, attrs);
    ids.push(element.id);
    if (hasLabel) {
      if (!CONTAINER_TYPES.has(element.type) && element.type !== "arrow") {
        txn.report.ignore(element.id, "label", `a ${element.type} cannot hold a label`, "put the text in a rectangle/ellipse/diamond/arrow, or create a text element");
        return;
      }
      attachLabel(txn, element.id, labelSpecOf(item, style.labelColor, ctx.nowrap));
    }
  };

  // Arrows whose endpoints are created later in the same batch are bound in a
  // second pass, so `[arrow, shapeA, shapeB]` ordering works.
  const deferred: Array<[CreateItem, number]> = [];
  let anchors = spreadAnchors(txn, anchorRequests);
  rawItems.forEach((item, i) => {
    if (
      isBindingArrowItem(item) &&
      (!txn.live(item.fromId as string) || !txn.live(item.toId as string))
    ) {
      deferred.push([item, i]);
      return;
    }
    processItem(item, i, anchors);
  });
  if (deferred.length) {
    anchors = spreadAnchors(txn, anchorRequests);
    for (const [item, i] of deferred) {
      processItem(item, i, anchors);
    }
  }
  return { ids };
};

// Where a stored binding sits, as an anchor (for keeping ends on rebind).
export const anchorOfBinding = (
  binding: { fixedPoint: Point } | null | undefined,
): Anchor | undefined => {
  if (!binding) {
    return undefined;
  }
  const side = sideOfFixedPoint(binding.fixedPoint);
  if (!side) {
    return undefined;
  }
  const [fx, fy] = binding.fixedPoint;
  return { side, at: side === "top" || side === "bottom" ? fx : fy };
};

export {anchorFixedPoint, asText};
