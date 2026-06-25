import {describe, expect, it} from "vitest";

import {
    arrangePositions,
    boundsArea,
    computeTransform,
    distanceToElement,
    getCommonBounds,
    getElementBounds,
    intersectionArea,
    pixelToScene,
    pointInElement,
    sceneToPixel,
} from "../geometry";
import {el} from "./factory";

describe("getElementBounds", () => {
  it("returns the axis-aligned box for an unrotated rectangle", () => {
    const bounds = getElementBounds(
      el({ type: "rectangle", x: 10, y: 20, width: 100, height: 40 }),
    );
    expect(bounds).toEqual([10, 20, 110, 60]);
  });

  it("expands the box for a 90deg rotation", () => {
    const bounds = getElementBounds(
      el({ type: "rectangle", x: 0, y: 0, width: 100, height: 40, angle: Math.PI / 2 }),
    );
    expect(bounds[0]).toBeCloseTo(30, 5);
    expect(bounds[1]).toBeCloseTo(-30, 5);
    expect(bounds[2]).toBeCloseTo(70, 5);
    expect(bounds[3]).toBeCloseTo(70, 5);
  });

  it("uses point extents for arrows", () => {
    const bounds = getElementBounds(
      el({
        type: "arrow",
        x: 100,
        y: 100,
        width: 50,
        height: 0,
        points: [
          [0, 0],
          [50, 0],
        ],
      }),
    );
    expect(bounds).toEqual([100, 100, 150, 100]);
  });
});

describe("intersection + common bounds", () => {
  it("computes overlap area", () => {
    const a = getElementBounds(el({ type: "rectangle", x: 0, y: 0, width: 100, height: 100 }));
    const b = getElementBounds(el({ type: "rectangle", x: 50, y: 50, width: 100, height: 100 }));
    expect(intersectionArea(a, b)).toBe(2500);
    expect(boundsArea(a)).toBe(10000);
  });

  it("returns zero for disjoint boxes", () => {
    const a = getElementBounds(el({ type: "rectangle", x: 0, y: 0, width: 10, height: 10 }));
    const b = getElementBounds(el({ type: "rectangle", x: 100, y: 100, width: 10, height: 10 }));
    expect(intersectionArea(a, b)).toBe(0);
  });

  it("unions all elements", () => {
    const common = getCommonBounds([
      el({ type: "rectangle", x: 0, y: 0, width: 10, height: 10 }),
      el({ type: "rectangle", x: 90, y: 40, width: 10, height: 10 }),
    ]);
    expect(common).toEqual([0, 0, 100, 50]);
  });
});

describe("hit testing", () => {
  it("detects points inside a rectangle and outside it", () => {
    const r = el({ type: "rectangle", x: 0, y: 0, width: 100, height: 100 });
    expect(pointInElement(r, 50, 50)).toBe(true);
    expect(pointInElement(r, 150, 50)).toBe(false);
  });

  it("respects ellipse curvature", () => {
    const e = el({ type: "ellipse", x: 0, y: 0, width: 100, height: 100 });
    expect(pointInElement(e, 50, 50)).toBe(true);
    expect(pointInElement(e, 2, 2)).toBe(false);
  });

  it("measures distance to a far point", () => {
    const r = el({ type: "rectangle", x: 0, y: 0, width: 100, height: 100 });
    expect(distanceToElement(r, 50, 50)).toBe(0);
    expect(distanceToElement(r, 110, 50)).toBeCloseTo(10, 5);
  });
});

describe("transform", () => {
  it("round-trips scene <-> pixel", () => {
    const t = computeTransform([0, 0, 200, 100], 10, 2);
    expect(t.pixelWidth).toBe((200 + 20) * 2);
    const [px, py] = sceneToPixel(t, 50, 50);
    const [sx, sy] = pixelToScene(t, px, py);
    expect(sx).toBeCloseTo(50, 6);
    expect(sy).toBeCloseTo(50, 6);
  });
});

describe("arrange", () => {
  it("aligns left edges", () => {
    const positions = arrangePositions(
      [
        el({ type: "rectangle", x: 10, y: 0, width: 50, height: 50 }),
        el({ type: "rectangle", x: 80, y: 100, width: 50, height: 50 }),
      ],
      { mode: "align", edge: "left" },
    );
    const xs = [...positions.values()].map((p) => p[0]);
    expect(xs.every((x) => x === 10)).toBe(true);
  });

  it("lays out a row with gaps", () => {
    const a = el({ type: "rectangle", x: 0, y: 0, width: 40, height: 40 });
    const b = el({ type: "rectangle", x: 999, y: 999, width: 40, height: 40 });
    const positions = arrangePositions([a, b], { mode: "row", gap: 10 });
    expect(positions.get(a.id)![0]).toBe(0);
    expect(positions.get(b.id)![0]).toBe(50);
  });
});
