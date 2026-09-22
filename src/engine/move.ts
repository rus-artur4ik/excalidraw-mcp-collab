import type {ExcalidrawElement} from "../types";
import {applyUpdate} from "../elements";
import {asLinear, asText, isLinear} from "../verify/model";
import {followBoundShapes} from "./arrows";
import {relayoutLabel} from "./follow";
import type {SceneTxn} from "./txn";

export type Carry = {
  frameChildren?: boolean;
  boundText?: boolean;
  boundArrows?: "translate" | "reroute" | "keep";
};

const DEFAULT_CARRY: Required<Carry> = {
  frameChildren: true,
  boundText: true,
  boundArrows: "translate",
};

// Move a block as a unit: frames bring their children (by frameId, not by
// bbox), containers their labels; an arrow with both ends inside the set
// travels whole with its bends, an arrow with one end outside re-aims that end.
export const moveElements = (
  txn: SceneTxn,
  targets: readonly ExcalidrawElement[],
  dx: number,
  dy: number,
  carryInput: Carry = {},
): { moved: string[]; rerouted: string[] } => {
  const carry = { ...DEFAULT_CARRY, ...carryInput };
  const set = new Set<string>();
  const queue = [...targets];
  while (queue.length) {
    const element = queue.pop()!;
    if (set.has(element.id) || element.isDeleted) {
      continue;
    }
    const containerId = asText(element).containerId;
    if (element.type === "text" && typeof containerId === "string" && !targets.some((t) => t.id === containerId)) {
      // A label is placed by its container; moving it alone would be undone
      // by the client on the next touch.
      const container = txn.live(containerId);
      if (container && !set.has(container.id)) {
        txn.report.ignore(element.id, "dx/dy", "a label moves with its container", `move ${containerId} instead`);
      }
      continue;
    }
    set.add(element.id);
    if (carry.frameChildren && (element.type === "frame" || element.type === "magicframe")) {
      for (const child of txn.liveElements()) {
        if (child.frameId === element.id && !set.has(child.id)) {
          queue.push(child);
        }
      }
    }
    if (carry.boundText) {
      for (const ref of element.boundElements ?? []) {
        if (ref.type === "text") {
          const label = txn.live(ref.id);
          if (label && asText(label).containerId === element.id) {
            set.add(label.id);
          }
        }
      }
    }
  }
  if (!set.size || (dx === 0 && dy === 0)) {
    return { moved: [], rerouted: [] };
  }

  const moved: string[] = [];
  const shapes = new Set<string>();
  const arrowsInSet: ExcalidrawElement[] = [];
  for (const id of set) {
    const element = txn.live(id);
    if (!element) continue;
    if (isLinear(element)) {
      arrowsInSet.push(element);
      continue;
    }
    txn.put(applyUpdate(element, { x: element.x + dx, y: element.y + dy }));
    moved.push(id);
    txn.report.moved.add(id);
    if (element.type !== "text") {
      shapes.add(id);
    }
  }

  const rerouted: string[] = [];
  const translate = (arrow: ExcalidrawElement) => {
    txn.put(applyUpdate(arrow, { x: arrow.x + dx, y: arrow.y + dy }));
    moved.push(arrow.id);
    txn.report.moved.add(arrow.id);
  };
  const endsInside = (arrow: ExcalidrawElement): { start: boolean; end: boolean } => {
    const linear = asLinear(arrow);
    return {
      start: !linear.startBinding || shapes.has(linear.startBinding.elementId),
      end: !linear.endBinding || shapes.has(linear.endBinding.elementId),
    };
  };

  // Arrows inside the moved set.
  const handled = new Set<string>();
  for (const arrow of arrowsInSet) {
    handled.add(arrow.id);
    const inside = endsInside(arrow);
    translate(arrow);
    if (!inside.start || !inside.end) {
      const current = txn.live(arrow.id)!;
      const outside = new Set<string>();
      const linear = asLinear(current);
      if (!inside.start && linear.startBinding) outside.add(linear.startBinding.elementId);
      if (!inside.end && linear.endBinding) outside.add(linear.endBinding.elementId);
      const geometry = followBoundShapes(current, outside, (id) => txn.live(id));
      if (geometry) {
        txn.put(applyUpdate(current, geometry));
        rerouted.push(arrow.id);
        txn.report.rerouted.add(arrow.id);
      }
    }
    relayoutLabel(txn, arrow.id);
  }

  // Arrows outside the set but bound to moved shapes.
  if (carry.boundArrows !== "keep") {
    const touched = new Set<string>();
    for (const shapeId of shapes) {
      const shape = txn.live(shapeId);
      for (const ref of shape?.boundElements ?? []) {
        if (ref.type === "arrow" && !handled.has(ref.id)) {
          touched.add(ref.id);
        }
      }
    }
    for (const arrowId of touched) {
      const arrow = txn.live(arrowId);
      if (!arrow || !isLinear(arrow)) continue;
      const inside = endsInside(arrow);
      const linear = asLinear(arrow);
      const bothBound = !!linear.startBinding && !!linear.endBinding;
      if (carry.boundArrows === "translate" && bothBound && inside.start && inside.end) {
        translate(arrow);
      } else {
        const geometry = followBoundShapes(arrow, shapes, (id) => txn.live(id));
        if (!geometry) continue;
        txn.put(applyUpdate(arrow, geometry));
        rerouted.push(arrowId);
        txn.report.rerouted.add(arrowId);
      }
      relayoutLabel(txn, arrowId);
    }
  }
  return { moved, rerouted };
};
