import {describe, expect, it} from "vitest";

import {lintElement, lintScene} from "../lint";
import {segmentElementOverlap} from "../geometry";
import {planArrowPath} from "../bindings";
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

describe("bound text stacking", () => {
  const container = (index: string) =>
    el({
      type: "rectangle",
      id: "box",
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      index,
      boundElements: [{ id: "label", type: "text" }],
    });
  const label = (index: string) =>
    el({
      type: "text",
      id: "label",
      x: 20,
      y: 40,
      width: 100,
      height: 20,
      text: "hi",
      containerId: "box",
      index,
    });

  it("flags a bound text stacked below (hidden behind) its container", () => {
    const { findings } = lintScene([container("a5"), label("a1")]);
    expect(codes(findings)).toContain("bound_text_below_container");
  });

  it("does not flag a bound text stacked above its container", () => {
    const { findings } = lintScene([container("a1"), label("a5")]);
    expect(codes(findings)).not.toContain("bound_text_below_container");
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
  const dangling = (customData?: Record<string, unknown>) =>
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
      ...(customData ? { customData } : {}),
    });

  it("flags a binding to a missing element as binding_target_missing", () => {
    const { findings } = lintScene([dangling()]);
    expect(codes(findings)).toContain("binding_target_missing");
    expect(codes(findings)).not.toContain("arrow_dangling_binding");
  });

  it("still honours a lintIgnore of the old arrow_dangling_binding code", () => {
    const { findings } = lintScene([dangling({ lintIgnore: ["arrow_dangling_binding"] })]);
    expect(codes(findings)).not.toContain("binding_target_missing");
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

  it("flags an unbound arrowhead touching a shape", () => {
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
      endArrowhead: "arrow",
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

describe("contrast reads z-order backing", () => {
  it("uses the filled shape under the text, not the white canvas", () => {
    const header = el({
      type: "rectangle",
      x: 0,
      y: 0,
      width: 200,
      height: 60,
      backgroundColor: "#1e1e1e",
      fillStyle: "solid",
    });
    const label = el({
      type: "text",
      x: 20,
      y: 20,
      width: 120,
      height: 24,
      fontSize: 18,
      text: "Header",
      strokeColor: "#ffffff",
    });
    const { findings } = lintScene([header, label]);
    expect(codes(findings)).not.toContain("low_contrast");
  });

  it("still flags text that clashes with the backing shape", () => {
    const header = el({
      type: "rectangle",
      x: 0,
      y: 0,
      width: 200,
      height: 60,
      backgroundColor: "#1e1e1e",
      fillStyle: "solid",
    });
    const label = el({
      type: "text",
      x: 20,
      y: 20,
      width: 120,
      height: 24,
      fontSize: 18,
      text: "Header",
      strokeColor: "#222222",
    });
    const { findings } = lintScene([header, label]);
    expect(codes(findings)).toContain("low_contrast");
  });
});

describe("overlap treats contained text as a label", () => {
  it("does not flag text fully inside a shape", () => {
    const box = el({ type: "rectangle", x: 0, y: 0, width: 200, height: 100 });
    const label = el({ type: "text", x: 20, y: 30, width: 80, height: 24, text: "Label" });
    const { findings } = lintScene([box, label]);
    expect(codes(findings)).not.toContain("overlap");
  });

  it("still flags text that spills out of the shape", () => {
    const box = el({ type: "rectangle", x: 0, y: 0, width: 80, height: 40 });
    const label = el({ type: "text", x: 40, y: 10, width: 200, height: 24, text: "Way too long" });
    const { findings } = lintScene([box, label]);
    expect(codes(findings)).toContain("overlap");
  });
});

// alignment_near_miss only compares elements that share a frame, group or
// table, so these pairs are grouped.
describe("alignment near-miss noise reduction", () => {
  const grouped = { groupIds: ["g"] };

  it("stays quiet when already centered on an axis", () => {
    const a = el({ type: "rectangle", x: 0, y: 0, width: 100, height: 100, ...grouped });
    const b = el({ type: "rectangle", x: 300, y: 2, width: 100, height: 96, ...grouped });
    const { findings } = lintScene([a, b]);
    expect(codes(findings)).not.toContain("alignment_near_miss");
  });

  it("still flags a genuine few-px misalignment", () => {
    const a = el({ type: "rectangle", x: 0, y: 0, width: 100, height: 100, ...grouped });
    const b = el({ type: "rectangle", x: 2, y: 300, width: 100, height: 100, ...grouped });
    const { findings } = lintScene([a, b]);
    expect(codes(findings)).toContain("alignment_near_miss");
  });

  it("stays quiet for a row of different-radius circles sharing centerY", () => {
    const a = el({ type: "ellipse", x: 0, y: 100, width: 100, height: 100, ...grouped });
    const b = el({ type: "ellipse", x: 200, y: 102, width: 96, height: 96, ...grouped });
    const { findings } = lintScene([a, b]);
    expect(codes(findings)).not.toContain("alignment_near_miss");
  });

  it("points at the center, not the edges, when near-centered with unequal sizes", () => {
    const a = el({ type: "ellipse", x: 0, y: 100, width: 100, height: 100, ...grouped });
    const b = el({ type: "ellipse", x: 200, y: 105, width: 96, height: 96, ...grouped });
    const { findings } = lintScene([a, b]);
    const near = findings.filter((finding) => finding.code === "alignment_near_miss");
    expect(near).toHaveLength(1);
    expect(near[0].message).toContain("centerY");
    expect(near[0].kind).toBe("centerY");
  });

  it("still flags an edge alignment when centers are far apart", () => {
    const a = el({ type: "rectangle", x: 0, y: 0, width: 100, height: 100, ...grouped });
    const b = el({ type: "rectangle", x: 2, y: 300, width: 200, height: 100, ...grouped });
    const { findings } = lintScene([a, b]);
    const near = findings.find((finding) => finding.code === "alignment_near_miss");
    expect(near?.kind).toBe("left");
  });

  it("does not compare elements that share nothing", () => {
    const a = el({ type: "rectangle", x: 0, y: 0, width: 100, height: 100 });
    const b = el({ type: "rectangle", x: 2, y: 300, width: 100, height: 100 });
    const { findings } = lintScene([a, b]);
    expect(codes(findings)).not.toContain("alignment_near_miss");
  });
});

describe("scoped validate", () => {
  it("keeps only findings touching scoped ids", () => {
    const a = el({ type: "rectangle", x: 0, y: 0, width: 100, height: 100, fillStyle: "plaid" });
    const b = el({ type: "rectangle", x: 500, y: 0, width: 0, height: 50 });
    const scoped = lintScene([a, b], { ids: [b.id] });
    expect(scoped.findings.length).toBeGreaterThan(0);
    expect(scoped.findings.every((f) => f.elementIds.includes(b.id))).toBe(true);
    expect(scoped.scope).toEqual({ kind: "ids", matched: 1 });
  });

  it("summaryOnly drops findings but keeps the counts", () => {
    const b = el({ type: "rectangle", x: 0, y: 0, width: 0, height: 50 });
    const result = lintScene([b], { summaryOnly: true });
    expect(result.findings).toEqual([]);
    expect(result.summary.errors).toBeGreaterThan(0);
  });

  it("minSeverity drops lower-severity findings", () => {
    const a = el({ type: "rectangle", x: 0, y: 0, width: 100, height: 100, strokeColor: "#123456" });
    const b = el({ type: "rectangle", x: 0, y: 300, width: 100, height: 100 });
    expect(lintScene([a, b]).findings.some((f) => f.severity === "info")).toBe(true);
    const result = lintScene([a, b], { minSeverity: "warning" });
    expect(result.findings.some((f) => f.severity === "info")).toBe(false);
    expect(result.summary.coverage).not.toContain("style_off_palette_color");
  });

  it("codes keeps only the requested rule", () => {
    const a = el({ type: "rectangle", x: 0, y: 0, width: 100, height: 100, fillStyle: "plaid" });
    const b = el({ type: "rectangle", x: 0, y: 0, width: 0, height: 50 });
    const result = lintScene([a, b], { codes: ["degenerate_size"] });
    expect(result.findings.every((f) => f.code === "degenerate_size")).toBe(true);
    expect(result.findings.length).toBeGreaterThan(0);
  });
});

describe("text_overflow names the axis that actually failed", () => {
  const label = (containerId: string) =>
    el({
      type: "text",
      id: "T",
      containerId,
      text: "one two three four five six seven eight nine ten eleven twelve",
      fontSize: 20,
      fontFamily: 5,
      index: "a2",
    });

  it("reports the height axis for a diamond whose text fits horizontally", () => {
    const diamond = el({ type: "diamond", id: "D", x: 0, y: 0, width: 400, height: 180, index: "a1" });
    const { findings } = lintScene([diamond, label("D")]);
    const overflow = findings.find((f) => f.code === "text_overflow")!;
    expect(overflow.message).toContain("too TALL");
    expect(overflow.message).not.toContain("too WIDE");
  });

  const patchOf = (suggestion: unknown) =>
    ((suggestion as { args: { elements: Array<Record<string, unknown>> } }).args.elements)[0];

  it("suggests a strictly larger container, never the current size", () => {
    const diamond = el({ type: "diamond", id: "D", x: 0, y: 0, width: 400, height: 180, index: "a1" });
    const { findings } = lintScene([diamond, label("D")]);
    const overflow = findings.find((f) => f.code === "text_overflow")!;
    expect(overflow.kind).toBe("overflow");
    expect(overflow.severity).toBe("error");
    expect(overflow.suggestion).toMatchObject({ tool: "update_elements" });
    const patch = patchOf(overflow.suggestion);
    expect(patch.id).toBe("D");
    expect(patch.height as number).toBeGreaterThan(180);
    expect(patch.width).toBeUndefined();
  });

  it("offers shrinking the text as an alternative", () => {
    const diamond = el({ type: "diamond", id: "D", x: 0, y: 0, width: 400, height: 180, index: "a1" });
    const { findings } = lintScene([diamond, label("D")]);
    const alternative = patchOf(findings.find((f) => f.code === "text_overflow")!.alternative);
    expect(alternative.id).toBe("T");
    expect(alternative.fontSize as number).toBeLessThan(20);
  });
});

describe("arrow_crosses_element", () => {
  const from = el({ type: "rectangle", id: "A", x: 0, y: 0, width: 60, height: 60 });
  const to = el({ type: "rectangle", id: "B", x: 400, y: 0, width: 60, height: 60 });
  const blocker = el({ type: "rectangle", id: "X", x: 200, y: 0, width: 60, height: 60 });
  const arrow = el({
    type: "arrow",
    id: "R",
    x: 60,
    y: 30,
    width: 340,
    height: 0,
    points: [[0, 0], [340, 0]],
    startBinding: { elementId: "A", fixedPoint: [1, 0.5001], mode: "orbit" },
    endBinding: { elementId: "B", fixedPoint: [0, 0.5001], mode: "orbit" },
  });
  const bound = (element: typeof from, arrowId: string) =>
    el({ ...element, boundElements: [{ id: arrowId, type: "arrow" }] });

  it("flags an arrow running through an unrelated shape", () => {
    const { findings } = lintScene([bound(from, "R"), bound(to, "R"), blocker, arrow]);
    const crossing = findings.find((f) => f.code === "arrow_crosses_element")!;
    expect(crossing.elementIds).toEqual(["R", "X"]);
  });

  it("does not flag the shapes the arrow is bound to", () => {
    const { findings } = lintScene([bound(from, "R"), bound(to, "R"), arrow]);
    expect(codes(findings)).not.toContain("arrow_crosses_element");
  });

  it("does not flag a cluster box that encloses the whole arrow", () => {
    const cluster = el({ type: "rectangle", id: "C", x: -50, y: -50, width: 600, height: 200 });
    const { findings } = lintScene([bound(from, "R"), bound(to, "R"), cluster, arrow]);
    expect(codes(findings)).not.toContain("arrow_crosses_element");
  });

  it("suggests waypoints whose re-planned path clears the obstacle", () => {
    const { findings } = lintScene([bound(from, "R"), bound(to, "R"), blocker, arrow]);
    const suggestion = findings.find((f) => f.code === "arrow_crosses_element")!.suggestion as unknown as {
      tool: string;
      args: { elements: Array<{ id: string; waypoints: [number, number][] }> };
    };
    expect(suggestion.tool).toBe("update_elements");
    const [patch] = suggestion.args.elements;
    expect(patch.id).toBe("R");
    const planned = planArrowPath(from, to, { waypoints: patch.waypoints });
    const path = planned.points.map(([px, py]) => [planned.x + px, planned.y + py] as [number, number]);
    for (let i = 0; i < path.length - 1; i++) {
      expect(segmentElementOverlap(blocker, path[i], path[i + 1])).toBe(0);
    }
  });

  it("is reported inline when the arrow is created", () => {
    const findings = lintElement(arrow, [bound(from, "R"), bound(to, "R"), blocker]);
    expect(findings.map((f) => f.code)).toContain("arrow_crosses_element");
  });

  it("is reported inline when a shape is dropped onto an existing arrow", () => {
    const findings = lintElement(blocker, [bound(from, "R"), bound(to, "R"), arrow]);
    expect(findings.map((f) => f.code)).toContain("arrow_crosses_element");
  });
});

describe("per-element lintIgnore", () => {
  it("silences one rule on one element without hiding it elsewhere", () => {
    const line = (id: string, customData?: Record<string, unknown>) =>
      el({
        type: "arrow",
        id,
        x: 0,
        y: 120,
        width: 40,
        height: 0,
        points: [[0, 0], [40, 0]],
        endArrowhead: "arrow",
        ...(customData ? { customData } : {}),
      });
    const target = el({ type: "rectangle", id: "S", x: 42, y: 100, width: 60, height: 40 });
    const quiet = line("quiet", { lintIgnore: ["arrow_unbound_endpoint"] });
    const loud = line("loud");

    const silenced = lintScene([target, quiet]);
    expect(codes(silenced.findings)).not.toContain("arrow_unbound_endpoint");

    const reported = lintScene([target, loud]);
    expect(codes(reported.findings)).toContain("arrow_unbound_endpoint");
  });

  it("drops an opted-out node from graph.isolated", () => {
    const legend = el({
      type: "rectangle",
      id: "L",
      customData: { lintIgnore: ["isolated"] },
    });
    const orphan = el({ type: "rectangle", id: "O", x: 500 });
    // isolated only counts where arrows exist at all.
    const a = el({ type: "rectangle", id: "A", x: 0, y: 400, width: 60, height: 60, boundElements: [{ id: "E", type: "arrow" }] });
    const b = el({ type: "rectangle", id: "B", x: 300, y: 400, width: 60, height: 60, boundElements: [{ id: "E", type: "arrow" }] });
    const edge = el({
      type: "arrow",
      id: "E",
      x: 65,
      y: 430,
      width: 230,
      height: 0,
      points: [[0, 0], [230, 0]],
      startBinding: { elementId: "A", fixedPoint: [1, 0.5001], mode: "orbit" },
      endBinding: { elementId: "B", fixedPoint: [0, 0.5001], mode: "orbit" },
    });
    const { graph } = lintScene([legend, orphan, a, b, edge]);
    expect(graph.isolated).toEqual(["O"]);
  });
});
