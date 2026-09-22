// Rule catalogue for validate_scene: every finding code, the highest severity
// it can carry and the profiles that evaluate it. `default` runs on every
// write and plain validate; `visual-qa` is default plus the stricter
// typography/geometry checks; `integrity` is only the data-consistency set.

export type Severity = "error" | "warning" | "info";

export const LINT_PROFILES = ["default", "visual-qa", "integrity"] as const;

export type LintProfile = (typeof LINT_PROFILES)[number];

export type LintRuleSpec = {
  severity: Severity;
  profiles: readonly LintProfile[];
  // Examines element pairs; skipped (and left out of coverage) on scenes too
  // big for pairwise work.
  pairwise?: boolean;
  // Only evaluated when the persisted scene is passed as `stored`.
  needsStored?: boolean;
  // Only evaluated when the board/series profile is passed as `boardProfile`:
  // without one there is no scale or role vocabulary to check against, and
  // reporting against built-in defaults would just be noise.
  needsProfile?: boolean;
  summary: string;
};

const D: readonly LintProfile[] = ["default", "visual-qa"];
const DI: readonly LintProfile[] = ["default", "visual-qa", "integrity"];
const V: readonly LintProfile[] = ["visual-qa"];

export const LINT_RULES = {
  degenerate_size: { severity: "error", profiles: DI, summary: "Shape or text with non-positive width/height." },
  empty_text: { severity: "error", profiles: DI, summary: "Text element without visible text." },
  invisible_opacity: { severity: "warning", profiles: D, summary: "Element with opacity 0." },
  out_of_range: { severity: "warning", profiles: DI, summary: "opacity/roughness/strokeWidth/fontSize outside the valid range." },
  invalid_enum: { severity: "warning", profiles: DI, summary: "Unknown fillStyle/strokeStyle/fontFamily/arrowhead." },
  text_overflow: { severity: "error", profiles: D, summary: "Label does not fit its container (kind overflow, error) or leaves less than minPadding on a side (kind tight, warning)." },
  text_outside_frame: { severity: "error", profiles: D, summary: "Text or container extends past the frame it belongs to." },
  text_original_mismatch: { severity: "warning", profiles: DI, summary: "Bound text whose text differs from originalText beyond soft line breaks." },
  bound_text_below_container: { severity: "error", profiles: DI, summary: "Bound label stacked below its container (hidden by the fill)." },
  orphan_bound_text: { severity: "error", profiles: DI, summary: "Label whose container is missing or does not list it back." },
  binding_invalid: { severity: "error", profiles: DI, summary: "Arrow binding without mode/fixedPoint." },
  binding_target_missing: { severity: "error", profiles: DI, summary: "Arrow bound to a missing or deleted element (was arrow_dangling_binding)." },
  binding_backref_missing: { severity: "error", profiles: DI, summary: "Arrow binds an element that does not list the arrow in boundElements." },
  binding_backref_stale: { severity: "error", profiles: DI, summary: "boundElements lists an arrow/text that is gone or no longer points back." },
  frame_missing: { severity: "error", profiles: DI, summary: "frameId points to a missing or deleted frame." },
  frame_membership_mismatch: { severity: "error", profiles: DI, summary: "Bound label in a different frame than its container." },
  not_persisted: { severity: "error", profiles: DI, needsStored: true, summary: "Element live in memory but missing, deleted or newer in the stored scene." },
  arrow_zero_length: { severity: "warning", profiles: D, summary: "Arrow or line with zero length." },
  arrow_degenerate_segment: { severity: "warning", profiles: D, summary: "Arrow segment shorter than 8px." },
  arrow_unbound_endpoint: { severity: "warning", profiles: D, pairwise: true, summary: "Arrowhead touching a shape without being bound to it." },
  arrow_endpoint_inside_node: { severity: "warning", profiles: D, pairwise: true, summary: "Arrow endpoint deep inside a shape." },
  arrow_crosses_element: { severity: "warning", profiles: D, pairwise: true, summary: "Arrow runs through a shape it is not bound to." },
  arrow_crosses_text: { severity: "warning", profiles: D, pairwise: true, summary: "Arrow runs through a text that is not its own label." },
  arrowheads_converge: { severity: "warning", profiles: D, summary: "Arrowhead tips on the same side of a shape closer than 16px." },
  arrow_label_far: { severity: "warning", profiles: DI, summary: "Arrow label away from its arrow, or a free text grouped with an arrow that should be its label." },
  arrow_labels_collide: { severity: "warning", profiles: D, pairwise: true, summary: "Two arrow labels overlap." },
  arrow_grazes_element: { severity: "info", profiles: V, pairwise: true, summary: "Arrow passes within a few px of a shape without crossing it." },
  arrow_crosses_arrow: { severity: "info", profiles: V, pairwise: true, summary: "Two arrows cross each other." },
  arrow_diagonal_segment: { severity: "info", profiles: V, summary: "Diagonal segment in an otherwise orthogonal path." },
  overlap: { severity: "warning", profiles: D, pairwise: true, summary: "Two elements overlap without intended nesting." },
  duplicate: { severity: "warning", profiles: D, pairwise: true, summary: "Near-identical elements stacked on each other." },
  occlusion: { severity: "warning", profiles: D, pairwise: true, summary: "Opaque shape fully covers an element below it." },
  alignment_near_miss: { severity: "warning", profiles: D, summary: "Elements of one frame/group/table 1-4px off a shared edge or center." },
  off_canvas_outlier: { severity: "warning", profiles: D, summary: "Element far away from everything else." },
  low_contrast: { severity: "warning", profiles: D, summary: "Text color too close to its background." },
  style_many_fonts: { severity: "info", profiles: D, summary: "More than two font families on the board." },
  style_off_palette_color: { severity: "info", profiles: D, summary: "Color that is not a role/palette color (was style_many_stroke_colors)." },
  table_column_without_header: { severity: "warning", profiles: D, summary: "Table column without a header cell." },
  table_cell_overflow: { severity: "error", profiles: D, summary: "Table cell text does not fit its cell." },
  table_row_height_inconsistent: { severity: "warning", profiles: D, summary: "Cells of one table row with different heights." },
  table_header_style_mismatch: { severity: "warning", profiles: D, summary: "Header cells with different font sizes or colors." },
  table_too_dense: { severity: "warning", profiles: D, summary: "Table cell text closer than 4px to its grid lines." },
  text_bad_break: { severity: "info", profiles: V, summary: "Wrapped line starting with a dash/arrow, a one-word last line, or a word split mid-word." },
  frame_padding_asymmetric: { severity: "info", profiles: V, summary: "Frame padding differs noticeably between opposite sides." },
  gap_irregular: { severity: "info", profiles: V, summary: "Uneven gaps between siblings of one row or column." },
  style_font_size_outlier: { severity: "info", profiles: V, summary: "Same-role text with a font size different from the majority." },
  line_length: { severity: "info", profiles: V, summary: "Text line longer than 80 characters." },
  style_font_size_off_profile: { severity: "info", profiles: V, needsProfile: true, summary: "Font size that is not a step of the board profile's type scale." },
  type_scale_violation: { severity: "info", profiles: V, needsProfile: true, summary: "Text set at a scale step other than the one its role calls for (a column header at body size)." },
  hierarchy_inverted: { severity: "info", profiles: V, needsProfile: true, summary: "Text of a higher scale role set smaller than lower-ranked text in the same frame." },
  semantic_conflict: { severity: "info", profiles: V, needsProfile: true, summary: "Element whose role or stroke style means one thing in the profile while its text says another." },
  role_color_mismatch: { severity: "info", profiles: V, needsProfile: true, summary: "customData.role is set but the colors no longer match that role's palette entry." },
} as const satisfies Record<string, LintRuleSpec>;

export type LintRuleCode = keyof typeof LINT_RULES;

export const LINT_RULE_CODES = Object.keys(LINT_RULES) as LintRuleCode[];

// Renamed or merged codes: a lintIgnore, disabledRules or codes entry naming
// the old code keeps working on the new one.
export const LINT_CODE_ALIASES: Record<string, LintRuleCode> = {
  arrow_dangling_binding: "binding_target_missing",
  style_many_stroke_colors: "style_off_palette_color",
  arrow_too_short: "arrow_degenerate_segment",
  text_tight: "text_overflow",
};

export const canonicalLintCode = (code: string): string =>
  LINT_CODE_ALIASES[code] ?? code;

export const isLintRuleCode = (code: string): code is LintRuleCode =>
  Object.prototype.hasOwnProperty.call(LINT_RULES, code);

export const lintCodesForProfile = (profile: LintProfile): LintRuleCode[] =>
  LINT_RULE_CODES.filter((code) =>
    (LINT_RULES[code].profiles as readonly LintProfile[]).includes(profile),
  );

export const SEVERITY_RANK: Record<Severity, number> = {
  error: 3,
  warning: 2,
  info: 1,
};
