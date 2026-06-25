import {describe, expect, it} from "vitest";

import {distanceToElement} from "../geometry";
import {lintScene} from "../lint";
import {renderSvg} from "../render";
import {el} from "./factory";

describe("distanceToElement for linear elements", () => {
  const arrow = el({
    type: "arrow",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    points: [
      [0, 0],
      [100, 100],
    ],
  });

  it("does not report 0 for a point inside the bbox but far from the stroke", () => {
    expect(distanceToElement(arrow, 100, 0)).toBeGreaterThan(50);
  });

  it("reports a small distance for a point near the diagonal", () => {
    expect(distanceToElement(arrow, 51, 49)).toBeLessThan(3);
  });
});

describe("occlusion shape-awareness", () => {
  it("does not flag an ellipse whose bbox merely contains a corner label", () => {
    const ellipse = el({
      type: "ellipse",
      id: "E",
      x: 0,
      y: 0,
      width: 200,
      height: 200,
      backgroundColor: "#ffd43b",
      fillStyle: "solid",
      index: "a1",
    });
    const label = el({
      type: "rectangle",
      id: "L",
      x: 5,
      y: 5,
      width: 10,
      height: 10,
      index: "a0",
    });
    const findings = lintScene([label, ellipse]).findings;
    expect(findings.map((f) => f.code)).not.toContain("occlusion");
  });

  it("still flags a rectangle fully covering a lower element", () => {
    const cover = el({
      type: "rectangle",
      id: "C",
      x: 0,
      y: 0,
      width: 200,
      height: 200,
      backgroundColor: "#ffd43b",
      fillStyle: "solid",
      index: "a1",
    });
    const under = el({
      type: "rectangle",
      id: "U",
      x: 50,
      y: 50,
      width: 20,
      height: 20,
      index: "a0",
    });
    const findings = lintScene([under, cover]).findings;
    expect(findings.map((f) => f.code)).toContain("occlusion");
  });
});

describe("arrow-label overflow", () => {
  it("does not spuriously flag a short label on a zero-height arrow", () => {
    const arrow = el({
      type: "arrow",
      id: "AR",
      x: 0,
      y: 0,
      width: 120,
      height: 0,
      points: [
        [0, 0],
        [120, 0],
      ],
    });
    const label = el({
      type: "text",
      id: "T",
      x: 0,
      y: 0,
      width: 40,
      height: 20,
      text: "ok",
      fontSize: 20,
      fontFamily: 5,
      containerId: "AR",
    });
    const findings = lintScene([arrow, label]).findings;
    expect(findings.map((f) => f.code)).not.toContain("text_overflow");
  });
});

describe("render robustness", () => {
  it("escapes hostile color values into svg attributes", () => {
    const result = renderSvg([
      el({ type: "rectangle", x: 0, y: 0, width: 50, height: 50, strokeColor: '#fff" x="0' }),
    ]);
    expect(result.svg).not.toContain('#fff" x="0"');
    expect(result.svg).toContain("&quot;");
  });

  it("clamps an absurd scale so the bitmap stays bounded", () => {
    const result = renderSvg(
      [el({ type: "rectangle", x: 0, y: 0, width: 1000, height: 1000 })],
      { scale: 1000 },
    );
    expect(result.width * result.height).toBeLessThanOrEqual(4_000_000 + 1);
  });
});
