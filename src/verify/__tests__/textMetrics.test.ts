import {describe, expect, it} from "vitest";

import {
    containerSizeForText,
    fitTextToContainer,
    getBoundTextMaxHeight,
    getBoundTextMaxWidth,
    largestFittingFontSize,
    layoutText,
    measureText,
    wrapText,
} from "../textMetrics";
import {el} from "./factory";
import {type LabelStyle, layoutLabel} from "../../engine/boundText";

// The label layout the write engine uses (client formula).
const layoutBoundText = (
  container: Parameters<typeof layoutLabel>[0],
  text: string,
  fontSize: number,
  fontFamily: number,
  verticalAlign: LabelStyle["verticalAlign"] = "middle",
) => {
  const layout = layoutLabel(container, text, { fontSize, fontFamily, textAlign: "center", verticalAlign });
  return { ...layout, containerHeight: layout.containerHeight };
};

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

describe("layoutText", () => {
  it("auto-sizes to content height", () => {
    const layout = layoutText("hello", 20, 5);
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBe(Math.ceil(20 * 1.25));
    expect(layout.text).toBe("hello");
  });

  it("wraps to a fixed maxWidth and reports that width", () => {
    const layout = layoutText("one two three four five", 20, 5, 60);
    expect(layout.width).toBe(60);
    expect(layout.text).toContain("\n");
  });
});

describe("layoutBoundText", () => {
  it("centers the text inside its container", () => {
    const container = el({ type: "rectangle", x: 0, y: 0, width: 200, height: 100 });
    const layout = layoutBoundText(container, "hi", 20, 5);
    expect(layout.x + layout.width / 2).toBeCloseTo(100, 0);
    expect(layout.y).toBeGreaterThanOrEqual(0);
    expect(layout.containerHeight).toBeGreaterThanOrEqual(100);
  });

  it("grows the container height when the text is taller", () => {
    const container = el({ type: "rectangle", x: 0, y: 0, width: 80, height: 10 });
    const layout = layoutBoundText(container, "wraps onto several lines here", 20, 5);
    expect(layout.containerHeight).toBeGreaterThan(10);
  });

  it("pins the text to the top when verticalAlign is top", () => {
    const container = el({ type: "rectangle", x: 0, y: 0, width: 200, height: 100 });
    const middle = layoutBoundText(container, "hi", 20, 5);
    const top = layoutBoundText(container, "hi", 20, 5, "top");
    expect(top.y).toBe(5);
    expect(top.y).toBeLessThan(middle.y);
  });

  it("pins the text to the bottom when verticalAlign is bottom", () => {
    const container = el({ type: "rectangle", x: 0, y: 0, width: 200, height: 100 });
    const bottom = layoutBoundText(container, "hi", 20, 5, "bottom");
    expect(bottom.y).toBeCloseTo(100 - bottom.height - 5, 5);
  });
});

describe("containerSizeForText", () => {
  it("is the exact inverse of the usable-area formula for every shape", () => {
    for (const type of ["rectangle", "ellipse", "diamond"]) {
      const box = containerSizeForText(type, 190, 60);
      const container = el({ type, x: 0, y: 0, ...box });
      expect(getBoundTextMaxWidth(container, 20)).toBeGreaterThanOrEqual(190);
      expect(getBoundTextMaxHeight(container)).toBeGreaterThanOrEqual(60);
    }
  });

  it("demands twice the box of a rectangle for a diamond", () => {
    const rectangle = containerSizeForText("rectangle", 100, 40);
    const diamond = containerSizeForText("diamond", 100, 40);
    expect(diamond.width).toBe(rectangle.width * 2);
    expect(diamond.height).toBe(rectangle.height * 2);
  });
});

const DIAMOND_OVERFLOW_TEXT =
  "one two three four five six seven eight nine ten eleven twelve";

describe("fitTextToContainer", () => {
  it("reports a diamond overflow on the height axis, not the width", () => {
    const diamond = el({ type: "diamond", x: 0, y: 0, width: 400, height: 180 });
    const fit = fitTextToContainer(diamond, DIAMOND_OVERFLOW_TEXT, 20, 5);
    expect(fit.textWidth).toBeLessThanOrEqual(fit.usableWidth);
    expect(fit.widthOverflow).toBe(false);
    expect(fit.heightOverflow).toBe(true);
  });

  it("never proposes a fitted size that equals the current one", () => {
    const diamond = el({ type: "diamond", x: 0, y: 0, width: 400, height: 180 });
    const fit = fitTextToContainer(diamond, DIAMOND_OVERFLOW_TEXT, 20, 5);
    expect(fit.fittedHeight).toBeGreaterThan(180);
    const grown = el({ type: "diamond", x: 0, y: 0, width: 400, height: fit.fittedHeight });
    expect(fitTextToContainer(grown, DIAMOND_OVERFLOW_TEXT, 20, 5).heightOverflow).toBe(false);
  });

  it("grows the width when a single glyph cannot fit, then rewraps before measuring height", () => {
    const rect = el({ type: "rectangle", x: 0, y: 0, width: 14, height: 40 });
    const fit = fitTextToContainer(rect, "Wide", 20, 5);
    expect(fit.widthOverflow).toBe(true);
    const grown = el({
      type: "rectangle",
      x: 0,
      y: 0,
      width: fit.fittedWidth,
      height: fit.fittedHeight,
    });
    const refit = fitTextToContainer(grown, "Wide", 20, 5);
    expect(refit.widthOverflow).toBe(false);
    expect(refit.heightOverflow).toBe(false);
  });

  it("never reports height overflow on an arrow label", () => {
    const arrow = el({
      type: "arrow",
      x: 0,
      y: 0,
      width: 200,
      height: 0,
      points: [[0, 0], [200, 0]],
    });
    expect(fitTextToContainer(arrow, "yes", 20, 5).heightOverflow).toBe(false);
  });
});

describe("largestFittingFontSize", () => {
  it("finds a font size that actually fits, or null", () => {
    const diamond = el({ type: "diamond", x: 0, y: 0, width: 400, height: 180 });
    const text = DIAMOND_OVERFLOW_TEXT;
    const size = largestFittingFontSize(diamond, text, 5, 20)!;
    expect(size).toBeLessThan(20);
    const fit = fitTextToContainer(diamond, text, size, 5);
    expect(fit.widthOverflow || fit.heightOverflow).toBe(false);
  });

  it("returns null when nothing fits", () => {
    const tiny = el({ type: "diamond", x: 0, y: 0, width: 20, height: 20 });
    expect(largestFittingFontSize(tiny, "a very long label indeed", 5, 20)).toBeNull();
  });
});

describe("layoutBoundText on a linear container", () => {
  it("centres the label on the arrow and leaves its height alone", () => {
    const arrow = el({
      type: "arrow",
      x: 0,
      y: 0,
      width: 200,
      height: 0,
      points: [[0, 0], [200, 0]],
    });
    const layout = layoutBoundText(arrow, "yes", 16, 5);
    expect(layout.containerHeight).toBe(0);
    expect(layout.x + layout.width / 2).toBeCloseTo(100, 5);
    expect(layout.y + layout.height / 2).toBeCloseTo(0, 5);
  });
});
