import type {ExcalidrawElement} from "../../types";
import type {ComposePlan} from "../types";

export const element = (
  overrides: Partial<ExcalidrawElement> & { id: string; type: string },
): ExcalidrawElement =>
  ({
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    roundness: null,
    seed: 1,
    version: 1,
    versionNonce: 1,
    index: null,
    isDeleted: false,
    groupIds: [],
    frameId: null,
    boundElements: null,
    updated: 0,
    link: null,
    locked: false,
    ...overrides,
  }) as ExcalidrawElement;

// Stand-in for the core's upsert: update by id or create, labels as
// `${id}:label`, removeIds deleted, extraPatches merged. Good enough to feed a
// plan's result back into the next planner call.
export const applyPlan = (
  plan: ComposePlan,
  live: readonly ExcalidrawElement[],
): ExcalidrawElement[] => {
  const byId = new Map(live.map((el) => [el.id, { ...el }]));
  for (const id of plan.removeIds) {
    const existing = byId.get(id);
    if (existing) {
      byId.set(id, { ...existing, isDeleted: true });
    }
  }
  for (const item of plan.items) {
    const {
      label,
      labelFontSize,
      labelFontFamily,
      labelColor,
      fromId: _fromId,
      toId: _toId,
      startAnchor: _startAnchor,
      endAnchor: _endAnchor,
      route: _route,
      ...attrs
    } = item;
    const previous = byId.get(item.id);
    const next = element({
      ...(previous && !previous.isDeleted ? previous : {}),
      ...(attrs as Partial<ExcalidrawElement>),
      id: item.id,
      type: item.type,
      isDeleted: false,
    });
    const labelId = `${item.id}:label`;
    if (typeof label === "string" && label.length) {
      byId.set(
        labelId,
        element({
          id: labelId,
          type: "text",
          text: label,
          originalText: label,
          containerId: item.id,
          fontSize: labelFontSize,
          fontFamily: labelFontFamily,
          strokeColor: labelColor as string,
          textAlign: item.textAlign,
          verticalAlign: item.verticalAlign,
          groupIds: next.groupIds,
          frameId: next.frameId,
        }),
      );
      next.boundElements = [{ id: labelId, type: "text" }];
    } else {
      next.boundElements = null;
    }
    byId.set(item.id, next);
  }
  for (const { id, patch } of plan.extraPatches ?? []) {
    const existing = byId.get(id);
    if (existing) {
      byId.set(id, { ...existing, ...patch });
    }
  }
  return [...byId.values()];
};

export const liveOnly = (elements: readonly ExcalidrawElement[]): ExcalidrawElement[] =>
  elements.filter((el) => !el.isDeleted);
