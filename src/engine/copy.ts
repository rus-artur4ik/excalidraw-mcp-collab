import {randomUUID} from "crypto";

import type {ExcalidrawElement} from "../types";
import {customDataOf, labelIdFor} from "../customData";
import {asLinear, asText, isLinear} from "../verify/model";
import {globalLinearPoints} from "../verify/geometry";
import type {CreateItem} from "./create";
import {invalidArgs} from "./errors";

export type CopyOptions = {
  dx?: number;
  dy?: number;
  // "suffix" (default) gives every copy a new id; "keep" reuses the source ids
  // (only legal on another board, where they are free).
  idMap?: "suffix" | "keep";
  suffix?: string;
  frameId?: string | null;
};

const stripCustom = (element: ExcalidrawElement): Record<string, unknown> | undefined => {
  const custom = { ...customDataOf(element) } as Record<string, unknown>;
  // A copy is not the same table/legend/diagram instance.
  delete custom.tableSpec;
  delete custom.table;
  delete custom.legendId;
  delete custom.diagramId;
  delete custom.stack;
  return Object.keys(custom).length ? custom : undefined;
};

// Plan a copy of `selected` (and their labels) as create items: ids are
// remapped, arrows between copied shapes re-bind to the copies, and an arrow
// pointing outside the copied set loses that binding rather than silently
// attaching to someone else's element.
export const planCopy = (
  scene: readonly ExcalidrawElement[],
  selected: readonly ExcalidrawElement[],
  options: CopyOptions = {},
): { items: CreateItem[]; idMap: Record<string, string> } => {
  const dx = options.dx ?? 0;
  const dy = options.dy ?? 0;
  const byId = new Map(scene.map((element) => [element.id, element] as const));
  const labelOf = new Map<string, ExcalidrawElement>();
  for (const element of scene) {
    const containerId = asText(element).containerId;
    if (element.type === "text" && typeof containerId === "string") {
      labelOf.set(containerId, element);
    }
  }
  const sources = new Map<string, ExcalidrawElement>();
  const add = (element: ExcalidrawElement) => {
    if (sources.has(element.id)) return;
    sources.set(element.id, element);
    // A frame brings its children; a container brings its label.
    if (element.type === "frame" || element.type === "magicframe") {
      for (const child of scene) {
        if (child.frameId === element.id) add(child);
      }
    }
  };
  for (const element of selected) {
    add(element);
  }
  if (!sources.size) {
    throw invalidArgs("nothing to copy: the target matched no elements");
  }

  const keep = options.idMap === "keep";
  const suffix = options.suffix ?? "-copy";
  // Groups are remapped per copy, so copying the same block twice does not
  // silently weld the two copies into one group.
  const groupToken = randomUUID().slice(0, 8);
  const copyGroup = (groupId: string): string => `${groupId}-${groupToken}`;
  const idMap: Record<string, string> = {};
  const nextId = (id: string): string => {
    if (keep) return id;
    let candidate = `${id}${suffix}`;
    for (let n = 2; byId.has(candidate) || Object.values(idMap).includes(candidate); n++) {
      candidate = `${id}${suffix}${n}`;
    }
    return candidate;
  };
  for (const id of sources.keys()) {
    idMap[id] = nextId(id);
  }

  const items: CreateItem[] = [];
  const arrows: ExcalidrawElement[] = [];
  for (const element of sources.values()) {
    if (element.type === "text" && typeof asText(element).containerId === "string") {
      // Labels come along with their container's `label`.
      continue;
    }
    if (isLinear(element)) {
      arrows.push(element);
      continue;
    }
    const label = labelOf.get(element.id);
    const view = label ? asText(label) : undefined;
    const custom = stripCustom(element);
    items.push({
      ...(element as unknown as CreateItem),
      id: idMap[element.id],
      x: element.x + dx,
      y: element.y + dy,
      ...(custom ? { customData: custom } : { customData: undefined }),
      ...(options.frameId !== undefined
        ? { frameId: options.frameId }
        : element.frameId && idMap[element.frameId]
          ? { frameId: idMap[element.frameId] }
          : { frameId: null }),
      ...(label
        ? {
            label: String(view?.originalText ?? view?.text ?? ""),
            labelFontSize: view?.fontSize,
            labelFontFamily: view?.fontFamily,
            labelColor: label.strokeColor,
            textAlign: view?.textAlign,
            verticalAlign: view?.verticalAlign,
          }
        : {}),
      boundElements: undefined,
      groupIds: (element.groupIds ?? []).map(copyGroup),
    } as CreateItem);
  }
  for (const arrow of arrows) {
    const linear = asLinear(arrow);
    const from = linear.startBinding ? idMap[linear.startBinding.elementId] : undefined;
    const to = linear.endBinding ? idMap[linear.endBinding.elementId] : undefined;
    const label = labelOf.get(arrow.id);
    const view = label ? asText(label) : undefined;
    const points = globalLinearPoints(arrow).map(([x, y]) => [x + dx, y + dy] as [number, number]);
    items.push({
      ...(arrow as unknown as CreateItem),
      id: idMap[arrow.id],
      customData: stripCustom(arrow),
      boundElements: undefined,
      startBinding: undefined,
      endBinding: undefined,
      groupIds: (arrow.groupIds ?? []).map(copyGroup),
      ...(options.frameId !== undefined
        ? { frameId: options.frameId }
        : arrow.frameId && idMap[arrow.frameId]
          ? { frameId: idMap[arrow.frameId] }
          : { frameId: null }),
      ...(from && to
        ? { fromId: from, toId: to }
        : {
            x: points[0][0],
            y: points[0][1],
            points: points.map(([x, y]) => [x - points[0][0], y - points[0][1]] as [number, number]),
          }),
      ...(label ? { label: String(view?.originalText ?? view?.text ?? ""), labelFontSize: view?.fontSize } : {}),
    } as CreateItem);
  }
  return { items, idMap };
};

export const copiedLabelId = (containerId: string): string => labelIdFor(containerId);
