import {describe, expect, it} from "vitest";

import {computeFixedPoint, normalizeFixedPoint, planArrowPath, planConnection, reshapeArrowPath} from "../bindings";
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

describe("routing a bound arrow", () => {
  const a = el({ type: "rectangle", id: "A", x: 0, y: 0, width: 100, height: 60 });
  const b = el({ type: "rectangle", id: "B", x: 400, y: 300, width: 100, height: 60 });

  it("threads explicit waypoints while keeping both bindings", () => {
    const path = planArrowPath(a, b, { waypoints: [[250, 0]] });
    expect(path.startBinding.elementId).toBe("A");
    expect(path.endBinding.elementId).toBe("B");
    expect(path.points).toHaveLength(3);
    const [wx, wy] = path.points[1];
    expect(path.x + wx).toBeCloseTo(250, 5);
    expect(path.y + wy).toBeCloseTo(0, 5);
  });

  it("builds an elbow for route:orthogonal and stays bound", () => {
    const path = planArrowPath(a, b, { route: "orthogonal" });
    expect(path.startBinding.elementId).toBe("A");
    expect(path.endBinding.elementId).toBe("B");
    expect(path.points).toHaveLength(4);
    const global = path.points.map(([x, y]) => [path.x + x, path.y + y]);
    for (let i = 0; i < global.length - 1; i++) {
      const horizontal = Math.abs(global[i][1] - global[i + 1][1]) < 0.001;
      const vertical = Math.abs(global[i][0] - global[i + 1][0]) < 0.001;
      expect(horizontal || vertical).toBe(true);
    }
  });

  it("leaves a direct arrow as a two-point segment", () => {
    expect(planArrowPath(a, b, {}).points).toHaveLength(2);
  });
});

describe("reshapeArrowPath", () => {
  const arrow = el({
    type: "arrow",
    x: 0,
    y: 0,
    width: 200,
    height: 100,
    points: [[0, 0], [200, 100]],
  });

  it("keeps the endpoints and inserts the detour", () => {
    const path = reshapeArrowPath(arrow, { waypoints: [[100, 0]] });
    expect(path.points).toEqual([[0, 0], [100, 0], [200, 100]]);
    expect(path.x).toBe(0);
    expect(path.y).toBe(0);
  });

  it("elbows an unbound arrow on request", () => {
    const path = reshapeArrowPath(arrow, { route: "orthogonal" });
    expect(path.points).toEqual([[0, 0], [100, 0], [100, 100], [200, 100]]);
  });
});
