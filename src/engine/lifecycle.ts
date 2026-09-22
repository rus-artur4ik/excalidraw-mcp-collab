import type {ExcalidrawElement} from "../types";
import {applyUpdate, detachDeleted, markDeleted} from "../elements";
import {isProtected} from "../customData";
import {asLinear, asText, isLinear, type Point} from "../verify/model";
import {distanceToElement, globalLinearPoints} from "../verify/geometry";
import {bindingGap, computeFixedPoint} from "../verify/bindings";
import {indexJustAbove} from "./common";
import {followBoundShapes} from "./arrows";
import {relayoutLabel} from "./follow";
import type {SceneTxn} from "./txn";

export type DeleteOptions = { force?: boolean; note?: string };

// Delete with the editor's cascade (a container takes its label along) and
// detach every survivor, so no back-reference points into the void.
// Elements marked `protected` are skipped unless the call forces it.
export const deleteTargets = (
  txn: SceneTxn,
  targets: readonly ExcalidrawElement[],
  options: DeleteOptions = {},
): { deleted: string[]; detached: string[]; skippedProtected: string[] } => {
  const skippedProtected: string[] = [];
  const ids = new Set<string>();
  for (const element of targets) {
    if (isProtected(element) && !options.force) {
      skippedProtected.push(element.id);
      continue;
    }
    ids.add(element.id);
  }
  for (const element of txn.liveElements()) {
    const containerId = asText(element).containerId;
    if (typeof containerId === "string" && ids.has(containerId)) {
      ids.add(element.id);
    }
  }
  const deleted: string[] = [];
  for (const id of ids) {
    const current = txn.live(id);
    if (!current) continue;
    txn.put(markDeleted(current));
    txn.report.deleted.add(id);
    deleted.push(id);
  }
  const detached = detachDeleted(txn.liveElements(), ids);
  for (const element of detached) {
    txn.put(element);
  }
  return {
    deleted,
    detached: detached.map((element) => element.id),
    skippedProtected,
  };
};

const nearOutline = (shape: ExcalidrawElement, point: Point): boolean =>
  distanceToElement(shape, point[0], point[1]) <= bindingGap(shape) + 2;

// Bring elements back from a source copy (a tombstone, or an entry of the
// shared history). The version always goes above anything seen so far, labels
// come back with their containers and land right above them, and bindings are
// re-established from what survives.
export const restoreFrom = (
  txn: SceneTxn,
  ids: readonly string[],
  source: (id: string) => ExcalidrawElement | undefined,
): { restored: string[]; missing: string[] } => {
  const restored: string[] = [];
  const missing: string[] = [];
  const queue = [...ids];
  const seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const copy = source(id);
    if (!copy) {
      missing.push(id);
      continue;
    }
    const current = txn.get(id);
    const frameLive = typeof copy.frameId === "string" ? txn.live(copy.frameId) : undefined;
    let next: ExcalidrawElement = {
      ...copy,
      isDeleted: false,
      frameId: frameLive ? frameLive.id : null,
      version: Math.max(current?.version ?? 0, copy.version) + 1,
      versionNonce: Math.floor(Math.random() * 2 ** 31),
      updated: Date.now(),
    };
    // Keep only references to elements that exist (they are re-added below).
    next.boundElements = (copy.boundElements ?? []).filter((ref) => {
      if (ids.includes(ref.id) || seen.has(ref.id) || queue.includes(ref.id)) return true;
      return !!txn.live(ref.id);
    });
    if (!next.boundElements.length) next.boundElements = null;
    txn.put(next);
    txn.report.forceWin.add(id);
    if (current?.isDeleted || !current) {
      txn.report.revived.set(id, current?.version ?? 0);
    }
    restored.push(id);
    // A container's label comes back with it.
    for (const ref of copy.boundElements ?? []) {
      if (ref.type === "text" && !seen.has(ref.id)) {
        queue.push(ref.id);
      }
    }
  }

  for (const id of restored) {
    const element = txn.live(id);
    if (!element) continue;
    const view = asText(element);
    if (element.type === "text" && typeof view.containerId === "string") {
      const container = txn.live(view.containerId);
      if (!container) {
        txn.put(applyUpdate(element, { containerId: null } as Partial<ExcalidrawElement>));
        continue;
      }
      if (!(container.boundElements ?? []).some((ref) => ref.id === id)) {
        txn.put(applyUpdate(container, { boundElements: [...(container.boundElements ?? []), { id, type: "text" }] }));
      }
      const containerNow = txn.live(container.id)!;
      if (!(typeof element.index === "string" && typeof containerNow.index === "string" && element.index > containerNow.index)) {
        txn.put(applyUpdate(txn.live(id)!, { index: indexJustAbove(txn, containerNow) }));
      }
      relayoutLabel(txn, container.id);
      continue;
    }
    if (isLinear(element)) {
      // Arrows: keep bindings whose targets exist and re-add back-references.
      const linear = asLinear(element);
      const patch: Partial<ExcalidrawElement> = {};
      for (const [side, binding] of [["start", linear.startBinding], ["end", linear.endBinding]] as const) {
        if (!binding) continue;
        const target = txn.live(binding.elementId);
        if (!target) {
          (patch as Record<string, unknown>)[`${side}Binding`] = null;
          continue;
        }
        if (!(target.boundElements ?? []).some((ref) => ref.id === id)) {
          txn.put(applyUpdate(target, { boundElements: [...(target.boundElements ?? []), { id, type: "arrow" }] }));
        }
      }
      if (Object.keys(patch).length) {
        txn.put(applyUpdate(txn.live(id)!, patch));
      }
      continue;
    }
    // Shapes: arrows that were attached when it was deleted lost their
    // binding; re-bind an arrow end that still touches the restored outline.
    for (const ref of element.boundElements ?? []) {
      if (ref.type !== "arrow") continue;
      const arrow = txn.live(ref.id);
      if (!arrow) continue;
      const linear = asLinear(arrow);
      const points = globalLinearPoints(arrow);
      const patch: Record<string, unknown> = {};
      if (linear.startBinding?.elementId !== id && !linear.startBinding && nearOutline(element, points[0])) {
        patch.startBinding = { elementId: id, fixedPoint: computeFixedPoint(element, points[0]), mode: "orbit" };
      }
      if (linear.endBinding?.elementId !== id && !linear.endBinding && nearOutline(element, points[points.length - 1])) {
        patch.endBinding = { elementId: id, fixedPoint: computeFixedPoint(element, points[points.length - 1]), mode: "orbit" };
      }
      const stillBound = linear.startBinding?.elementId === id || linear.endBinding?.elementId === id;
      if (Object.keys(patch).length) {
        txn.put(applyUpdate(arrow, patch as Partial<ExcalidrawElement>));
      } else if (!stillBound) {
        const kept = (txn.live(id)!.boundElements ?? []).filter((entry) => entry.id !== ref.id);
        txn.put(applyUpdate(txn.live(id)!, { boundElements: kept.length ? kept : null }));
      }
    }
  }
  return { restored, missing };
};

// Deterministic fixes the core owns (the rest come from verify/repair.ts):
// re-place arrow labels, recompute stale arrow ends, re-version elements the
// store does not have.
export const CORE_REPAIR_CODES = new Set(["arrow_label_far", "arrow_stale_geometry", "not_persisted"]);

export const repairCore = (
  txn: SceneTxn,
  codes: ReadonlySet<string>,
  ids: readonly string[],
): Array<{ code: string; id: string }> => {
  const applied: Array<{ code: string; id: string }> = [];
  for (const id of ids) {
    const element = txn.live(id);
    if (!element) continue;
    if (codes.has("arrow_label_far")) {
      const container = isLinear(element)
        ? element
        : typeof asText(element).containerId === "string"
          ? txn.live(asText(element).containerId as string)
          : undefined;
      if (container && isLinear(container) && relayoutLabel(txn, container.id)) {
        applied.push({ code: "arrow_label_far", id: container.id });
      }
    }
    if (codes.has("arrow_stale_geometry") && isLinear(element)) {
      const linear = asLinear(element);
      const shapes = new Set([linear.startBinding?.elementId, linear.endBinding?.elementId].filter((v): v is string => !!v));
      const geometry = followBoundShapes(element, shapes, (shapeId) => txn.live(shapeId));
      if (geometry) {
        txn.put(applyUpdate(element, geometry));
        relayoutLabel(txn, id);
        applied.push({ code: "arrow_stale_geometry", id });
      }
    }
    if (codes.has("not_persisted")) {
      // A no-op update bumps the version above whatever the store holds for
      // this id (the persist step lifts it further if needed).
      txn.put(applyUpdate(txn.live(id)!, {}));
      txn.report.forceWin.add(id);
      applied.push({ code: "not_persisted", id });
    }
  }
  return applied;
};
