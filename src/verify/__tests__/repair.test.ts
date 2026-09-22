import {describe, expect, it} from "vitest";

import type {ExcalidrawElement} from "../../types";
import {lintScene} from "../lint";
import {CORE_REPAIR_CODES, planRepairs, type RepairPatch, REPAIRABLE_CODES} from "../repair";
import {el} from "./factory";

const applyRepairs = (elements: readonly ExcalidrawElement[], repairs: readonly RepairPatch[]) => {
  const byId = new Map(elements.map((element) => [element.id, element]));
  for (const { id, patch } of repairs) {
    byId.set(id, { ...byId.get(id)!, ...patch } as ExcalidrawElement);
  }
  return elements.map((element) => byId.get(element.id)!);
};

const box = (id: string, extra: Partial<ExcalidrawElement> = {}) =>
  el({ type: "rectangle", id, x: 0, y: 0, width: 120, height: 60, ...extra });

const label = (id: string, containerId: string, extra: Partial<ExcalidrawElement> = {}) =>
  el({ type: "text", id, containerId, text: "hi", originalText: "hi", fontSize: 20, fontFamily: 5, ...extra });

const arrow = (id: string, extra: Partial<ExcalidrawElement> = {}) =>
  el({
    type: "arrow",
    id,
    x: 125,
    y: 30,
    width: 170,
    height: 0,
    points: [[0, 0], [170, 0]],
    startBinding: null,
    endBinding: null,
    ...extra,
  });

const bind = (elementId: string) => ({ elementId, fixedPoint: [1, 0.5001] as [number, number], mode: "orbit" as const });

const FIXTURES: Record<(typeof REPAIRABLE_CODES)[number], () => ExcalidrawElement[]> = {
  binding_target_missing: () => [arrow("a", { startBinding: bind("gone"), endBinding: bind("gone2") })],
  binding_invalid: () => [
    box("r", { boundElements: [{ id: "a", type: "arrow" }] }),
    arrow("a", { startBinding: { elementId: "r" } as never, endBinding: { elementId: "nowhere" } as never }),
  ],
  binding_backref_stale: () => [
    box("r", { boundElements: [{ id: "ghost", type: "arrow" }, { id: "a", type: "arrow" }, { id: "x", type: "arrow" }] }),
    arrow("a", { startBinding: bind("r") }),
    arrow("x", { y: 200 }),
  ],
  binding_backref_missing: () => [
    box("r"),
    arrow("a", { startBinding: bind("r") }),
    arrow("b", { y: 50, startBinding: bind("r") }),
  ],
  orphan_bound_text: () => [label("gone_label", "gone"), box("c"), label("t", "c")],
  frame_missing: () => [box("r", { frameId: "nope" }), box("s", { frameId: "r" })],
  frame_membership_mismatch: () => [
    el({ type: "frame", id: "F", x: -10, y: -10, width: 400, height: 200 }),
    box("c", { frameId: "F", boundElements: [{ id: "t", type: "text" }] }),
    label("t", "c", { frameId: null }),
  ],
  bound_text_below_container: () => [
    label("t", "c", { index: "a0" }),
    box("c", { index: "a1", boundElements: [{ id: "t", type: "text" }] }),
    box("other", { x: 300, index: "a2" }),
  ],
};

describe("planRepairs", () => {
  it.each(REPAIRABLE_CODES)("%s: the planned patches clear the code", (code) => {
    const elements = FIXTURES[code]();
    expect(lintScene(elements, { codes: [code] }).findings.length).toBeGreaterThan(0);
    const repairs = planRepairs(elements, { codes: [code] });
    expect(repairs.length).toBeGreaterThan(0);
    expect(repairs.every((repair) => repair.code === code)).toBe(true);
    expect(lintScene(applyRepairs(elements, repairs), { codes: [code] }).findings).toEqual([]);
  });

  it("is deterministic", () => {
    for (const code of REPAIRABLE_CODES) {
      expect(planRepairs(FIXTURES[code](), { codes: [code] })).toEqual(planRepairs(FIXTURES[code](), { codes: [code] }));
    }
  });

  it("returns nothing for the codes the core repairs itself", () => {
    const elements = [arrow("a", { boundElements: [{ id: "t", type: "text" }] }), label("t", "a", { x: 500, y: 500 })];
    expect(planRepairs(elements, { codes: [...CORE_REPAIR_CODES] })).toEqual([]);
  });

  it("accepts the old arrow_dangling_binding name", () => {
    const repairs = planRepairs(FIXTURES.binding_target_missing(), { codes: ["arrow_dangling_binding"] });
    expect(repairs).toEqual([{ code: "binding_target_missing", id: "a", patch: { startBinding: null, endBinding: null } }]);
  });

  it("limits repairs to findings that involve the given ids", () => {
    const elements = [box("r1", { frameId: "nope" }), box("r2", { frameId: "nope" })];
    expect(planRepairs(elements, { codes: ["frame_missing"], ids: ["r2"] }).map((r) => r.id)).toEqual(["r2"]);
  });

  it("prunes stale entries and keeps live ones", () => {
    const [repair] = planRepairs(FIXTURES.binding_backref_stale(), { codes: ["binding_backref_stale"] });
    expect(repair.patch).toEqual({ boundElements: [{ id: "a", type: "arrow" }] });
  });

  it("adds one back-reference patch per target, for every arrow binding it", () => {
    const repairs = planRepairs(FIXTURES.binding_backref_missing(), { codes: ["binding_backref_missing"] });
    expect(repairs).toEqual([
      {
        code: "binding_backref_missing",
        id: "r",
        patch: { boundElements: [{ id: "a", type: "arrow" }, { id: "b", type: "arrow" }] },
      },
    ]);
  });

  it("composes several codes on one element when applied in order", () => {
    const elements = [
      box("r", { boundElements: [{ id: "ghost", type: "arrow" }] }),
      arrow("a", { startBinding: bind("r") }),
    ];
    const repairs = planRepairs(elements, { codes: ["binding_backref_missing", "binding_backref_stale"] });
    const fixed = applyRepairs(elements, repairs);
    expect(fixed.find((e) => e.id === "r")!.boundElements).toEqual([{ id: "a", type: "arrow" }]);
    expect(
      lintScene(fixed, { codes: ["binding_backref_missing", "binding_backref_stale"] }).findings,
    ).toEqual([]);
  });

  it("frees a second label instead of giving a container two", () => {
    const elements = [
      box("c", { boundElements: [{ id: "first", type: "text" }] }),
      label("first", "c"),
      label("second", "c"),
    ];
    const repairs = planRepairs(elements, { codes: ["orphan_bound_text"] });
    expect(repairs).toEqual([{ code: "orphan_bound_text", id: "second", patch: { containerId: null } }]);
  });

  it("gives a label under its container a key between the container and the next element", () => {
    const elements = [
      label("t", "c", { index: "a0" }),
      box("c", { index: "a1", boundElements: [{ id: "t", type: "text" }] }),
      box("deleted", { index: "a2", isDeleted: true }),
      box("above", { index: "a3" }),
    ];
    const [repair] = planRepairs(elements, { codes: ["bound_text_below_container"] });
    const index = repair.patch.index as string;
    expect(index > "a1").toBe(true);
    // Tombstones keep their keys, so the new key must not collide with them.
    expect(index < "a2").toBe(true);
  });

  it("skips malformed fractional keys instead of throwing", () => {
    const elements = [
      label("t", "c", { index: "!!" }),
      box("c", { index: "zz~", boundElements: [{ id: "t", type: "text" }] }),
    ];
    expect(() => planRepairs(elements, { codes: ["bound_text_below_container"] })).not.toThrow();
  });
});
