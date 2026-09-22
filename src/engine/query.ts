import type {ExcalidrawElement} from "../types";
import {kindOf, roleOf} from "../customData";
import {asLinear, asText, type FrameView, isLinear} from "../verify/model";
import {getCommonBounds, getElementBounds} from "../verify/geometry";
import {textOfElement} from "./selector";
import {resolveRole} from "../verify/styles";

// A role is remembered on the element; if its colors were changed by hand
// afterwards, say so instead of silently reporting the role.
const roleMismatch = (element: ExcalidrawElement, role: string): boolean => {
  const tone = (element.customData as { tone?: unknown } | undefined)?.tone === "subtle" ? "subtle" : "solid";
  const palette = resolveRole(role, tone);
  if (!palette) return false;
  const same = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
  if (element.type === "text") {
    return !same(element.strokeColor, palette.labelColor);
  }
  return !same(element.strokeColor, palette.strokeColor) || !same(element.backgroundColor, palette.backgroundColor);
};

export type QueryFormat = "json" | "rows" | "md" | "graph";

export type QueryOptions = {
  fields?: string[];
  labels?: "inline" | "separate";
  format?: QueryFormat;
  order?: "z" | "reading";
  aggregate?: "bounds";
  maxChars?: number;
  cursor?: string;
  limit?: number;
};

export const DEFAULT_MAX_CHARS = 20_000;

const round = (value: number): number => Math.round(value * 10) / 10;

const byIndex = (a: ExcalidrawElement, b: ExcalidrawElement): number => {
  const ai = typeof a.index === "string" ? a.index : "";
  const bi = typeof b.index === "string" ? b.index : "";
  return ai < bi ? -1 : ai > bi ? 1 : 0;
};

const isFrame = (element: ExcalidrawElement): boolean =>
  element.type === "frame" || element.type === "magicframe";

const isLabel = (element: ExcalidrawElement, byId: ReadonlyMap<string, ExcalidrawElement>): boolean => {
  const containerId = asText(element).containerId;
  return element.type === "text" && typeof containerId === "string" && byId.has(containerId);
};

type Context = {
  byId: Map<string, ExcalidrawElement>;
  labelOf: Map<string, ExcalidrawElement>;
};

const contextOf = (scene: readonly ExcalidrawElement[]): Context => {
  const byId = new Map(scene.map((element) => [element.id, element] as const));
  const labelOf = new Map<string, ExcalidrawElement>();
  for (const element of scene) {
    if (isLabel(element, byId)) {
      labelOf.set(asText(element).containerId as string, element);
    }
  }
  return { byId, labelOf };
};

// The compact default view of an element: geometry, text (a container's
// label inline), frame, semantic role/kind and arrow endpoints.
const summaryOf = (element: ExcalidrawElement, ctx: Context, inlineLabels: boolean): Record<string, unknown> => {
  const summary: Record<string, unknown> = {
    id: element.id,
    type: element.type,
    x: round(element.x),
    y: round(element.y),
    w: round(element.width || 0),
    h: round(element.height || 0),
  };
  if (element.type === "text") {
    summary.text = String(asText(element).originalText ?? asText(element).text ?? "");
    const containerId = asText(element).containerId;
    if (typeof containerId === "string") summary.containerId = containerId;
  } else if (inlineLabels) {
    const label = ctx.labelOf.get(element.id);
    if (label) {
      summary.label = String(asText(label).originalText ?? asText(label).text ?? "");
      summary.labelId = label.id;
    }
  }
  if (isFrame(element)) summary.name = (element as FrameView).name ?? null;
  if (element.frameId) summary.frameId = element.frameId;
  const role = roleOf(element);
  if (role) {
    summary.role = role;
    if (roleMismatch(element, role)) summary.roleMismatch = true;
  }
  const kind = kindOf(element);
  if (kind) summary.kind = kind;
  if (isLinear(element)) {
    const linear = asLinear(element);
    if (linear.startBinding) summary.from = linear.startBinding.elementId;
    if (linear.endBinding) summary.to = linear.endBinding.elementId;
  }
  if (element.groupIds?.length) summary.groupIds = element.groupIds;
  if (element.link) summary.link = element.link;
  return summary;
};

const projected = (
  element: ExcalidrawElement,
  fields: string[],
  ctx: Context,
): Record<string, unknown> => {
  if (fields.includes("*") || fields.includes("all")) {
    return { ...element };
  }
  const result: Record<string, unknown> = { id: element.id };
  for (const field of fields) {
    switch (field) {
      case "label": {
        const label = element.type === "text" ? element : ctx.labelOf.get(element.id);
        if (label) result.label = String(asText(label).originalText ?? asText(label).text ?? "");
        break;
      }
      case "role": {
        const role = roleOf(element);
        result.role = role ?? null;
        if (role && roleMismatch(element, role)) result.roleMismatch = true;
        break;
      }
      case "kind":
        result.kind = kindOf(element) ?? null;
        break;
      case "bbox": {
        const [x1, y1, x2, y2] = getElementBounds(element);
        result.bbox = [round(x1), round(y1), round(x2 - x1), round(y2 - y1)];
        break;
      }
      case "childCount":
        if (isFrame(element)) {
          let count = 0;
          for (const other of ctx.byId.values()) if (other.frameId === element.id) count++;
          result.childCount = count;
        }
        break;
      case "order": {
        const order = (element.customData as { order?: unknown } | undefined)?.order;
        if (order !== undefined) result.order = order;
        break;
      }
      case "from":
      case "to": {
        const linear = asLinear(element);
        const binding = field === "from" ? linear.startBinding : linear.endBinding;
        if (binding) result[field] = binding.elementId;
        break;
      }
      default:
        if (field in element) result[field] = (element as Record<string, unknown>)[field];
    }
  }
  return result;
};

const rowOf = (element: ExcalidrawElement, ctx: Context): string => {
  const text = textOfElement(element, ctx.labelOf).replace(/\s+/g, " ").trim();
  return [
    element.id,
    element.type,
    Math.round(element.x),
    Math.round(element.y),
    Math.round(element.width || 0),
    Math.round(element.height || 0),
    text ? JSON.stringify(text) : "",
  ]
    .join(" ")
    .trim();
};

// Frames in reading order (explicit customData.order first, then rows top to
// bottom, left to right), elements inside a frame likewise.
const readingSort = (elements: ExcalidrawElement[]): ExcalidrawElement[] => {
  const ROW = 24;
  return [...elements].sort((a, b) => {
    const oa = (a.customData as { order?: number } | undefined)?.order;
    const ob = (b.customData as { order?: number } | undefined)?.order;
    if (typeof oa === "number" && typeof ob === "number" && oa !== ob) return oa - ob;
    const ba = getElementBounds(a);
    const bb = getElementBounds(b);
    if (Math.abs(ba[1] - bb[1]) > ROW) return ba[1] - bb[1];
    return ba[0] - bb[0];
  });
};

const markdownOf = (items: readonly ExcalidrawElement[], ctx: Context): string => {
  const frames = readingSort(items.filter(isFrame));
  const byFrame = new Map<string | null, ExcalidrawElement[]>();
  for (const element of items) {
    if (isFrame(element) || isLabel(element, ctx.byId)) continue;
    const key = element.frameId && ctx.byId.has(element.frameId) ? element.frameId : null;
    const list = byFrame.get(key) ?? [];
    list.push(element);
    byFrame.set(key, list);
  }
  const lineOf = (element: ExcalidrawElement): string => {
    const text = textOfElement(element, ctx.labelOf).replace(/\s*\n\s*/g, " / ").trim();
    if (isLinear(element)) {
      const linear = asLinear(element);
      const from = linear.startBinding?.elementId ?? "·";
      const to = linear.endBinding?.elementId ?? "·";
      return `- ${element.id} (${from} → ${to})${text ? `: ${text}` : ""}`;
    }
    const tag = [element.type, roleOf(element), kindOf(element)].filter(Boolean).join("/");
    return `- ${element.id} [${tag}]${text ? `: ${text}` : ""}`;
  };
  const sections: string[] = [];
  const emit = (title: string, list: ExcalidrawElement[] | undefined) => {
    if (!list?.length) return;
    const shapes = readingSort(list.filter((element) => !isLinear(element)));
    const arrows = list.filter(isLinear);
    sections.push([title, ...shapes.map(lineOf), ...arrows.map(lineOf)].join("\n"));
  };
  for (const frame of frames) {
    emit(`## ${(frame as FrameView).name ?? frame.id} (${frame.id})`, byFrame.get(frame.id));
  }
  emit(frames.length ? "## (outside frames)" : "## board", byFrame.get(null));
  return sections.join("\n\n");
};

const graphOf = (items: readonly ExcalidrawElement[], ctx: Context): Record<string, unknown> => {
  const nodes: Array<Record<string, unknown>> = [];
  const edges: Array<Record<string, unknown>> = [];
  for (const element of items) {
    if (isLabel(element, ctx.byId) || isFrame(element)) continue;
    const label = textOfElement(element, ctx.labelOf);
    if (isLinear(element)) {
      const linear = asLinear(element);
      if (linear.startBinding && linear.endBinding) {
        edges.push({
          id: element.id,
          from: linear.startBinding.elementId,
          to: linear.endBinding.elementId,
          ...(label ? { label } : {}),
          ...(element.strokeStyle !== "solid" ? { strokeStyle: element.strokeStyle } : {}),
        });
      }
      continue;
    }
    if (element.type === "text") continue;
    nodes.push({
      id: element.id,
      label,
      ...(roleOf(element) ? { role: roleOf(element) } : {}),
      shape: element.type,
      ...(element.frameId ? { group: element.frameId } : {}),
    });
  }
  return { nodes, edges };
};

const encode = (offset: number): string => Buffer.from(String(offset)).toString("base64url");
const decode = (cursor: string | undefined): number => {
  if (!cursor) return 0;
  const value = Number(Buffer.from(cursor, "base64url").toString());
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
};

export type QueryResult = {
  total: number;
  count: number;
  items: unknown[] | string;
  nextCursor?: string;
  sceneVersion?: number;
  bounds?: { x: number; y: number; width: number; height: number };
};

// One response shape for every read, cut at maxChars with a cursor instead of
// overflowing the client.
export const runQuery = (
  scene: readonly ExcalidrawElement[],
  selected: readonly ExcalidrawElement[],
  options: QueryOptions,
): QueryResult => {
  const ctx = contextOf(scene);
  const inline = options.labels !== "separate";
  let items = [...selected].sort(byIndex);
  if (inline) {
    items = items.filter((element) => !isLabel(element, ctx.byId) || !selected.some((other) => other.id === asText(element).containerId));
  }
  if (options.order === "reading") {
    items = readingSort(items);
  }
  if (options.aggregate === "bounds") {
    const [x1, y1, x2, y2] = getCommonBounds(items);
    return {
      total: items.length,
      count: items.length,
      items: [],
      bounds: { x: round(x1), y: round(y1), width: round(x2 - x1), height: round(y2 - y1) },
    };
  }
  if (options.format === "md") {
    return { total: items.length, count: items.length, items: markdownOf(items, ctx) };
  }
  if (options.format === "graph") {
    const graph = graphOf(items, ctx);
    return { total: items.length, count: items.length, items: [graph] };
  }
  const maxChars = Math.max(1000, options.maxChars ?? DEFAULT_MAX_CHARS);
  const start = decode(options.cursor);
  const page: unknown[] = [];
  let used = 2;
  let i = start;
  for (; i < items.length; i++) {
    if (options.limit !== undefined && page.length >= options.limit) break;
    const element = items[i];
    const entry =
      options.format === "rows"
        ? rowOf(element, ctx)
        : options.fields?.length
          ? projected(element, options.fields, ctx)
          : summaryOf(element, ctx, inline);
    const size = JSON.stringify(entry).length + 1;
    if (page.length && used + size > maxChars) break;
    page.push(entry);
    used += size;
  }
  return {
    total: items.length,
    count: page.length,
    items: page,
    ...(i < items.length ? { nextCursor: encode(i) } : {}),
  };
};
