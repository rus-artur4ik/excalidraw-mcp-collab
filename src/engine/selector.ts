import type {ExcalidrawElement} from "../types";
import type {Target} from "../toolSchemas";
import {kindOf, LABEL_ID_SUFFIX, roleOf, slotOf} from "../customData";
import {asText, type Bounds, type FrameView, isLinear} from "../verify/model";
import {getElementBounds, pointInElement} from "../verify/geometry";
import {invalidArgs, notFound} from "./errors";

type Index = {
  live: readonly ExcalidrawElement[];
  byId: Map<string, ExcalidrawElement>;
  labelOf: Map<string, ExcalidrawElement>;
};

const buildIndex = (live: readonly ExcalidrawElement[]): Index => {
  const byId = new Map(live.map((element) => [element.id, element] as const));
  const labelOf = new Map<string, ExcalidrawElement>();
  for (const element of live) {
    const containerId = asText(element).containerId;
    if (element.type === "text" && typeof containerId === "string" && byId.has(containerId)) {
      labelOf.set(containerId, element);
    }
  }
  return { live, byId, labelOf };
};

export const textOfElement = (
  element: ExcalidrawElement,
  labelOf: ReadonlyMap<string, ExcalidrawElement>,
): string => {
  const own = asText(element);
  if (element.type === "text") {
    return String(own.originalText ?? own.text ?? "");
  }
  const label = labelOf.get(element.id);
  if (label) {
    const view = asText(label);
    return String(view.originalText ?? view.text ?? "");
  }
  if (element.type === "frame" || element.type === "magicframe") {
    return String((element as FrameView).name ?? "");
  }
  return "";
};

const intersects = (a: Bounds, b: Bounds): boolean =>
  a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

const contains = (outer: Bounds, inner: Bounds): boolean =>
  inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3];

const isFrame = (element: ExcalidrawElement): boolean =>
  element.type === "frame" || element.type === "magicframe";

export const regionBounds = (region: NonNullable<Target["region"]>): Bounds => [
  region.x,
  region.y,
  region.x + region.width,
  region.y + region.height,
];

export const hasConditions = (target: Target | undefined): boolean =>
  !!target && Object.values(target).some((value) => value !== undefined);

// Resolve the shared `target` selector (N04) to live elements; every given
// condition must hold. Returned in z-order (bottom → top).
export const resolveTarget = (
  live: readonly ExcalidrawElement[],
  target: Target,
): ExcalidrawElement[] => {
  const index = buildIndex(live);
  let candidates: ExcalidrawElement[] = [...live];

  if (target.ids) {
    const wanted = new Set<string>();
    for (const id of target.ids) {
      if (index.byId.has(id)) {
        wanted.add(id);
      } else if (id.endsWith(LABEL_ID_SUFFIX)) {
        const label = index.labelOf.get(id.slice(0, -LABEL_ID_SUFFIX.length));
        if (label) wanted.add(label.id);
      }
    }
    candidates = candidates.filter((element) => wanted.has(element.id));
  }
  const frameIds = new Set<string>(target.frameIds ?? []);
  if (target.frameName) {
    const name = target.frameName.trim().toLowerCase();
    const frames = live.filter(
      (element) => isFrame(element) && String((element as FrameView).name ?? "").trim().toLowerCase() === name,
    );
    if (!frames.length) {
      const names = live.filter(isFrame).map((element) => (element as FrameView).name).filter(Boolean);
      throw notFound(
        `no frame named "${target.frameName}"${names.length ? `; frames on this board: ${names.slice(0, 20).join(" | ")}` : ""}`,
      );
    }
    for (const frame of frames) frameIds.add(frame.id);
  }
  if (target.frameIds || target.frameName) {
    candidates = candidates.filter(
      (element) =>
        frameIds.has(element.id) || (typeof element.frameId === "string" && frameIds.has(element.frameId)),
    );
  }
  if (target.groupId) {
    const groupId = target.groupId;
    candidates = candidates.filter((element) => (element.groupIds ?? []).includes(groupId));
  }
  if (target.type) {
    candidates = candidates.filter((element) => element.type === target.type);
  }
  if (target.role) {
    candidates = candidates.filter((element) => roleOf(element) === target.role);
  }
  if (target.kind) {
    candidates = candidates.filter((element) => kindOf(element) === target.kind);
  }
  if (target.slot) {
    candidates = candidates.filter((element) => slotOf(element) === target.slot);
  }
  if (target.hasLink !== undefined) {
    candidates = candidates.filter((element) => !!element.link === target.hasLink);
  }
  if (target.textContains) {
    const needle = target.textContains.toLowerCase();
    candidates = candidates.filter((element) =>
      textOfElement(element, index.labelOf).toLowerCase().includes(needle),
    );
  }
  if (target.textRegex) {
    let regex: RegExp;
    try {
      regex = new RegExp(target.textRegex, "i");
    } catch (error) {
      throw invalidArgs(`textRegex is not a valid regular expression: ${(error as Error).message}`, {
        field: "textRegex",
      });
    }
    candidates = candidates.filter((element) => regex.test(textOfElement(element, index.labelOf)));
  }
  if (target.at) {
    const { x, y } = target.at;
    candidates = candidates.filter((element) => pointInElement(element, x, y));
  }
  if (target.region) {
    const rect = regionBounds(target.region);
    const mode = target.region.mode ?? "intersect";
    candidates = candidates.filter((element) => {
      const bounds = getElementBounds(element);
      return mode === "contain" ? contains(rect, bounds) : intersects(rect, bounds);
    });
  }
  if (target.after) {
    const anchor = index.byId.get(target.after.anchorId);
    if (!anchor) {
      throw notFound(`anchor not found: ${target.after.anchorId}`, [target.after.anchorId]);
    }
    const [, , anchorRight, anchorBottom] = getElementBounds(anchor);
    const axis = target.after.axis;
    const scope = target.after.scope ?? "frame";
    const anchorFrame = isFrame(anchor) ? null : anchor.frameId ?? null;
    candidates = candidates.filter((element) => {
      if (element.id === anchor.id) return false;
      // Labels ride with their containers; arrows are re-aimed, not selected.
      if (element.type === "text" && typeof asText(element).containerId === "string") return false;
      if (isLinear(element)) return false;
      if (scope === "frame") {
        if ((element.frameId ?? null) !== anchorFrame) return false;
        if (isFrame(element) && anchorFrame !== null) return false;
      } else if (element.frameId && index.byId.has(element.frameId)) {
        // Board scope moves whole frames; their children come along via carry.
        return false;
      }
      const [x1, y1] = getElementBounds(element);
      return axis === "y" ? y1 >= anchorBottom - 0.5 : x1 >= anchorRight - 0.5;
    });
  }
  return candidates;
};
