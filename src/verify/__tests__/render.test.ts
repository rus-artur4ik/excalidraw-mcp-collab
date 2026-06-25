import {describe, expect, it} from "vitest";

import {elementAtPoint, renderSvg} from "../render";
import {el} from "./factory";

describe("renderSvg", () => {
  it("emits an svg with a legend entry per drawn element", () => {
    const result = renderSvg([
      el({ type: "rectangle", x: 0, y: 0, width: 100, height: 60 }),
      el({ type: "ellipse", x: 200, y: 0, width: 80, height: 80 }),
    ]);
    expect(result.svg.startsWith("<svg")).toBe(true);
    expect(result.svg).toContain("<rect");
    expect(result.svg).toContain("<ellipse");
    expect(result.legend).toHaveLength(2);
    expect(result.legend[0].label).toBe("1");
    expect(result.width).toBeGreaterThan(0);
  });

  it("maps a legend bbox through the transform", () => {
    const result = renderSvg(
      [el({ type: "rectangle", x: 50, y: 50, width: 100, height: 100 })],
      { padding: 10, scale: 1 },
    );
    const entry = result.legend[0];
    expect(entry.bbox[0]).toBe(10);
    expect(entry.bbox[1]).toBe(10);
    expect(entry.bbox[2]).toBe(100);
    expect(entry.bbox[3]).toBe(100);
  });

  it("escapes text content", () => {
    const result = renderSvg([
      el({ type: "text", x: 0, y: 0, width: 100, height: 20, text: "a < b & c", fontSize: 20 }),
    ]);
    expect(result.svg).toContain("a &lt; b &amp; c");
  });

  it("can restrict to a subset of ids", () => {
    const result = renderSvg(
      [
        el({ type: "rectangle", id: "keep", x: 0, y: 0, width: 50, height: 50 }),
        el({ type: "rectangle", id: "drop", x: 500, y: 500, width: 50, height: 50 }),
      ],
      { ids: ["keep"] },
    );
    expect(result.legend).toHaveLength(1);
    expect(result.legend[0].id).toBe("keep");
  });
});

describe("elementAtPoint", () => {
  it("returns the top-most element by z-order", () => {
    const bottom = el({ type: "rectangle", id: "bottom", x: 0, y: 0, width: 100, height: 100, index: "a1" });
    const top = el({ type: "rectangle", id: "top", x: 0, y: 0, width: 100, height: 100, index: "a2" });
    expect(elementAtPoint([bottom, top], 50, 50)?.id).toBe("top");
  });

  it("returns null when nothing is hit", () => {
    expect(elementAtPoint([el({ type: "rectangle", x: 0, y: 0, width: 10, height: 10 })], 500, 500)).toBeNull();
  });
});
