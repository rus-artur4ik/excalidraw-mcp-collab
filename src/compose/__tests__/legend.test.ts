import {describe, expect, it} from "vitest";

import {resolveRole} from "../../verify/styles";
import {measureText} from "../../verify/textMetrics";
import {itemBounds} from "../common";
import {planLegend, type LegendInput} from "../legend";
import type {PlanBounds} from "../types";
import {applyPlan} from "./applyPlan";

const input: LegendInput = {
  legendId: "lg",
  origin: { x: 40, y: 200 },
  items: [
    { role: "process", label: "Our SDK" },
    { role: "external", label: "Third-party service with a long name" },
    { role: "accent", tone: "subtle", label: "You" },
    { strokeStyle: "dashed", label: "Planned" },
    { arrow: true, role: "error", label: "Failure path" },
  ],
};

const inside = (outer: PlanBounds, inner: PlanBounds) =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height;

const disjoint = (a: PlanBounds, b: PlanBounds) =>
  a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;

describe("planLegend", () => {
  it("emits deterministic ids, one shared group and kind legend", () => {
    const plan = planLegend(input, []);
    expect(plan.items.map((item) => item.id)).toEqual([
      "lg",
      "lg:0:chip",
      "lg:0:text",
      "lg:1:chip",
      "lg:1:text",
      "lg:2:chip",
      "lg:2:text",
      "lg:3:chip",
      "lg:3:text",
      "lg:4:chip",
      "lg:4:text",
    ]);
    for (const item of plan.items) {
      expect(item.groupIds).toEqual(["lg:group"]);
      expect(item.customData).toEqual({ kind: "legend", legendId: "lg" });
    }
    expect(planLegend(input, []).items).toEqual(plan.items);
  });

  it("picks chips, line and arrow samples with role colors", () => {
    const plan = planLegend(input, []);
    const byId = new Map(plan.items.map((item) => [item.id, item]));
    expect(byId.get("lg:0:chip")).toMatchObject({
      type: "rectangle",
      backgroundColor: resolveRole("process")!.backgroundColor,
      strokeColor: resolveRole("process")!.strokeColor,
    });
    expect(byId.get("lg:2:chip")?.backgroundColor).toBe(resolveRole("accent", "subtle")!.backgroundColor);
    expect(byId.get("lg:3:chip")).toMatchObject({ type: "line", strokeStyle: "dashed", endArrowhead: null });
    expect(byId.get("lg:4:chip")).toMatchObject({
      type: "arrow",
      endArrowhead: "arrow",
      strokeColor: resolveRole("error")!.strokeColor,
    });
    expect(byId.get("lg:1:text")?.text).toBe("Third-party service with a long name");
  });

  it("sizes captions by the metric so nothing overflows or overlaps", () => {
    for (const layout of ["row", "grid"] as const) {
      const plan = planLegend({ ...input, layout }, []);
      const [root, ...rest] = plan.items;
      const panel = itemBounds(root);
      expect(plan.bounds).toEqual(panel);
      const slots = input.items.map((item, index) => {
        const text = rest.find((candidate) => candidate.id === `lg:${index}:text`)!;
        const chip = rest.find((candidate) => candidate.id === `lg:${index}:chip`)!;
        expect(text.width).toBeGreaterThanOrEqual(measureText(item.label, 16, 5).width);
        const chipBox = itemBounds(chip);
        const textBox = itemBounds(text);
        expect(inside(panel, chipBox)).toBe(true);
        expect(inside(panel, textBox)).toBe(true);
        expect(chipBox.x + chipBox.width).toBeLessThanOrEqual(textBox.x);
        return { chipBox, textBox };
      });
      for (let i = 0; i < slots.length; i++) {
        for (let j = i + 1; j < slots.length; j++) {
          expect(disjoint(slots[i].textBox, slots[j].textBox)).toBe(true);
          expect(disjoint(slots[i].chipBox, slots[j].textBox)).toBe(true);
        }
      }
    }
  });

  it("lays out a grid in the requested number of columns", () => {
    const plan = planLegend({ ...input, layout: "grid", columns: 2 }, []);
    const ys = new Set(
      plan.items.filter((item) => item.id.endsWith(":text")).map((item) => Math.round((item.y ?? 0) / 10)),
    );
    expect(ys.size).toBe(3);
    const row = planLegend({ ...input, layout: "row" }, []);
    expect(row.bounds.width).toBeGreaterThan(plan.bounds.width);
  });

  it("re-plans in place and removes items that are gone", () => {
    const first = planLegend(input, []);
    const live = applyPlan(first, []);
    const second = planLegend({ legendId: "lg", items: input.items.slice(0, 2) }, live);
    expect(second.items[0]).toMatchObject({ x: 40, y: 200 });
    expect(second.previousBounds).toEqual(first.bounds);
    expect(second.removeIds.sort()).toEqual(["lg:2:chip", "lg:2:text", "lg:3:chip", "lg:3:text", "lg:4:chip", "lg:4:text"]);
  });

  it("validates its input", () => {
    expect(() => planLegend({ ...input, items: [{ role: "banana", label: "x" }] }, [])).toThrow(/unknown role/);
    expect(() => planLegend({ ...input, origin: undefined }, [])).toThrow(/origin/);
    expect(() => planLegend({ ...input, items: [] }, [])).toThrow(/at least one item/);
  });
});
