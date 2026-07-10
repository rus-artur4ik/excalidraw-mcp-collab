import {describe, expect, it} from "vitest";

import {lintScene} from "../lint";
import {contrastRatio, parseColor, suggestReadableColor} from "../colors";
import {el} from "./factory";

describe("fix-ready suggestions", () => {
  it("overlap suggests the smallest single-axis move that separates", () => {
    const a = el({ type: "rectangle", x: 0, y: 0, width: 100, height: 100 });
    const b = el({ type: "rectangle", x: 80, y: 0, width: 100, height: 100 });
    const { findings } = lintScene([a, b]);
    const overlap = findings.find((finding) => finding.code === "overlap")!;
    const { dx, dy, id } = overlap.suggestion as { dx: number; dy: number; id: string };
    expect(id).toBe(b.id);
    const moved = { ...b, x: b.x + dx, y: b.y + dy };
    expect(moved.x >= a.x + a.width || moved.x + moved.width <= a.x || dy !== 0).toBe(true);
    expect(Math.abs(dx) + Math.abs(dy)).toBeLessThanOrEqual(100 + 20);
  });

  it("low_contrast suggests a concrete passing strokeColor", () => {
    const bg = el({
      type: "rectangle",
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      backgroundColor: "#ffec99",
      index: "a0",
    });
    const text = el({
      type: "text",
      x: 20,
      y: 20,
      width: 100,
      height: 25,
      strokeColor: "#ffffff",
      text: "hello",
      index: "a1",
    });
    const { findings } = lintScene([bg, text]);
    const contrast = findings.find((finding) => finding.code === "low_contrast")!;
    const suggested = (contrast.suggestion as { strokeColor?: string }).strokeColor;
    expect(suggested).toBeTruthy();
    expect(
      contrastRatio(parseColor(suggested)!, parseColor("#ffec99")!),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("alignment_near_miss carries an exact patch", () => {
    const a = el({ type: "rectangle", x: 0, y: 0, width: 100, height: 50 });
    const b = el({ type: "rectangle", x: 3, y: 200, width: 100, height: 50 });
    const { findings } = lintScene([a, b]);
    const near = findings.find((finding) => finding.code === "alignment_near_miss")!;
    const patch = (near.suggestion as { patch: { id: string; x?: number } }).patch;
    expect(patch.id).toBe(b.id);
    expect(patch.x).toBe(0);
  });

  it("suggestReadableColor prefers the perceptually closest passing candidate", () => {
    const white = parseColor("#ffffff")!;
    const nearWhite = parseColor("#eeeeee")!;
    const suggested = suggestReadableColor(nearWhite, white, 4.5, [
      "#1e1e1e",
      "#e03131",
    ]);
    expect(suggested).toBe("#e03131");
  });
});
