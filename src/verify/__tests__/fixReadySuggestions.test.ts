import {describe, expect, it} from "vitest";

import {lintScene} from "../lint";
import {contrastRatio, parseColor, suggestReadableColor} from "../colors";
import {el} from "./factory";

type Executable = { tool: string; args: Record<string, unknown>; risk: string };

const executable = (suggestion: unknown): Executable => {
  expect(suggestion).toHaveProperty("tool");
  return suggestion as Executable;
};

const patches = (suggestion: unknown) =>
  (executable(suggestion).args.elements as Array<{ id: string } & Record<string, number | string>>);

describe("fix-ready suggestions", () => {
  it("overlap moves the smaller element with move_elements by the smallest single-axis push", () => {
    const a = el({ type: "rectangle", x: 0, y: 0, width: 100, height: 100 });
    const b = el({ type: "rectangle", x: 80, y: 0, width: 60, height: 60 });
    const { findings } = lintScene([a, b]);
    const overlap = findings.find((finding) => finding.code === "overlap")!;
    const move = executable(overlap.suggestion);
    expect(move.tool).toBe("move_elements");
    const { target, dx = 0, dy = 0 } = move.args as { target: { ids: string[] }; dx?: number; dy?: number };
    expect(target.ids).toEqual([b.id]);
    const moved = { x: b.x + dx, y: b.y + dy };
    const separated =
      moved.x >= a.x + a.width || moved.x + b.width <= a.x || moved.y >= a.y + a.height || moved.y + b.height <= a.y;
    expect(separated).toBe(true);
    expect(Math.abs(dx) + Math.abs(dy)).toBeLessThanOrEqual(100 + 20);
  });

  it("low_contrast suggests a concrete passing strokeColor on the text id", () => {
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
    const [patch] = patches(contrast.suggestion);
    expect(patch.id).toBe(text.id);
    expect(
      contrastRatio(parseColor(patch.strokeColor as string)!, parseColor("#ffec99")!),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("alignment_near_miss carries an absolute coordinate patch", () => {
    const a = el({ type: "rectangle", x: 0, y: 0, width: 100, height: 50, groupIds: ["g"] });
    const b = el({ type: "rectangle", x: 3, y: 200, width: 100, height: 50, groupIds: ["g"] });
    const { findings } = lintScene([a, b]);
    const near = findings.find((finding) => finding.code === "alignment_near_miss")!;
    const [patch] = patches(near.suggestion);
    expect(patch.id).toBe(b.id);
    expect(patch.x).toBe(0);
    expect(patch).not.toHaveProperty("dx");
  });

  it("suggestReadableColor keeps the hue and only darkens/lightens", () => {
    const white = parseColor("#ffffff")!;
    const green = parseColor("#2b8a3e")!;
    const suggested = parseColor(
      suggestReadableColor(green, white, 4.5, ["#1e1e1e", "#e03131"])!,
    )!;
    expect(contrastRatio(suggested, white)).toBeGreaterThanOrEqual(4.5);
    expect(suggested.g).toBeGreaterThan(suggested.r);
    expect(suggested.g).toBeGreaterThan(suggested.b);
  });

  it("suggestReadableColor does not turn an achromatic color into a hue", () => {
    const white = parseColor("#ffffff")!;
    const nearWhite = parseColor("#eeeeee")!;
    const suggested = parseColor(
      suggestReadableColor(nearWhite, white, 4.5, ["#1e1e1e", "#e03131"])!,
    )!;
    expect(contrastRatio(suggested, white)).toBeGreaterThanOrEqual(4.5);
    expect(suggested.r).toBe(suggested.g);
    expect(suggested.g).toBe(suggested.b);
  });
});
