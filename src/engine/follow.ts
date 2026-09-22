import type {ExcalidrawElement} from "../types";
import {applyUpdate} from "../elements";
import {asLinear, asText, isLinear} from "../verify/model";
import {labelIdFor} from "../customData";
import {followBoundShapes} from "./arrows";
import {type LabelStyle, labelStyleOf, layoutLabel} from "./boundText";
import type {SceneTxn} from "./txn";

export const boundTextOf = (
  txn: SceneTxn,
  container: ExcalidrawElement,
): ExcalidrawElement | undefined => {
  for (const ref of container.boundElements ?? []) {
    if (ref.type === "text") {
      const text = txn.live(ref.id);
      if (text && asText(text).containerId === container.id) {
        return text;
      }
    }
  }
  const byConvention = txn.live(labelIdFor(container.id));
  if (byConvention && asText(byConvention).containerId === container.id) {
    return byConvention;
  }
  for (const element of txn.liveElements()) {
    if (element.type === "text" && asText(element).containerId === container.id) {
      return element;
    }
  }
  return undefined;
};

// The text a label should show: originalText is the source of truth, but a
// label whose originalText went missing must never be laid out as empty.
export const labelSource = (text: ExcalidrawElement): string => {
  const view = asText(text);
  const original = typeof view.originalText === "string" ? view.originalText : "";
  if (original.trim()) {
    return original;
  }
  return typeof view.text === "string" ? view.text : original;
};

export type RelayoutOptions = {
  text?: string;
  style?: Partial<LabelStyle>;
  // An explicit height in the same patch wins over growing the box to fit.
  keepContainerHeight?: boolean;
  keepContainerWidth?: boolean;
  extraTextPatch?: Partial<ExcalidrawElement>;
};

// Re-wrap and re-place a container's label for the container's current
// geometry, keeping its alignment and font. Grows the container the way the
// client would when the text no longer fits.
export const relayoutLabel = (
  txn: SceneTxn,
  containerId: string,
  options: RelayoutOptions = {},
): ExcalidrawElement | undefined => {
  let container = txn.live(containerId);
  if (!container) {
    return undefined;
  }
  const text = boundTextOf(txn, container);
  if (!text) {
    return undefined;
  }
  const style = { ...labelStyleOf(text), ...stripUndefined(options.style ?? {}) };
  const source = options.text ?? labelSource(text);
  const layout = layoutLabel(container, source, style);
  if (!isLinear(container)) {
    const growHeight =
      !options.keepContainerHeight && layout.containerHeight > (container.height || 0) + 0.5;
    const growWidth =
      !options.keepContainerWidth && layout.containerWidth > (container.width || 0) + 0.5;
    if (growHeight || growWidth) {
      container = applyUpdate(container, {
        ...(growHeight ? { height: layout.containerHeight } : {}),
        ...(growWidth ? { width: layout.containerWidth } : {}),
      });
      txn.put(container);
      txn.report.collateral.push({
        id: container.id,
        reason: `grown to ${Math.round(container.width)}×${Math.round(container.height)} so its label fits`,
      });
      // The box changed size, so its label (and arrows) move once more.
      followShapes(txn, [container.id], { skipLabels: true });
      const regrown = layoutLabel(container, source, style);
      return putLabel(txn, text, regrown, style, source, options.extraTextPatch);
    }
  }
  return putLabel(txn, text, layout, style, source, options.extraTextPatch);
};

const putLabel = (
  txn: SceneTxn,
  text: ExcalidrawElement,
  layout: ReturnType<typeof layoutLabel>,
  style: LabelStyle,
  source: string,
  extra?: Partial<ExcalidrawElement>,
): ExcalidrawElement => {
  const next = applyUpdate(text, {
    ...(extra ?? {}),
    text: layout.text,
    originalText: source,
    x: layout.x,
    y: layout.y,
    width: layout.width,
    height: layout.height,
    lineHeight: layout.lineHeight,
    fontSize: style.fontSize,
    fontFamily: style.fontFamily,
    textAlign: style.textAlign,
    verticalAlign: style.verticalAlign,
    autoResize: true,
  });
  txn.put(next);
  txn.report.relaidOut.add(next.id);
  return next;
};

const stripUndefined = <T extends object>(value: T): Partial<T> => {
  const result: Partial<T> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) {
      (result as Record<string, unknown>)[key] = entry;
    }
  }
  return result;
};

// After shapes changed geometry: labels re-lay out inside them and every
// arrow bound to them recomputes its bound ends from the stored fixed points.
export const followShapes = (
  txn: SceneTxn,
  shapeIds: Iterable<string>,
  options: { skipLabels?: boolean; skipArrows?: ReadonlySet<string> } = {},
): void => {
  const moved = new Set(shapeIds);
  if (!moved.size) {
    return;
  }
  const arrows = new Set<string>();
  for (const id of moved) {
    const shape = txn.live(id);
    if (!shape) {
      continue;
    }
    if (!options.skipLabels && !isLinear(shape)) {
      relayoutLabel(txn, id);
    }
    for (const ref of shape.boundElements ?? []) {
      if (ref.type === "arrow" && !options.skipArrows?.has(ref.id)) {
        arrows.add(ref.id);
      }
    }
  }
  for (const arrowId of arrows) {
    const arrow = txn.live(arrowId);
    if (!arrow || !isLinear(arrow)) {
      continue;
    }
    const geometry = followBoundShapes(arrow, moved, (id) => txn.live(id));
    if (!geometry) {
      continue;
    }
    const next = applyUpdate(arrow, geometry);
    txn.put(next);
    txn.report.rerouted.add(arrowId);
    relayoutLabel(txn, arrowId);
  }
};

// Every arrow whose binding points at `shapeId`, whether or not the shape's
// back-reference list is intact.
export const arrowsBoundTo = (txn: SceneTxn, shapeId: string): ExcalidrawElement[] =>
  txn.liveElements().filter((element) => {
    if (!isLinear(element)) {
      return false;
    }
    const linear = asLinear(element);
    return (
      linear.startBinding?.elementId === shapeId || linear.endBinding?.elementId === shapeId
    );
  });
