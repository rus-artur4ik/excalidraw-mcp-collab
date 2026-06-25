import {describe, expect, it} from "vitest";

import {lintScene} from "../lint";
import {el} from "./factory";

const codes = (findings: { code: string }[]) => findings.map((f) => f.code);

describe("structural lint", () => {
  it("flags degenerate size and empty text", () => {
    const { findings } = lintScene([
      el({ type: "rectangle", width: 0, height: 50 }),
      el({ type: "text", text: "   ", width: 50, height: 20 }),
    ]);
    expect(codes(findings)).toContain("degenerate_size");
    expect(codes(findings)).toContain("empty_text");
  });

  it("flags invalid enums and out-of-range values", () => {
    const { findings } = lintScene([
      el({ type: "rectangle", fillStyle: "plaid", roughness: 9, opacity: 250 }),
    ]);
    expect(codes(findings)).toContain("invalid_enum");
    expect(codes(findings)).toContain("out_of_range");
  });
});

describe("overlap + duplicate", () => {
  it("detects two heavily overlapping rectangles", () => {
    const { findings } = lintScene([
      el({ type: "rectangle", x: 0, y: 0, width: 100, height: 100 }),
      el({ type: "rectangle", x: 10, y: 10, width: 100, height: 100 }),
    ]);
    expect(codes(findings)).toContain("overlap");
  });

  it("does not flag well-separated rectangles", () => {
    const { findings } = lintScene([
      el({ type: "rectangle", x: 0, y: 0, width: 100, height: 100 }),
      el({ type: "rectangle", x: 300, y: 0, width: 100, height: 100 }),
    ]);
    expect(codes(findings)).not.toContain("overlap");
  });

  it("detects duplicates", () => {
    const { findings } = lintScene([
      el({ type: "rectangle", x: 0, y: 0, width: 100, height: 100, strokeColor: "#000" }),
      el({ type: "rectangle", x: 0.5, y: 0.5, width: 100, height: 100, strokeColor: "#000" }),
    ]);
    expect(codes(findings)).toContain("duplicate");
  });
});

describe("text overflow", () => {
  it("flags text that does not fit its container", () => {
    const container = el({ type: "rectangle", id: "c", x: 0, y: 0, width: 40, height: 24 });
    const text = el({
      type: "text",
      id: "t",
      x: 0,
      y: 0,
      width: 30,
      height: 20,
      text: "this is a very long label that cannot fit",
      fontSize: 20,
      fontFamily: 5,
      containerId: "c",
    });
    const { findings } = lintScene([container, text]);
    expect(codes(findings)).toContain("text_overflow");
  });
});

describe("binding integrity", () => {
  it("flags a dangling binding", () => {
    const { findings } = lintScene([
      el({
        type: "arrow",
        x: 0,
        y: 0,
        width: 50,
        height: 0,
        points: [
          [0, 0],
          [50, 0],
        ],
        startBinding: { elementId: "missing", fixedPoint: [1, 0.5], mode: "orbit" },
        endBinding: null,
      }),
    ]);
    expect(codes(findings)).toContain("arrow_dangling_binding");
  });

  it("flags a missing back-reference", () => {
    const target = el({ type: "rectangle", id: "R", x: 0, y: 0, width: 100, height: 60 });
    const arrow = el({
      type: "arrow",
      id: "AR",
      x: 100,
      y: 30,
      width: 50,
      height: 0,
      points: [
        [0, 0],
        [50, 0],
      ],
      startBinding: { elementId: "R", fixedPoint: [1, 0.5001], mode: "orbit" },
      endBinding: null,
    });
    const { findings } = lintScene([target, arrow]);
    expect(codes(findings)).toContain("binding_backref_missing");
  });

  it("flags an invalid binding without mode", () => {
    const target = el({ type: "rectangle", id: "R" });
    const arrow = el({
      type: "arrow",
      id: "AR",
      points: [
        [0, 0],
        [50, 0],
      ],
      startBinding: { elementId: "R", fixedPoint: [1, 0.5] },
      endBinding: null,
    });
    const { findings } = lintScene([target, arrow]);
    expect(codes(findings)).toContain("binding_invalid");
  });

  it("flags an unbound endpoint touching a shape", () => {
    const rect = el({ type: "rectangle", id: "R", x: 0, y: 0, width: 100, height: 60 });
    const arrow = el({
      type: "arrow",
      id: "AR",
      x: 200,
      y: 30,
      width: 99,
      height: 0,
      points: [
        [0, 0],
        [-99, 0],
      ],
      startBinding: null,
      endBinding: null,
    });
    const { findings } = lintScene([rect, arrow]);
    expect(codes(findings)).toContain("arrow_unbound_endpoint");
  });
});

describe("contrast + graph", () => {
  it("flags low-contrast text on white", () => {
    const { findings } = lintScene([
      el({ type: "text", text: "hi", width: 40, height: 20, strokeColor: "#ffffff" }),
    ]);
    expect(codes(findings)).toContain("low_contrast");
  });

  it("reports isolated nodes in the connectivity graph", () => {
    const a = el({ type: "rectangle", id: "A", x: 0, y: 0, width: 80, height: 40 });
    const b = el({ type: "rectangle", id: "B", x: 200, y: 0, width: 80, height: 40 });
    const lonely = el({ type: "rectangle", id: "C", x: 0, y: 200, width: 80, height: 40 });
    const arrow = el({
      type: "arrow",
      id: "AR",
      x: 80,
      y: 20,
      width: 120,
      height: 0,
      points: [
        [0, 0],
        [120, 0],
      ],
      startBinding: { elementId: "A", fixedPoint: [1, 0.5001], mode: "orbit" },
      endBinding: { elementId: "B", fixedPoint: [0, 0.5001], mode: "orbit" },
      boundElements: null,
    });
    a.boundElements = [{ id: "AR", type: "arrow" }];
    b.boundElements = [{ id: "AR", type: "arrow" }];
    const { graph } = lintScene([a, b, lonely, arrow]);
    expect(graph.nodeCount).toBe(3);
    expect(graph.edgeCount).toBe(1);
    expect(graph.isolated).toContain("C");
  });
});
