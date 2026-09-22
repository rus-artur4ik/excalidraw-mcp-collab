import {describe, expect, it} from "vitest";

import type {ExcalidrawElement} from "../../types";
import {findingKey, type LintFinding, lintScene} from "../lint";
import {lintCodesForProfile} from "../lintProfiles";
import {planArrowPath, reshapeArrowPath} from "../bindings";
import {globalLinearPoints, segmentElementOverlap} from "../geometry";
import {getLineWidth, measureText} from "../textMetrics";
import {el} from "./factory";

const codes = (findings: readonly LintFinding[]) => findings.map((f) => f.code);

const box = (id: string, x: number, y: number, width: number, height: number, extra: Partial<ExcalidrawElement> = {}) =>
  el({ type: "rectangle", id, x, y, width, height, ...extra });

const frame = (id: string, x: number, y: number, width: number, height: number, extra: Partial<ExcalidrawElement> = {}) =>
  el({ type: "frame", id, x, y, width, height, ...extra });

const label = (id: string, containerId: string, value: string, extra: Partial<ExcalidrawElement> = {}) =>
  el({ type: "text", id, containerId, text: value, originalText: value, fontSize: 20, fontFamily: 5, x: 0, y: 0, width: 10, height: 25, ...extra });

const text = (id: string, x: number, y: number, value: string, extra: Partial<ExcalidrawElement> = {}) =>
  el({ type: "text", id, x, y, text: value, originalText: value, fontSize: 20, fontFamily: 5, width: getLineWidth(value, 20, 5), height: 25, ...extra });

const withLabel = (container: ExcalidrawElement, labelId: string) =>
  ({ ...container, boundElements: [{ id: labelId, type: "text" }] }) as ExcalidrawElement;

const arrow = (id: string, points: [number, number][], extra: Partial<ExcalidrawElement> = {}) => {
  const [ox, oy] = points[0];
  const local = points.map(([x, y]) => [x - ox, y - oy]);
  return el({
    type: "arrow",
    id,
    x: ox,
    y: oy,
    width: Math.max(...local.map(([x]) => x)) - Math.min(...local.map(([x]) => x)),
    height: Math.max(...local.map(([, y]) => y)) - Math.min(...local.map(([, y]) => y)),
    points: local,
    startBinding: null,
    endBinding: null,
    startArrowhead: null,
    endArrowhead: "arrow",
    ...extra,
  });
};

// Applies update_elements patches the way a plain field write would.
const applyUpdate = (elements: ExcalidrawElement[], finding: LintFinding): ExcalidrawElement[] => {
  const suggestion = finding.suggestion as unknown as { tool: string; args: { elements: Array<{ id: string } & Record<string, unknown>> } };
  expect(suggestion.tool).toBe("update_elements");
  const patches = new Map(suggestion.args.elements.map((patch) => [patch.id, patch]));
  return elements.map((element) => ({ ...element, ...(patches.get(element.id) ?? {}) }) as ExcalidrawElement);
};

describe("profiles and coverage", () => {
  const scene = () => [box("a", 0, 0, 100, 100), box("b", 300, 0, 100, 100)];

  it("lists every evaluated code, per profile", () => {
    const base = lintScene(scene()).summary.coverage;
    const qa = lintScene(scene(), { profile: "visual-qa" }).summary.coverage;
    const integrity = lintScene(scene(), { profile: "integrity" }).summary.coverage;
    expect(base).toContain("overlap");
    expect(base).not.toContain("text_bad_break");
    expect(qa).toEqual(expect.arrayContaining([...base, "text_bad_break", "gap_irregular", "arrow_crosses_arrow"]));
    expect(integrity).toContain("binding_backref_stale");
    expect(integrity).not.toContain("overlap");
    expect(integrity.every((code) => lintCodesForProfile("integrity").includes(code as never))).toBe(true);
  });

  it("evaluates not_persisted only when the stored scene is given", () => {
    const live = [box("kept", 0, 0, 50, 50, { version: 3 }), box("lost", 100, 0, 50, 50), box("stale", 200, 0, 50, 50, { version: 2 })];
    expect(lintScene(live).summary.coverage).not.toContain("not_persisted");
    const stored = [
      { ...live[0] },
      { ...live[1], isDeleted: true, version: 9 },
      { ...live[2], version: 5 },
    ] as ExcalidrawElement[];
    const result = lintScene(live, { stored, codes: ["not_persisted"] });
    expect(result.summary.coverage).toEqual(["not_persisted"]);
    expect(result.findings.map((f) => f.elementIds[0]).sort()).toEqual(["lost", "stale"]);
  });

  it("codes selects rules from any profile, old names included", () => {
    const result = lintScene(scene(), { codes: ["gap_irregular", "arrow_dangling_binding"] });
    expect(result.summary.coverage).toEqual(["binding_target_missing", "gap_irregular"]);
  });

  it("disabledRules accepts the old name of a renamed rule", () => {
    const dangling = arrow("a", [[0, 0], [100, 0]], { startBinding: { elementId: "gone", fixedPoint: [1, 0.5], mode: "orbit" } });
    const result = lintScene([dangling], { disabledRules: ["arrow_dangling_binding"] });
    expect(result.summary.coverage).not.toContain("binding_target_missing");
    expect(codes(result.findings)).not.toContain("binding_target_missing");
  });

  it("skips pairwise rules on huge unscoped scenes but runs them when scoped", () => {
    const many = Array.from({ length: 1600 }, (_, i) => box(`r${i}`, (i % 40) * 150, Math.floor(i / 40) * 150, 100, 100));
    many.push(box("hit", 30, 30, 100, 100));
    const full = lintScene(many);
    expect(full.summary.coverage).not.toContain("overlap");
    const notice = full.findings.find((f) => f.code === "scene_too_large")!;
    expect(notice.suggestion).toHaveProperty("reason");
    const scoped = lintScene(many, { ids: ["hit"] });
    expect(scoped.summary.coverage).toContain("overlap");
    expect(codes(scoped.findings)).toContain("overlap");
  });
});

describe("lintIgnore", () => {
  const overlapping = (extraA: Partial<ExcalidrawElement> = {}, extraB: Partial<ExcalidrawElement> = {}) => [
    box("a", 0, 0, 100, 100, extraA),
    box("b", 50, 0, 100, 100, extraB),
  ];

  it("on a frame applies to its children", () => {
    const f = frame("F", -20, -20, 400, 200, { customData: { lintIgnore: ["overlap"] } });
    const result = lintScene([f, ...overlapping({ frameId: "F" }, { frameId: "F" })]);
    expect(codes(result.findings)).not.toContain("overlap");
    expect(result.summary.suppressedBroadly).toBeGreaterThan(0);
  });

  it("on one group member applies to the other members", () => {
    const opted = box("opted", 500, 500, 10, 10, { groupIds: ["g"], customData: { lintIgnore: ["overlap"] } });
    const result = lintScene([opted, ...overlapping({ groupIds: ["g"] })]);
    expect(codes(result.findings)).not.toContain("overlap");
  });

  it("{code, with} only hides findings that involve one of `with`", () => {
    const scene = [
      box("a", 0, 0, 100, 100, { customData: { lintIgnore: [{ code: "overlap", with: ["b"] }] } }),
      box("b", 50, 0, 100, 100),
      box("c", 0, 60, 100, 100),
    ];
    const result = lintScene(scene);
    const overlaps = result.findings.filter((f) => f.code === "overlap").map((f) => [...f.elementIds].sort().join("+"));
    expect(overlaps).not.toContain("a+b");
    expect(overlaps).toContain("a+c");
    expect(result.summary.suppressedBroadly).toBe(0);
  });
});

describe("kinds", () => {
  it("full nesting in a filled box or a structural kind is not an overlap", () => {
    const node = box("n", 50, 50, 100, 60);
    expect(codes(lintScene([box("bg", 0, 0, 400, 300, { backgroundColor: "#e9ecef" }), node]).findings)).not.toContain("overlap");
    expect(codes(lintScene([box("lane", 0, 0, 400, 300, { customData: { kind: "lane" } }), node]).findings)).not.toContain("overlap");
    expect(codes(lintScene([box("plain", 0, 0, 400, 300), node]).findings)).toContain("overlap");
  });

  it("a partial overlap with a lane is still an overlap", () => {
    const lane = box("lane", 0, 0, 400, 100, { customData: { kind: "lane" } });
    expect(codes(lintScene([lane, box("n", 350, 50, 100, 60)]).findings)).toContain("overlap");
  });

  it("table cells never overlap-check", () => {
    const cell = { customData: { kind: "table-cell", table: { tableId: "T", row: "r", col: "c" } } };
    expect(codes(lintScene([box("c1", 0, 0, 100, 40, cell), box("x", 50, 10, 100, 40)]).findings)).not.toContain("overlap");
  });

  it("isolated counts only real nodes in frames that hold arrows", () => {
    const a = box("A", 0, 0, 60, 60, { frameId: "F", boundElements: [{ id: "E", type: "arrow" }] });
    const b = box("B", 200, 0, 60, 60, { frameId: "F", boundElements: [{ id: "E", type: "arrow" }] });
    const edge = arrow("E", [[65, 30], [195, 30]], {
      frameId: "F",
      startBinding: { elementId: "A", fixedPoint: [1, 0.5001], mode: "orbit" },
      endBinding: { elementId: "B", fixedPoint: [0, 0.5001], mode: "orbit" },
    });
    const lonely = box("lonely", 0, 200, 60, 60, { frameId: "F" });
    const legend = box("legend", 100, 200, 60, 60, { frameId: "F", customData: { kind: "legend" } });
    const noteRole = box("note", 200, 200, 60, 60, { frameId: "F", customData: { role: "note" } });
    const elsewhere = box("elsewhere", 1000, 0, 60, 60, { frameId: "G" });
    const scene = [frame("F", -20, -20, 400, 400), frame("G", 980, -20, 200, 200), a, b, edge, lonely, legend, noteRole, elsewhere];
    expect(lintScene(scene).graph.isolated).toEqual(["lonely"]);
  });

  it("dividers get no arrow rules", () => {
    const shape = box("s", 100, 0, 100, 100);
    const divider = arrow("d", [[0, 50], [99, 50]], { type: "line", customData: { kind: "divider" } });
    const through = arrow("t", [[0, 50], [400, 50]], { customData: { kind: "divider" } });
    const found = codes(lintScene([shape, divider, through]).findings);
    expect(found.filter((code) => code.startsWith("arrow"))).toEqual([]);
  });
});

describe("text_overflow tight vs overflow", () => {
  // One line of "Short" plus 6px above and below: fits, but under minPadding 8.
  const snug = Math.ceil(measureText("Short", 20, 5).height) + 12;
  const scene = (height: number, extra: Partial<ExcalidrawElement> = {}) => [
    withLabel(box("c", 0, 0, 200, height, { backgroundColor: "#a5d8ff" }), "t"),
    label("t", "c", "Short", extra),
  ];

  it("reports tight (warning) when a side keeps less than minPadding", () => {
    const tight = lintScene(scene(snug)).findings.find((f) => f.code === "text_overflow")!;
    expect(tight.kind).toBe("tight");
    expect(tight.severity).toBe("warning");
    expect(codes(lintScene(scene(snug), { minPadding: 2 }).findings)).not.toContain("text_overflow");
    expect(codes(lintScene(scene(80)).findings)).not.toContain("text_overflow");
  });

  it("the tight suggestion clears the finding", () => {
    const elements = scene(snug);
    const tight = lintScene(elements).findings.find((f) => f.code === "text_overflow")!;
    expect(codes(lintScene(applyUpdate(elements, tight)).findings)).not.toContain("text_overflow");
  });

  it("the overflow suggestion fits the label with padding to spare", () => {
    const elements = [
      withLabel(box("c", 0, 0, 60, 30, { backgroundColor: "#a5d8ff" }), "t"),
      label("t", "c", "a label that is much too long for this box"),
    ];
    const overflow = lintScene(elements).findings.find((f) => f.code === "text_overflow")!;
    expect(overflow.kind).toBe("overflow");
    expect(overflow.severity).toBe("error");
    expect(codes(lintScene(applyUpdate(elements, overflow)).findings)).not.toContain("text_overflow");
  });

  it("does not call the anchored side or an invisible box tight", () => {
    expect(codes(lintScene(scene(80, { textAlign: "left" })).findings)).not.toContain("text_overflow");
    const invisible = [withLabel(box("c", 0, 0, 200, snug, { strokeColor: "transparent" }), "t"), label("t", "c", "Short")];
    expect(codes(lintScene(invisible).findings)).not.toContain("text_overflow");
  });
});

describe("text_outside_frame", () => {
  it("gives every outside child of a frame the same grown-frame patch, which clears them all", () => {
    const elements = [
      frame("F", 0, 0, 300, 200),
      box("right", 250, 20, 100, 40, { frameId: "F" }),
      text("below", 20, 190, "Caption", { frameId: "F" }),
      box("inside", 20, 20, 100, 40, { frameId: "F" }),
    ];
    const outside = lintScene(elements).findings.filter((f) => f.code === "text_outside_frame");
    expect(outside.map((f) => f.elementIds[0]).sort()).toEqual(["below", "right"]);
    expect(outside[0].suggestion).toEqual(outside[1].suggestion);
    expect(codes(lintScene(applyUpdate(elements, outside[0])).findings)).not.toContain("text_outside_frame");
  });

  it("reports a label that spills out of the frame through its container", () => {
    const elements = [
      frame("F", 0, 0, 200, 100),
      withLabel(box("c", 100, 20, 90, 60, { frameId: "F" }), "t"),
      label("t", "c", "Averyveryverylongunbreakableword", { frameId: "F" }),
    ];
    const outside = lintScene(elements).findings.find((f) => f.code === "text_outside_frame")!;
    expect(outside.elementIds).toEqual(["t", "c", "F"]);
  });
});

describe("empty_text", () => {
  it("never suggests deleting an emptied label", () => {
    const recoverable = [withLabel(box("c", 0, 0, 100, 60), "t"), label("t", "c", "", { originalText: "Payments" })];
    const withText = lintScene(recoverable).findings.find((f) => f.code === "empty_text")!;
    expect(withText.suggestion).toMatchObject({ tool: "update_elements", args: { elements: [{ id: "c", label: "Payments" }] } });

    const lost = [withLabel(box("c", 0, 0, 100, 60), "t"), label("t", "c", "", { originalText: "" })];
    const withoutText = lintScene(lost).findings.find((f) => f.code === "empty_text")!;
    expect(withoutText.suggestion).toHaveProperty("reason");
  });
});

describe("integrity", () => {
  it("flags a boundElements text entry whose text belongs elsewhere as stale", () => {
    const elements = [
      box("c", 0, 0, 100, 60, { boundElements: [{ id: "t", type: "text" }] }),
      withLabel(box("d", 200, 0, 100, 60), "t"),
      label("t", "d", "mine"),
    ];
    const stale = lintScene(elements).findings.filter((f) => f.code === "binding_backref_stale");
    expect(stale.map((f) => f.elementIds)).toEqual([["c", "t"]]);
  });

  it("treats a frameId that points to a non-frame as frame_missing", () => {
    expect(codes(lintScene([box("r", 0, 0, 10, 10), box("x", 50, 50, 10, 10, { frameId: "r" })]).findings)).toContain("frame_missing");
  });

  it("stays clean on a correctly bound label and arrow", () => {
    const elements = [
      withLabel(box("a", 0, 0, 120, 60), "a:label"),
      label("a:label", "a", "A", { index: "b1" }),
      box("b", 300, 0, 120, 60),
      arrow("e", [[125, 30], [295, 30]], {
        startBinding: { elementId: "a", fixedPoint: [1, 0.5001], mode: "orbit" },
        endBinding: { elementId: "b", fixedPoint: [0, 0.5001], mode: "orbit" },
      }),
    ];
    elements[0] = { ...elements[0], boundElements: [{ id: "a:label", type: "text" }, { id: "e", type: "arrow" }] } as ExcalidrawElement;
    elements[2] = { ...elements[2], boundElements: [{ id: "e", type: "arrow" }] } as ExcalidrawElement;
    expect(lintScene(elements, { profile: "integrity" }).findings).toEqual([]);
  });
});

describe("arrow rules", () => {
  it("checks unbound ends only where there is an arrowhead, and never on lines", () => {
    const target = box("r", 0, 0, 100, 60);
    const headless = arrow("h", [[200, 30], [101, 30]], { endArrowhead: null });
    const line = arrow("l", [[200, 40], [101, 40]], { type: "line", endArrowhead: null });
    const headed = arrow("a", [[200, 50], [101, 50]]);
    const found = lintScene([target, headless, line, headed]).findings.filter((f) => f.code === "arrow_unbound_endpoint");
    expect(found.map((f) => f.elementIds[0])).toEqual(["a"]);
  });

  it("reports an endpoint deep inside a shape once, not also as unbound", () => {
    const found = codes(lintScene([box("r", 0, 0, 200, 100), arrow("a", [[300, 50], [100, 50]])]).findings);
    expect(found).toContain("arrow_endpoint_inside_node");
    expect(found).not.toContain("arrow_unbound_endpoint");
  });

  it("does not flag an arrow for crossing its own label, nor double-report a crossed container's label", () => {
    const elements = [
      arrow("a", [[0, 50], [400, 50]], { boundElements: [{ id: "own", type: "text" }] }),
      label("own", "a", "own"),
      withLabel(box("x", 150, 20, 100, 60), "xl"),
      label("xl", "x", "X"),
    ];
    const found = lintScene(elements).findings;
    expect(codes(found)).toContain("arrow_crosses_element");
    expect(found.filter((f) => f.code === "arrow_crosses_text")).toEqual([]);
  });

  it("picks a detour that clears every shape when one exists", () => {
    const from = box("A", 0, 0, 60, 60, { boundElements: [{ id: "R", type: "arrow" }] });
    const to = box("B", 400, 0, 60, 60, { boundElements: [{ id: "R", type: "arrow" }] });
    const blocker = box("X", 200, 0, 60, 60);
    const above = box("Y", 180, -110, 100, 60);
    const route = arrow("R", [[65, 30], [395, 30]], {
      startBinding: { elementId: "A", fixedPoint: [1, 0.5001], mode: "orbit" },
      endBinding: { elementId: "B", fixedPoint: [0, 0.5001], mode: "orbit" },
    });
    const crossing = lintScene([from, to, blocker, above, route]).findings.find((f) => f.code === "arrow_crosses_element")!;
    const patch = (crossing.suggestion as unknown as { args: { elements: Array<{ waypoints: [number, number][] }> } }).args.elements[0];
    const plan = planArrowPath(from, to, { waypoints: patch.waypoints });
    const path = plan.points.map(([px, py]) => [plan.x + px, plan.y + py] as [number, number]);
    for (const obstacle of [blocker, above]) {
      for (let i = 0; i < path.length - 1; i++) {
        expect(segmentElementOverlap(obstacle, path[i], path[i + 1])).toBe(0);
      }
    }
    expect(crossing.suggestion).toMatchObject({ risk: "safe" });
  });

  it("the degenerate-segment suggestion removes the stub", () => {
    const stub = arrow("a", [[0, 0], [100, 0], [103, 0], [103, 100]]);
    const finding = lintScene([stub]).findings.find((f) => f.code === "arrow_degenerate_segment")!;
    const { waypoints } = (finding.suggestion as unknown as { args: { elements: Array<{ waypoints: [number, number][] }> } }).args.elements[0];
    const reshaped = { ...stub, ...reshapeArrowPath(stub, { waypoints }) } as ExcalidrawElement;
    expect(globalLinearPoints(reshaped)).toHaveLength(3);
    expect(codes(lintScene([reshaped]).findings)).not.toContain("arrow_degenerate_segment");
  });

  it("spreads converging arrowheads with distinct anchors", () => {
    const target = box("T", 200, 0, 100, 100, { boundElements: [{ id: "a1", type: "arrow" }, { id: "a2", type: "arrow" }, { id: "a3", type: "arrow" }] });
    const bound = (id: string, y: number) =>
      arrow(id, [[0, y * 2], [195, y]], { endBinding: { elementId: "T", fixedPoint: [0, y / 100], mode: "orbit" } });
    const finding = lintScene([target, bound("a1", 40), bound("a2", 46), bound("a3", 90)]).findings.find((f) => f.code === "arrowheads_converge")!;
    const anchors = (finding.suggestion as unknown as { args: { elements: Array<{ endAnchor: { side: string; at: number } }> } }).args.elements.map((p) => p.endAnchor);
    expect(anchors.every((anchor) => anchor.side === "left")).toBe(true);
    expect(new Set(anchors.map((anchor) => anchor.at)).size).toBe(3);
  });

  it("offers to bind a free text grouped with exactly one arrow", () => {
    const edge = arrow("a", [[0, 0], [200, 0]], { groupIds: ["g"] });
    const caption = text("cap", 80, 10, "calls", { groupIds: ["g"] });
    const finding = lintScene([edge, caption]).findings.find((f) => f.code === "arrow_label_far")!;
    expect(finding.kind).toBe("free");
    expect(finding.suggestion).toMatchObject({ tool: "update_elements", args: { elements: [{ id: "cap", containerId: "a" }] } });
    const second = arrow("b", [[0, 30], [200, 30]], { groupIds: ["g"] });
    expect(codes(lintScene([edge, second, caption]).findings)).not.toContain("arrow_label_far");
  });
});

describe("alignment_near_miss", () => {
  it("compares the aligned edge of left-aligned text, not its center", () => {
    const inFrame = { frameId: "F", textAlign: "left" };
    const f = frame("F", -50, -50, 600, 400);
    const same = [f, text("a", 0, 0, "short", inFrame), text("b", 0, 100, "a much longer line", inFrame)];
    expect(codes(lintScene(same).findings)).not.toContain("alignment_near_miss");
    const off = [f, text("a", 0, 0, "short", inFrame), text("b", 2, 100, "a much longer line", inFrame)];
    const finding = lintScene(off).findings.find((x) => x.code === "alignment_near_miss")!;
    expect(finding.kind).toBe("left");
  });

  it("reports a whole row once with one combined patch", () => {
    const row = [0, 2, 3].map((y, i) => box(`r${i}`, i * 200, y, 100, 50, { groupIds: ["g"] }));
    const found = lintScene(row).findings.filter((f) => f.code === "alignment_near_miss");
    expect(found).toHaveLength(1);
    expect(found[0].elementIds).toEqual(["r0", "r1", "r2"]);
    const fixed = applyUpdate(row, found[0]);
    expect(new Set(fixed.map((e) => e.y)).size).toBe(1);
  });
});

describe("style_off_palette_color", () => {
  it("tolerates role colors, black, white and the canvas color", () => {
    const elements = [
      box("role", 0, 0, 100, 60, { strokeColor: "#1971c2", backgroundColor: "#a5d8ff" }),
      box("mono", 200, 0, 100, 60, { strokeColor: "#000000", backgroundColor: "#ffffff" }),
      box("canvas", 400, 0, 100, 60, { backgroundColor: "#fdf6e3" }),
    ];
    expect(codes(lintScene(elements, { viewBackgroundColor: "#fdf6e3" }).findings)).not.toContain("style_off_palette_color");
  });
});

describe("scoped runs", () => {
  // A small board with a bit of everything; scoping must not lose findings.
  const board = (): ExcalidrawElement[] => [
    frame("F", 0, 0, 600, 300),
    withLabel(box("a", 20, 20, 60, 30, { frameId: "F", backgroundColor: "#a5d8ff" }), "a:label"),
    label("a:label", "a", "A long label here", { frameId: "F" }),
    box("b", 60, 30, 100, 60, { frameId: "F" }),
    box("c", 300, 22, 100, 60, { frameId: "F", groupIds: ["g"] }),
    box("d", 450, 20, 100, 60, { frameId: "F", groupIds: ["g"] }),
    box("x", 560, 200, 100, 60, { frameId: "F" }),
    arrow("e", [[0, 150], [700, 150]]),
    text("t", 250, 140, "crossed text"),
    box("far", 9000, 9000, 10, 10),
    box("zz", 0, 0, 0, 10),
  ];
  // Findings whose id list is itself narrowed to the scope by design.
  const scopedById = new Set(["style_off_palette_color", "style_many_fonts"]);

  it.each([["a"], ["b"], ["e"], ["t"], ["x", "F"], ["c"]])("ids %s gives the full run's findings that touch them", (...ids) => {
    const scope = new Set(ids);
    const full = lintScene(board(), { profile: "visual-qa" })
      .findings.filter((f) => f.elementIds.some((id) => scope.has(id)) && !scopedById.has(f.code))
      .map(findingKey)
      .sort();
    const scoped = lintScene(board(), { profile: "visual-qa", ids })
      .findings.filter((f) => !scopedById.has(f.code))
      .map(findingKey)
      .sort();
    expect(scoped).toEqual(full);
    expect(full.length).toBeGreaterThan(0);
  });

  it("findingKey ignores id order but not kind", () => {
    const base = { code: "x", severity: "info" as const, message: "", elementIds: ["b", "a"] };
    expect(findingKey(base)).toBe(findingKey({ ...base, elementIds: ["a", "b"] }));
    expect(findingKey(base)).not.toBe(findingKey({ ...base, kind: "tight" }));
  });
});

describe("tables", () => {
  const cell = (row: string, col: string) => ({ customData: { kind: "table-cell", table: { tableId: "T", row, col } } });

  it("finds header cells through a header band part", () => {
    const band = box("band", 0, 0, 300, 40, { backgroundColor: "#e9ecef", customData: { table: { tableId: "T", part: "header" } } });
    const elements = [
      band,
      withLabel(box("h1", 0, 0, 150, 40, cell("0", "a")), "h1t"),
      label("h1t", "h1", "One", { fontSize: 16 }),
      withLabel(box("h2", 150, 0, 150, 40, cell("0", "b")), "h2t"),
      label("h2t", "h2", "Two", { fontSize: 20 }),
    ];
    const mismatch = lintScene(elements).findings.find((f) => f.code === "table_header_style_mismatch")!;
    expect(mismatch.kind).toBe("fontSize");
  });

  it("the row-height suggestion evens the row", () => {
    const elements = [box("c1", 0, 0, 100, 40, cell("r", "a")), box("c2", 100, 0, 100, 60, cell("r", "b"))];
    const finding = lintScene(elements).findings.find((f) => f.code === "table_row_height_inconsistent")!;
    expect(codes(lintScene(applyUpdate(elements, finding)).findings)).not.toContain("table_row_height_inconsistent");
  });
});

describe("typography (visual-qa)", () => {
  it("flags a one-word last line and a mid-word split, and the width fix clears them", () => {
    const widowWidth = Math.ceil(getLineWidth("alpha beta gamma", 20, 5)) + 1;
    const widow = text("w", 0, 0, "alpha beta gamma end", { autoResize: false, width: widowWidth, height: 60 });
    const found = lintScene([widow], { profile: "visual-qa" }).findings.find((f) => f.code === "text_bad_break")!;
    expect(found.kind).toBe("widow");
    expect(codes(lintScene(applyUpdate([widow], found), { profile: "visual-qa" }).findings)).not.toContain("text_bad_break");

    const splitWidth = Math.ceil(getLineWidth("abcdef", 20, 5));
    const split = text("s", 0, 0, "abcdefghijkl", { autoResize: false, width: splitWidth, height: 60 });
    const midWord = lintScene([split], { profile: "visual-qa" }).findings.find((f) => f.code === "text_bad_break")!;
    expect(midWord.kind).toBe("mid_word");
  });
});
