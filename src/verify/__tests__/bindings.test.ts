import {describe, expect, it} from "vitest";

import {computeFixedPoint, normalizeFixedPoint, planConnection} from "../bindings";
import {asLinear} from "../model";
import {el} from "./factory";

describe("normalizeFixedPoint", () => {
  it("nudges exact 0.5 to 0.5001", () => {
    expect(normalizeFixedPoint([0.5, 0.5])).toEqual([0.5001, 0.5001]);
  });
});

describe("computeFixedPoint", () => {
  it("returns edge ratios in the shape frame", () => {
    const rect = el({ type: "rectangle", x: 0, y: 0, width: 100, height: 60 });
    const [fx, fy] = computeFixedPoint(rect, [100, 30]);
    expect(fx).toBeCloseTo(1, 5);
    expect(fy).toBeCloseTo(0.5001, 5);
  });
});

describe("planConnection", () => {
  it("produces a bound arrow between two facing rectangles", () => {
    const a = el({ type: "rectangle", id: "A", x: 0, y: 0, width: 100, height: 60 });
    const b = el({ type: "rectangle", id: "B", x: 300, y: 0, width: 100, height: 60 });
    const plan = planConnection(a, b, { arrowId: "arrow-1" });

    expect(plan.arrow.type).toBe("arrow");
    const arrow = asLinear(plan.arrow as never);
    expect(arrow.startBinding).toEqual({
      elementId: "A",
      fixedPoint: [1, 0.5001],
      mode: "orbit",
    });
    expect(arrow.endBinding).toEqual({
      elementId: "B",
      fixedPoint: [0, 0.5001],
      mode: "orbit",
    });

    expect(plan.arrow.x).toBeCloseTo(106, 1);
    expect(plan.arrow.y).toBeCloseTo(30, 1);
    expect(plan.arrow.width).toBeCloseTo(188, 1);
    expect(arrow.points?.[0]).toEqual([0, 0]);
    expect(arrow.points?.[1]?.[0]).toBeCloseTo(188, 1);

    expect(plan.fromBoundElements).toContainEqual({ id: "arrow-1", type: "arrow" });
    expect(plan.toBoundElements).toContainEqual({ id: "arrow-1", type: "arrow" });
  });

  it("does not duplicate an existing back-reference", () => {
    const a = el({
      type: "rectangle",
      id: "A",
      boundElements: [{ id: "arrow-1", type: "arrow" }],
    });
    const b = el({ type: "rectangle", id: "B", x: 300 });
    const plan = planConnection(a, b, { arrowId: "arrow-1" });
    expect(plan.fromBoundElements.filter((e) => e.id === "arrow-1")).toHaveLength(1);
  });
});
