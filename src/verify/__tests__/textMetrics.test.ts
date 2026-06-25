import {describe, expect, it} from "vitest";

import {getBoundTextMaxWidth, measureText, wrapText,} from "../textMetrics";
import {el} from "./factory";

describe("measureText", () => {
  it("computes height as fontSize * lineHeight * lineCount (Excalifont 1.25)", () => {
    const single = measureText("hello", 20, 5);
    expect(single.height).toBeCloseTo(20 * 1.25, 5);
    const triple = measureText("a\nb\nc", 20, 5);
    expect(triple.lineCount).toBe(3);
    expect(triple.height).toBeCloseTo(20 * 1.25 * 3, 5);
  });

  it("returns a positive width that grows with text length", () => {
    const short = measureText("i", 20, 5).width;
    const long = measureText("mmmmmmmmmm", 20, 5).width;
    expect(short).toBeGreaterThan(0);
    expect(long).toBeGreaterThan(short);
  });

  it("treats monospace families with uniform advance", () => {
    const a = measureText("il", 20, 3).width;
    const b = measureText("MM", 20, 3).width;
    expect(a).toBeCloseTo(b, 5);
  });
});

describe("wrapText", () => {
  it("wraps a long line to fit a max width", () => {
    const wrapped = wrapText("one two three four five six seven", 20, 5, 80);
    expect(wrapped.split("\n").length).toBeGreaterThan(1);
  });

  it("returns input unchanged when it fits", () => {
    expect(wrapText("hi", 20, 5, 10000)).toBe("hi");
  });
});

describe("bound text geometry", () => {
  it("subtracts padding for a rectangle container", () => {
    const container = el({ type: "rectangle", width: 200, height: 100 });
    expect(getBoundTextMaxWidth(container, 20)).toBe(200 - 10);
  });
});
