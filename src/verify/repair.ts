import {generateKeyBetween} from "fractional-indexing";

import type {ExcalidrawElement} from "../types";
import {asLinear, asText, type BindMode, type FixedPointBinding, isFrameLike, isLinear, type Point,} from "./model";
import {globalLinearPoints} from "./geometry";
import {computeFixedPoint} from "./bindings";
import {canonicalLintCode} from "./lintProfiles";

// Deterministic data repairs behind repair_scene (N05). Every patch is a raw
// element patch; patches are planned cumulatively, so apply them in order.

export type RepairPatch = {
  code: string;
  id: string;
  patch: Record<string, unknown>;
};

// Fixed order: bindings are nulled before back-references are rebuilt, and
// labels are re-homed before their frame/z-order is aligned.
export const REPAIRABLE_CODES = [
  "binding_target_missing",
  "binding_invalid",
  "binding_backref_stale",
  "binding_backref_missing",
  "orphan_bound_text",
  "frame_missing",
  "frame_membership_mismatch",
  "bound_text_below_container",
] as const;

// Need geometry or the store: the core handles these, planRepairs returns
// nothing for them.
export const CORE_REPAIR_CODES = ["arrow_label_far", "not_persisted", "arrow_stale_geometry"] as const;

const LABEL_CONTAINER_TYPES = new Set(["rectangle", "ellipse", "diamond", "arrow"]);
const BIND_MODES = new Set<BindMode>(["inside", "orbit", "skip"]);

type Entry = { id: string; type: string };

const SIDES = [
  ["start", "startBinding"],
  ["end", "endBinding"],
] as const;

export const planRepairs = (
  elements: readonly ExcalidrawElement[],
  options: { codes: readonly string[]; ids?: readonly string[] },
): RepairPatch[] => {
  const requested = new Set(options.codes.map(canonicalLintCode));
  const filter = options.ids?.length ? new Set(options.ids) : null;
  const involves = (ids: readonly (string | null | undefined)[]) =>
    !filter || ids.some((id) => typeof id === "string" && filter.has(id));

  const order = elements.map((element) => element.id);
  const work = new Map(elements.map((element) => [element.id, element]));
  const repairs: RepairPatch[] = [];
  const live = (id: string | null | undefined): ExcalidrawElement | undefined => {
    const element = typeof id === "string" ? work.get(id) : undefined;
    return element && !element.isDeleted ? element : undefined;
  };
  const liveElements = () => order.map((id) => work.get(id)!).filter((element) => !element.isDeleted);
  const apply = (code: string, id: string, patch: Record<string, unknown>) => {
    work.set(id, { ...work.get(id)!, ...patch } as ExcalidrawElement);
    repairs.push({ code, id, patch });
  };
  const entriesOf = (element: ExcalidrawElement): Entry[] =>
    Array.isArray(element.boundElements) ? element.boundElements : [];
  const pointsBack = (holder: ExcalidrawElement, entryId: string): boolean => {
    const target = live(entryId);
    if (!target) {
      return false;
    }
    if (isLinear(target)) {
      const linear = asLinear(target);
      return linear.startBinding?.elementId === holder.id || linear.endBinding?.elementId === holder.id;
    }
    return target.type === "text" && asText(target).containerId === holder.id;
  };

  const steps: Record<(typeof REPAIRABLE_CODES)[number], () => void> = {
    binding_target_missing: () => {
      for (const arrow of liveElements()) {
        if (!isLinear(arrow)) {
          continue;
        }
        const patch: Record<string, unknown> = {};
        const involved: string[] = [arrow.id];
        for (const [, key] of SIDES) {
          const binding = asLinear(arrow)[key];
          if (binding && !live(binding.elementId)) {
            patch[key] = null;
            involved.push(binding.elementId);
          }
        }
        if (Object.keys(patch).length && involves(involved)) {
          apply("binding_target_missing", arrow.id, patch);
        }
      }
    },

    binding_invalid: () => {
      for (const arrow of liveElements()) {
        if (!isLinear(arrow)) {
          continue;
        }
        const path = globalLinearPoints(arrow);
        const patch: Record<string, unknown> = {};
        for (const [side, key] of SIDES) {
          const binding = asLinear(arrow)[key] as Partial<FixedPointBinding> | null | undefined;
          if (!binding || (binding.mode && binding.fixedPoint) || !involves([arrow.id, binding.elementId])) {
            continue;
          }
          const target = live(binding.elementId);
          if (!target) {
            patch[key] = null;
            continue;
          }
          const endpoint: Point = side === "start" ? path[0] : path[path.length - 1];
          const fixedPoint =
            Array.isArray(binding.fixedPoint) && binding.fixedPoint.length === 2
              ? binding.fixedPoint
              : computeFixedPoint(target, endpoint);
          patch[key] = {
            elementId: target.id,
            fixedPoint,
            mode: binding.mode && BIND_MODES.has(binding.mode) ? binding.mode : "orbit",
          };
        }
        if (Object.keys(patch).length) {
          apply("binding_invalid", arrow.id, patch);
        }
      }
    },

    binding_backref_stale: () => {
      for (const holder of liveElements()) {
        const entries = entriesOf(holder);
        if (!entries.length) {
          continue;
        }
        const seen = new Set<string>();
        const kept: Entry[] = [];
        const dropped: string[] = [];
        for (const entry of entries) {
          if (!entry || typeof entry.id !== "string" || seen.has(entry.id)) {
            continue;
          }
          seen.add(entry.id);
          if (pointsBack(holder, entry.id)) {
            kept.push(entry);
          } else {
            dropped.push(entry.id);
          }
        }
        if (dropped.length && involves([holder.id, ...dropped])) {
          apply("binding_backref_stale", holder.id, { boundElements: kept });
        }
      }
    },

    binding_backref_missing: () => {
      const additions = new Map<string, string[]>();
      for (const arrow of liveElements()) {
        if (!isLinear(arrow)) {
          continue;
        }
        const linear = asLinear(arrow);
        for (const binding of [linear.startBinding, linear.endBinding]) {
          const target = binding?.mode && binding.fixedPoint ? live(binding.elementId) : undefined;
          if (
            !target ||
            entriesOf(target).some((entry) => entry.id === arrow.id) ||
            !involves([arrow.id, target.id])
          ) {
            continue;
          }
          const list = additions.get(target.id) ?? [];
          if (!list.includes(arrow.id)) {
            list.push(arrow.id);
          }
          additions.set(target.id, list);
        }
      }
      for (const [targetId, arrowIds] of additions) {
        const target = work.get(targetId)!;
        apply("binding_backref_missing", targetId, {
          boundElements: [...entriesOf(target), ...arrowIds.map((id) => ({ id, type: "arrow" }))],
        });
      }
    },

    orphan_bound_text: () => {
      for (const text of liveElements()) {
        const containerId = asText(text).containerId;
        if (text.type !== "text" || typeof containerId !== "string" || !involves([text.id, containerId])) {
          continue;
        }
        const container = live(containerId);
        if (!container || !LABEL_CONTAINER_TYPES.has(container.type)) {
          apply("orphan_bound_text", text.id, { containerId: null });
          continue;
        }
        if (entriesOf(container).some((entry) => entry.id === text.id)) {
          continue;
        }
        // A container holds one label; a second claimant becomes free text.
        const occupied = entriesOf(container).some(
          (entry) => entry.type === "text" && entry.id !== text.id && pointsBack(container, entry.id),
        );
        if (occupied) {
          apply("orphan_bound_text", text.id, { containerId: null });
        } else {
          apply("orphan_bound_text", container.id, {
            boundElements: [...entriesOf(container), { id: text.id, type: "text" }],
          });
        }
      }
    },

    frame_missing: () => {
      for (const element of liveElements()) {
        const frameId = element.frameId;
        if (typeof frameId !== "string" || !involves([element.id, frameId])) {
          continue;
        }
        const frame = live(frameId);
        if (!frame || !isFrameLike(frame)) {
          apply("frame_missing", element.id, { frameId: null });
        }
      }
    },

    frame_membership_mismatch: () => {
      for (const text of liveElements()) {
        const containerId = asText(text).containerId;
        if (text.type !== "text" || typeof containerId !== "string") {
          continue;
        }
        const container = live(containerId);
        if (
          !container ||
          !LABEL_CONTAINER_TYPES.has(container.type) ||
          (text.frameId ?? null) === (container.frameId ?? null) ||
          !involves([text.id, container.id])
        ) {
          continue;
        }
        apply("frame_membership_mismatch", text.id, { frameId: container.frameId ?? null });
      }
    },

    bound_text_below_container: () => {
      for (const text of liveElements()) {
        const containerId = asText(text).containerId;
        if (text.type !== "text" || typeof containerId !== "string") {
          continue;
        }
        const container = live(containerId);
        if (
          !container ||
          typeof container.index !== "string" ||
          typeof text.index !== "string" ||
          text.index > container.index ||
          !involves([text.id, container.id])
        ) {
          continue;
        }
        // Tombstones keep their keys, so the next key above counts them too.
        let next: string | null = null;
        for (const id of order) {
          const other = work.get(id)!;
          if (
            other.id !== text.id &&
            typeof other.index === "string" &&
            other.index > container.index &&
            (next === null || other.index < next)
          ) {
            next = other.index;
          }
        }
        try {
          apply("bound_text_below_container", text.id, {
            index: generateKeyBetween(container.index, next),
          });
        } catch {
          // Malformed fractional keys: leave it for a human rather than guess.
        }
      }
    },
  };

  for (const code of REPAIRABLE_CODES) {
    if (requested.has(code)) {
      steps[code]();
    }
  }
  return repairs;
};
