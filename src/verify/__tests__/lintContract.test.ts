import {describe, expect, it} from "vitest";

import type {ExcalidrawElement} from "../../types";
import type {BoardProfile} from "../../profile";
import {SUGGESTION_TOOL_SCHEMAS, type SuggestionTool} from "../../toolSchemas";
import {type LintFinding, type LintScopeOptions, lintScene} from "../lint";
import {LINT_RULE_CODES, type LintRuleCode} from "../lintProfiles";
import {getLineWidth} from "../textMetrics";
import {el} from "./factory";

type Fixture = { elements: ExcalidrawElement[]; options?: LintScopeOptions };

const arrow = (
  id: string,
  points: [number, number][],
  extra: Partial<ExcalidrawElement> = {},
): ExcalidrawElement => {
  const [ox, oy] = points[0];
  const local = points.map(([x, y]) => [x - ox, y - oy]);
  const xs = local.map(([x]) => x);
  const ys = local.map(([, y]) => y);
  return el({
    type: "arrow",
    id,
    x: ox,
    y: oy,
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
    points: local,
    startBinding: null,
    endBinding: null,
    startArrowhead: null,
    endArrowhead: "arrow",
    ...extra,
  });
};

const box = (id: string, x: number, y: number, width: number, height: number, extra: Partial<ExcalidrawElement> = {}) =>
  el({ type: "rectangle", id, x, y, width, height, ...extra });

const label = (id: string, containerId: string, text: string, extra: Partial<ExcalidrawElement> = {}) =>
  el({ type: "text", id, containerId, text, originalText: text, fontSize: 20, fontFamily: 5, x: 0, y: 0, width: 10, height: 25, ...extra });

const text = (id: string, x: number, y: number, value: string, extra: Partial<ExcalidrawElement> = {}) =>
  el({ type: "text", id, x, y, text: value, originalText: value, fontSize: 20, fontFamily: 5, width: 10 * value.length, height: 25, ...extra });

const withLabel = (container: ExcalidrawElement, labelId: string) => ({
  ...container,
  boundElements: [...(container.boundElements ?? []), { id: labelId, type: "text" }],
}) as ExcalidrawElement;

const cell = (tableId: string, row: string, col: string) => ({ customData: { kind: "table-cell", table: { tableId, row, col } } });

// Enough of a board profile for the needsProfile rules; each fixture below
// passes the part it exercises.
const boardProfile = (extra: BoardProfile = {}): BoardProfile => ({
  typeScale: { colHeader: 20, body: 16, caption: 14 },
  ...extra,
});

// One small scene per rule code. Kept here (not in the rule tests) so adding
// a rule without a contract fixture fails the "every code" test below.
const FIXTURES: Record<LintRuleCode, () => Fixture> = {
  degenerate_size: () => ({ elements: [box("r", 0, 0, 0, 50)] }),
  empty_text: () => ({ elements: [text("t", 0, 0, "   ")] }),
  invisible_opacity: () => ({ elements: [box("r", 0, 0, 50, 50, { opacity: 0 })] }),
  out_of_range: () => ({ elements: [box("r", 0, 0, 50, 50, { roughness: 9 })] }),
  invalid_enum: () => ({ elements: [box("r", 0, 0, 50, 50, { fillStyle: "plaid" })] }),
  text_overflow: () => ({
    elements: [withLabel(box("c", 0, 0, 40, 24), "t"), label("t", "c", "this is a very long label that cannot fit")],
  }),
  text_outside_frame: () => ({
    elements: [el({ type: "frame", id: "F", x: 0, y: 0, width: 200, height: 100 }), box("r", 150, 20, 100, 40, { frameId: "F" })],
  }),
  text_original_mismatch: () => ({
    elements: [withLabel(box("c", 0, 0, 200, 80), "t"), label("t", "c", "Hello world", { originalText: "Goodbye" })],
  }),
  bound_text_below_container: () => ({
    elements: [label("t", "c", "hi", { index: "a1" }), withLabel(box("c", 0, 0, 200, 80, { index: "a5" }), "t")],
  }),
  orphan_bound_text: () => ({ elements: [label("t", "gone", "hi")] }),
  binding_invalid: () => ({
    elements: [box("r", 0, 0, 100, 60, { boundElements: [{ id: "a", type: "arrow" }] }), arrow("a", [[105, 30], [200, 30]], { startBinding: { elementId: "r" } })],
  }),
  binding_target_missing: () => ({
    elements: [arrow("a", [[0, 0], [100, 0]], { startBinding: { elementId: "missing", fixedPoint: [1, 0.5], mode: "orbit" } })],
  }),
  binding_backref_missing: () => ({
    elements: [box("r", 0, 0, 100, 60), arrow("a", [[105, 30], [200, 30]], { startBinding: { elementId: "r", fixedPoint: [1, 0.5001], mode: "orbit" } })],
  }),
  binding_backref_stale: () => ({ elements: [box("r", 0, 0, 100, 60, { boundElements: [{ id: "ghost", type: "arrow" }] })] }),
  frame_missing: () => ({ elements: [box("r", 0, 0, 100, 60, { frameId: "nof" })] }),
  frame_membership_mismatch: () => ({
    elements: [
      el({ type: "frame", id: "F", x: 0, y: 0, width: 400, height: 300 }),
      withLabel(box("c", 20, 20, 200, 80, { frameId: "F" }), "t"),
      label("t", "c", "hi", { frameId: null }),
    ],
  }),
  not_persisted: () => ({ elements: [box("r", 0, 0, 100, 60)], options: { stored: [] } }),
  arrow_zero_length: () => ({ elements: [arrow("a", [[0, 0], [0, 0]])] }),
  arrow_degenerate_segment: () => ({ elements: [arrow("a", [[0, 0], [100, 0], [103, 0], [103, 100]])] }),
  arrow_unbound_endpoint: () => ({ elements: [box("r", 0, 0, 100, 60), arrow("a", [[200, 30], [101, 30]])] }),
  arrow_endpoint_inside_node: () => ({ elements: [box("r", 0, 0, 200, 100), arrow("a", [[300, 50], [100, 50]])] }),
  arrow_crosses_element: () => ({
    elements: [
      box("A", 0, 0, 60, 60, { boundElements: [{ id: "R", type: "arrow" }] }),
      box("B", 400, 0, 60, 60, { boundElements: [{ id: "R", type: "arrow" }] }),
      box("X", 200, 0, 60, 60),
      arrow("R", [[65, 30], [395, 30]], {
        startBinding: { elementId: "A", fixedPoint: [1, 0.5001], mode: "orbit" },
        endBinding: { elementId: "B", fixedPoint: [0, 0.5001], mode: "orbit" },
      }),
    ],
  }),
  arrow_crosses_text: () => ({
    elements: [arrow("a", [[0, 50], [400, 50]]), withLabel(box("c", 150, 0, 100, 30, { strokeColor: "transparent" }), "t"), label("t", "c", "Title", { fontSize: 16 }), text("n", 150, 40, "Some note")],
  }),
  arrowheads_converge: () => ({
    elements: [
      box("T", 200, 0, 100, 100, { boundElements: [{ id: "a1", type: "arrow" }, { id: "a2", type: "arrow" }] }),
      arrow("a1", [[0, 0], [195, 40]], { endBinding: { elementId: "T", fixedPoint: [0, 0.4], mode: "orbit" } }),
      arrow("a2", [[0, 100], [195, 48]], { endBinding: { elementId: "T", fixedPoint: [0, 0.48], mode: "orbit" } }),
    ],
  }),
  arrow_label_far: () => ({
    elements: [
      arrow("a", [[0, 0], [200, 0]], { boundElements: [{ id: "t", type: "text" }] }),
      label("t", "a", "far away", { x: 50, y: 100, width: 80, height: 25 }),
    ],
  }),
  arrow_labels_collide: () => ({
    elements: [
      arrow("a1", [[0, 50], [200, 50]], { boundElements: [{ id: "t1", type: "text" }] }),
      arrow("a2", [[100, -100], [100, 200]], { boundElements: [{ id: "t2", type: "text" }] }),
      label("t1", "a1", "one"),
      label("t2", "a2", "two"),
    ],
  }),
  arrow_grazes_element: () => ({
    elements: [box("r", 100, 0, 100, 100), arrow("a", [[0, -4], [300, -4]])],
    options: { profile: "visual-qa" },
  }),
  arrow_crosses_arrow: () => ({
    elements: [arrow("a1", [[0, 0], [100, 100]]), arrow("a2", [[0, 100], [100, 0]])],
    options: { profile: "visual-qa" },
  }),
  arrow_diagonal_segment: () => ({
    elements: [arrow("a", [[0, 0], [100, 0], [150, 60], [150, 160]])],
    options: { profile: "visual-qa" },
  }),
  overlap: () => ({ elements: [box("a", 0, 0, 100, 100), box("b", 50, 0, 100, 100)] }),
  duplicate: () => ({ elements: [box("a", 0, 0, 100, 100), box("b", 0.5, 0, 100, 100)] }),
  occlusion: () => ({
    elements: [box("u", 50, 50, 20, 20), box("c", 0, 0, 200, 200, { backgroundColor: "#ffd43b", fillStyle: "solid" })],
  }),
  alignment_near_miss: () => ({
    elements: [box("a", 0, 0, 100, 50, { groupIds: ["g"] }), box("b", 2, 200, 100, 50, { groupIds: ["g"] })],
  }),
  off_canvas_outlier: () => ({
    elements: [box("a", 0, 0, 50, 50), box("b", 100, 0, 50, 50), box("c", 0, 100, 50, 50), box("far", 20000, 0, 50, 50)],
  }),
  low_contrast: () => ({ elements: [text("t", 0, 0, "pale", { strokeColor: "#f1f3f5" })] }),
  style_many_fonts: () => ({
    elements: [text("a", 0, 0, "one", { fontFamily: 1 }), text("b", 0, 50, "two", { fontFamily: 3 }), text("c", 0, 100, "three", { fontFamily: 6 })],
  }),
  style_off_palette_color: () => ({ elements: [box("r", 0, 0, 100, 60, { strokeColor: "#123456" })] }),
  table_column_without_header: () => ({
    elements: [
      withLabel(box("h_a", 0, 0, 100, 40, cell("T", "header", "a")), "h_a_t"),
      label("h_a_t", "h_a", "Name", { fontSize: 16 }),
      withLabel(box("r1_a", 0, 40, 100, 40, cell("T", "r1", "a")), "r1_a_t"),
      label("r1_a_t", "r1_a", "x", { fontSize: 16 }),
      withLabel(box("r1_b", 100, 40, 100, 40, cell("T", "r1", "b")), "r1_b_t"),
      label("r1_b_t", "r1_b", "y", { fontSize: 16 }),
    ],
  }),
  table_cell_overflow: () => ({
    elements: [withLabel(box("c", 0, 0, 60, 30, cell("T", "r1", "a")), "t"), label("t", "c", "a much longer cell text than fits")],
  }),
  table_row_height_inconsistent: () => ({
    elements: [box("c1", 0, 0, 100, 40, cell("T", "r1", "a")), box("c2", 100, 0, 100, 60, cell("T", "r1", "b"))],
  }),
  table_header_style_mismatch: () => ({
    elements: [
      withLabel(box("h1", 0, 0, 150, 40, cell("T", "header", "a")), "h1_t"),
      label("h1_t", "h1", "One", { fontSize: 16 }),
      withLabel(box("h2", 150, 0, 150, 40, cell("T", "header", "b")), "h2_t"),
      label("h2_t", "h2", "Two", { fontSize: 20 }),
    ],
  }),
  table_too_dense: () => ({
    elements: [
      text("c1", 0, 0, "Alpha", { width: getLineWidth("Alpha", 20, 5), customData: { table: { tableId: "T", row: "r1", col: "a" } } }),
      text("c2", getLineWidth("Alpha", 20, 5) + 2, 0, "Beta", { width: getLineWidth("Beta", 20, 5), customData: { table: { tableId: "T", row: "r1", col: "b" } } }),
    ],
  }),
  text_bad_break: () => {
    const width = Math.ceil(getLineWidth("aaaa bbbb", 20, 5)) + 2;
    return {
      elements: [text("t", 0, 0, "aaaa bbbb — cccc", { autoResize: false, width, height: 60 })],
      options: { profile: "visual-qa" },
    };
  },
  frame_padding_asymmetric: () => ({
    elements: [el({ type: "frame", id: "F", x: 0, y: 0, width: 400, height: 140 }), box("r", 20, 20, 100, 100, { frameId: "F" })],
    options: { profile: "visual-qa" },
  }),
  gap_irregular: () => ({
    elements: [0, 70, 140, 240].map((y, i) => box(`r${i}`, 0, y, 100, 50, { groupIds: ["g"] })),
    options: { profile: "visual-qa" },
  }),
  style_font_size_outlier: () => ({
    elements: [20, 20, 20, 16].map((fontSize, i) => text(`t${i}`, 0, i * 50, `Header ${i}`, { fontSize, customData: { role: "header" } })),
    options: { profile: "visual-qa" },
  }),
  line_length: () => ({
    elements: [text("t", 0, 0, "word ".repeat(20).trim() + " and then some more words to go past eighty")],
    options: { profile: "visual-qa" },
  }),
  style_font_size_off_profile: () => ({
    elements: [text("t", 0, 0, "Neither 16 nor 20", { fontSize: 18 })],
    options: { profile: "visual-qa", boardProfile: boardProfile() },
  }),
  type_scale_violation: () => ({
    elements: [text("t", 0, 0, "Column header", { fontSize: 16, customData: { slot: "colHeader" } })],
    options: { profile: "visual-qa", boardProfile: boardProfile() },
  }),
  hierarchy_inverted: () => ({
    elements: [
      el({ type: "frame", id: "F", x: 0, y: 0, width: 600, height: 400 }),
      text("title", 20, 20, "Section", { fontSize: 16, frameId: "F", customData: { slot: "frameTitle" } }),
      text("body", 20, 80, "Body copy", { fontSize: 20, frameId: "F", customData: { slot: "body" } }),
    ],
    options: {
      profile: "visual-qa",
      boardProfile: boardProfile({ typeScale: { frameTitle: 16, body: 20 } }),
    },
  }),
  semantic_conflict: () => ({
    elements: [
      withLabel(box("c", 0, 0, 400, 120, { customData: { role: "accent" } }), "t"),
      label("t", "c", "[SDK] gateway", { fontSize: 16 }),
    ],
    options: {
      profile: "visual-qa",
      boardProfile: boardProfile({ roles: { accent: { tag: "[YOU]" }, process: { tag: "[SDK]" } } }),
    },
  }),
  role_color_mismatch: () => ({
    elements: [box("r", 0, 0, 200, 100, { customData: { role: "process" } })],
    options: { profile: "visual-qa", boardProfile: boardProfile() },
  }),
};

const validate = (finding: LintFinding, suggestion: unknown): string[] => {
  const problems: string[] = [];
  if (!suggestion || typeof suggestion !== "object") {
    return [`${finding.code}: missing suggestion`];
  }
  if ("reason" in suggestion) {
    const reason = (suggestion as { reason: unknown }).reason;
    if (typeof reason !== "string" || !reason.trim()) {
      problems.push(`${finding.code}: empty reason`);
    }
    return problems;
  }
  const { tool, args, risk } = suggestion as { tool: string; args: Record<string, unknown>; risk: string };
  if (!(tool in SUGGESTION_TOOL_SCHEMAS)) {
    return [`${finding.code}: unknown tool ${tool}`];
  }
  if (risk !== "safe" && risk !== "review") {
    problems.push(`${finding.code}: bad risk ${risk}`);
  }
  const parsed = SUGGESTION_TOOL_SCHEMAS[tool as SuggestionTool].safeParse(args);
  if (!parsed.success) {
    problems.push(`${finding.code}: ${tool} args rejected: ${parsed.error.message}`);
  }
  if (tool === "update_elements") {
    const elements = (args.elements ?? []) as Array<Record<string, unknown>>;
    if (!elements.length) {
      problems.push(`${finding.code}: empty update`);
    }
    for (const patch of elements) {
      if ("dx" in patch || "dy" in patch) {
        problems.push(`${finding.code}: relative dx/dy in an update patch`);
      }
      if (Object.keys(patch).length < 2) {
        problems.push(`${finding.code}: patch without fields`);
      }
    }
  }
  return problems;
};

const lintFixture = (code: LintRuleCode) => {
  const { elements, options } = FIXTURES[code]();
  return lintScene(elements, options);
};

describe("lint suggestion contract", () => {
  it("has a fixture for every rule code", () => {
    expect(Object.keys(FIXTURES).sort()).toEqual([...LINT_RULE_CODES].sort());
  });

  it.each(LINT_RULE_CODES)("%s fires on its fixture and is listed in coverage", (code) => {
    const result = lintFixture(code);
    expect(result.findings.map((f) => f.code)).toContain(code);
    expect(result.summary.coverage).toContain(code);
  });

  it.each(LINT_RULE_CODES)("every suggestion on the %s fixture is executable or a reason", (code) => {
    const problems = lintFixture(code).findings.flatMap((finding) => [
      ...validate(finding, finding.suggestion),
      ...(finding.alternative ? validate(finding, finding.alternative) : []),
    ]);
    expect(problems).toEqual([]);
  });
});
