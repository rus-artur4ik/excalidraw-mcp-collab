import {describe, expect, it} from "vitest";

import type {ExcalidrawElement} from "../../types";
import type {BoardProfile} from "../../profile";
import {type LintFinding, type LintScopeOptions, lintScene} from "../lint";
import {STYLE_ROLES} from "../styles";
import {getLineWidth} from "../textMetrics";
import {el} from "./factory";

const PROFILE: BoardProfile = {
  typeScale: { title: 36, frameTitle: 28, colHeader: 20, body: 16, caption: 14, code: 14 },
  roles: { accent: { tag: "[YOU]" }, process: { tag: "[SDK]", meaning: "the SDK" } },
  strokeStyles: { dashed: "[planned]", solid: "[shipped]" },
};

const codes = (findings: readonly LintFinding[]) => findings.map((f) => f.code);

const box = (id: string, x: number, y: number, width: number, height: number, extra: Partial<ExcalidrawElement> = {}) =>
  el({ type: "rectangle", id, x, y, width, height, ...extra });

const text = (id: string, value: string, fontSize: number, extra: Partial<ExcalidrawElement> = {}) =>
  el({
    type: "text",
    id,
    x: 0,
    y: 0,
    text: value,
    originalText: value,
    fontSize,
    fontFamily: 5,
    width: getLineWidth(value, fontSize, 5),
    height: Math.round(fontSize * 1.25),
    ...extra,
  });

const label = (id: string, containerId: string, value: string, fontSize = 16) =>
  el({ type: "text", id, containerId, text: value, originalText: value, fontSize, fontFamily: 5, x: 0, y: 0, width: 10, height: 20 });

const withLabel = (container: ExcalidrawElement, labelId: string) =>
  ({ ...container, boundElements: [{ id: labelId, type: "text" }] }) as ExcalidrawElement;

const run = (elements: ExcalidrawElement[], options: LintScopeOptions = {}) =>
  lintScene(elements, { profile: "visual-qa", boardProfile: PROFILE, ...options });

const findingsFor = (code: string, elements: ExcalidrawElement[], options?: LintScopeOptions) =>
  run(elements, options).findings.filter((finding) => finding.code === code);

const PROFILE_CODES = [
  "style_font_size_off_profile",
  "type_scale_violation",
  "hierarchy_inverted",
  "semantic_conflict",
  "role_color_mismatch",
];

describe("the profile rules are gated on a profile", () => {
  const scene = () => [
    text("t", "Odd size", 18),
    box("r", 0, 200, 200, 100, { customData: { role: "process" } }),
  ];

  it("reports nothing and covers nothing without a board profile", () => {
    const result = lintScene(scene(), { profile: "visual-qa" });
    for (const code of PROFILE_CODES) {
      expect(result.summary.coverage).not.toContain(code);
    }
    expect(codes(result.findings).filter((code) => PROFILE_CODES.includes(code))).toEqual([]);
  });

  it("covers every one of them once a profile is passed", () => {
    const result = run(scene());
    for (const code of PROFILE_CODES) {
      expect(result.summary.coverage).toContain(code);
    }
  });

  it("stays out of the default lint profile", () => {
    const result = lintScene(scene(), { boardProfile: PROFILE });
    for (const code of PROFILE_CODES) {
      expect(result.summary.coverage).not.toContain(code);
    }
  });
});

describe("style_font_size_off_profile", () => {
  it("reports a size that is on no step and suggests the nearest one", () => {
    const [finding] = findingsFor("style_font_size_off_profile", [text("t", "Cell", 18)]);
    expect(finding).toBeDefined();
    expect(finding.suggestion).toMatchObject({
      tool: "update_elements",
      args: { elements: [{ id: "t", fontSize: 20 }] },
    });
  });

  it("accepts every step of the scale, and tolerates 1px off one", () => {
    const sizes = [36, 28, 20, 16, 14, 15];
    expect(findingsFor("style_font_size_off_profile", sizes.map((size, i) => text(`t${i}`, "x", size)))).toEqual([]);
  });

  it("patches the container for a bound label, because the size lives there", () => {
    const [finding] = findingsFor("style_font_size_off_profile", [
      withLabel(box("c", 0, 0, 400, 120), "t"),
      label("t", "c", "Odd", 18),
    ]);
    expect(finding.suggestion).toMatchObject({
      args: { elements: [{ id: "c", labelFontSize: 20 }] },
    });
  });
});

describe("type_scale_violation", () => {
  it("reports a column header set at body size", () => {
    const [finding] = findingsFor("type_scale_violation", [
      text("h", "Symptom", 16, { customData: { slot: "colHeader" } }),
    ]);
    expect(finding.message).toContain("20");
    expect(finding.suggestion).toMatchObject({ args: { elements: [{ id: "h", fontSize: 20 }] } });
  });

  it("reads the role off a table header cell without a slot", () => {
    const cells = [
      withLabel(box("t:_h:s", 0, 0, 200, 40, { customData: { kind: "table-cell", table: { tableId: "t", row: "_h", col: "s" } } }), "t:_h:s:label"),
      label("t:_h:s:label", "t:_h:s", "Symptom", 16),
    ];
    const [finding] = findingsFor("type_scale_violation", cells);
    expect(finding.kind).toBe("colHeader");
  });

  it("says nothing when the text is at its own step", () => {
    expect(
      findingsFor("type_scale_violation", [text("h", "Symptom", 20, { customData: { slot: "colHeader" } })]),
    ).toEqual([]);
  });

  it("ignores text with no declared scale role", () => {
    expect(findingsFor("type_scale_violation", [text("n", "A node", 16)])).toEqual([]);
  });
});

describe("hierarchy_inverted", () => {
  const frame = el({ type: "frame", id: "F", x: 0, y: 0, width: 800, height: 600 });

  it("reports a frame title smaller than the body text under it", () => {
    const [finding] = findingsFor("hierarchy_inverted", [
      frame,
      text("ft", "Section", 16, { frameId: "F", customData: { slot: "frameTitle" } }),
      text("b", "Body copy", 20, { frameId: "F", customData: { slot: "body" } }),
    ]);
    expect(finding.elementIds).toEqual(["ft", "b"]);
    expect(finding.kind).toBe("frameTitle|body");
  });

  it("reports a node label smaller than a caption in the same frame", () => {
    const [finding] = findingsFor("hierarchy_inverted", [
      frame,
      withLabel(box("n", 10, 10, 300, 100, { frameId: "F", customData: { slot: "body" } }), "n:label"),
      label("n:label", "n", "Gateway", 12),
      text("cap", "source: docs", 16, { frameId: "F", customData: { slot: "caption" } }),
    ]);
    expect(finding.kind).toBe("body|caption");
  });

  it("does not compare across frames", () => {
    const other = el({ type: "frame", id: "G", x: 1000, y: 0, width: 800, height: 600 });
    expect(
      findingsFor("hierarchy_inverted", [
        frame,
        other,
        text("ft", "Section", 16, { frameId: "F", customData: { slot: "frameTitle" } }),
        text("b", "Body copy", 20, { frameId: "G", customData: { slot: "body" } }),
      ]),
    ).toEqual([]);
  });

  it("reports one finding per pair of roles, not per pair of texts", () => {
    expect(
      findingsFor("hierarchy_inverted", [
        frame,
        text("ft", "Section", 16, { frameId: "F", customData: { slot: "frameTitle" } }),
        ...[0, 1, 2].map((i) =>
          text(`b${i}`, `Body ${i}`, 20, { frameId: "F", customData: { slot: "body" } }),
        ),
      ]),
    ).toHaveLength(1);
  });
});

describe("semantic_conflict", () => {
  it("reports an accent element whose text carries another role's tag", () => {
    const [finding] = findingsFor("semantic_conflict", [
      withLabel(box("c", 0, 0, 400, 120, { customData: { role: "accent" } }), "t"),
      label("t", "c", "[SDK] gateway"),
    ]);
    expect(finding.kind).toBe("role:accent");
    expect(finding.message).toContain("[YOU]");
    expect(finding.suggestion).toHaveProperty("reason");
  });

  it("says nothing when the text carries its own role's tag", () => {
    expect(
      findingsFor("semantic_conflict", [
        withLabel(box("c", 0, 0, 400, 120, { customData: { role: "accent" } }), "t"),
        label("t", "c", "[YOU] the caller"),
      ]),
    ).toEqual([]);
  });

  it("reports a solid stroke whose text says the dashed meaning", () => {
    const [finding] = findingsFor("semantic_conflict", [
      withLabel(box("c", 0, 0, 400, 120, { strokeStyle: "solid" }), "t"),
      label("t", "c", "[planned] queue"),
    ]);
    expect(finding.kind).toBe("strokeStyle:solid");
    expect(finding.suggestion).toMatchObject({
      args: { elements: [{ id: "c", strokeStyle: "dashed" }] },
    });
  });

  it("says nothing when the stroke style matches the meaning", () => {
    expect(
      findingsFor("semantic_conflict", [
        withLabel(box("c", 0, 0, 400, 120, { strokeStyle: "dashed" }), "t"),
        label("t", "c", "[planned] queue"),
      ]),
    ).toEqual([]);
  });
});

describe("role_color_mismatch", () => {
  const process = STYLE_ROLES.process;

  it("reports a role whose colors were changed by hand", () => {
    const [finding] = findingsFor("role_color_mismatch", [
      box("r", 0, 0, 200, 100, {
        customData: { role: "process" },
        strokeColor: "#e03131",
        backgroundColor: process.backgroundColor,
      }),
    ]);
    expect(finding.kind).toBe("process");
    expect(finding.suggestion).toMatchObject({
      args: { elements: [{ id: "r", role: "process" }] },
    });
  });

  it("says nothing when the colors still match the role", () => {
    expect(
      findingsFor("role_color_mismatch", [
        box("r", 0, 0, 200, 100, {
          customData: { role: "process" },
          strokeColor: process.strokeColor,
          backgroundColor: process.backgroundColor,
        }),
      ]),
    ).toEqual([]);
  });

  it("matches the subtle tone against the subtle fill", () => {
    const subtleFill = "#e7f5ff";
    expect(
      findingsFor("role_color_mismatch", [
        box("r", 0, 0, 200, 100, {
          customData: { role: "process", tone: "subtle" },
          strokeColor: process.strokeColor,
          backgroundColor: subtleFill,
        }),
      ]),
    ).toEqual([]);
    expect(
      findingsFor("role_color_mismatch", [
        box("r", 0, 0, 200, 100, {
          customData: { role: "process", tone: "subtle" },
          strokeColor: process.strokeColor,
          backgroundColor: process.backgroundColor,
        }),
      ]),
    ).toHaveLength(1);
  });

  it("leaves an element without a recorded role alone", () => {
    expect(findingsFor("role_color_mismatch", [box("r", 0, 0, 200, 100, { strokeColor: "#ff0000" })])).toEqual([]);
  });
});
