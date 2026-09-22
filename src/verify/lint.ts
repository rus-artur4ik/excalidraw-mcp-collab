import type {ExcalidrawElement} from "../types";
import type {BoardProfile} from "../profile";
import {kindOf, lintIgnoreEntries, roleOf} from "../customData";
import {asLinear, type Bounds, isBindable, isFrameLike, isLinear} from "./model";
import {boundsContain, getElementBounds} from "./geometry";
import {boundsIntersect, buildLintContext, isDivider, type LintFinding, NON_NODE_KINDS, tableIdOf,} from "./lintContext";
import {
    canonicalLintCode,
    LINT_RULE_CODES,
    LINT_RULES,
    lintCodesForProfile,
    type LintProfile,
    type Severity,
    SEVERITY_RANK,
} from "./lintProfiles";
import {elementRules} from "./lintElementRules";
import {arrowRules} from "./lintArrowRules";
import {layoutRules} from "./lintLayoutRules";
import {tableRules} from "./lintTableRules";
import {profileRules} from "./lintProfileRules";

export type {LintFinding} from "./lintContext";
export type {LintProfile, LintRuleCode, LintRuleSpec, Severity} from "./lintProfiles";
export {canonicalLintCode, LINT_CODE_ALIASES, LINT_PROFILES, LINT_RULES, lintCodesForProfile,} from "./lintProfiles";

export type LintOptions = {
  disabledRules?: string[];
  viewBackgroundColor?: string;
};

export type LintScopeOptions = LintOptions & {
  ids?: string[];
  region?: Bounds;
  // Selects rules directly, from any profile.
  codes?: string[];
  minSeverity?: Severity;
  summaryOnly?: boolean;
  profile?: LintProfile;
  // Free space a label must keep inside its container (text_overflow tight).
  minPadding?: number;
  // The persisted scene; enables not_persisted.
  stored?: readonly ExcalidrawElement[];
  // The board's (or its folder's) style profile; enables the type-scale and
  // semantic rules, which have nothing to check against without it.
  boardProfile?: BoardProfile;
};

export type LintSummary = {
  errors: number;
  warnings: number;
  infos: number;
  // Every rule code evaluated in this run: "0 findings" for a code listed
  // here means clean, a code missing here was not checked.
  coverage: string[];
  // Findings hidden by lintIgnore entries without `with` (bare codes).
  suppressedBroadly: number;
};

export type ConnectivityGraph = {
  nodeCount: number;
  edgeCount: number;
  isolated: string[];
};

export type LintResult = {
  findings: LintFinding[];
  summary: LintSummary;
  graph: ConnectivityGraph;
  scope?: { kind: "ids" | "region"; matched: number };
  profile: LintProfile;
};

export const DEFAULT_MIN_PADDING = 8;
export const ISOLATED_RULE = "isolated";

const MAX_PAIRWISE_ELEMENTS = 1500;

// Identity of a finding across two runs, so a write can report only the
// findings it introduced.
export const findingKey = (finding: LintFinding): string =>
  `${finding.code}|${[...new Set(finding.elementIds)].sort().join(",")}|${finding.kind ?? ""}`;

// ---- lintIgnore -------------------------------------------------------------

type IgnoreEntry = { code: string; with?: string[] };

// An element's effective lintIgnore: its own entries, its frame's, and those
// of every element it shares a group with (one member opts the group out).
const ignoreResolver = (
  live: readonly ExcalidrawElement[],
  byId: Map<string, ExcalidrawElement>,
): ((element: ExcalidrawElement) => IgnoreEntry[]) => {
  const byGroup = new Map<string, IgnoreEntry[]>();
  for (const element of live) {
    const entries = lintIgnoreEntries(element);
    if (!entries.length) {
      continue;
    }
    for (const groupId of element.groupIds ?? []) {
      byGroup.set(groupId, [...(byGroup.get(groupId) ?? []), ...entries]);
    }
  }
  const cache = new Map<string, IgnoreEntry[]>();
  return (element) => {
    let entries = cache.get(element.id);
    if (!entries) {
      const frame = typeof element.frameId === "string" ? byId.get(element.frameId) : undefined;
      entries = [
        ...lintIgnoreEntries(element),
        ...(frame ? lintIgnoreEntries(frame) : []),
        ...(element.groupIds ?? []).flatMap((groupId) => byGroup.get(groupId) ?? []),
      ];
      cache.set(element.id, entries);
    }
    return entries;
  };
};

const suppressionOf = (
  finding: LintFinding,
  byId: Map<string, ExcalidrawElement>,
  resolve: (element: ExcalidrawElement) => IgnoreEntry[],
): "broad" | "narrow" | null => {
  let broad = false;
  for (const id of finding.elementIds) {
    const element = byId.get(id);
    if (!element) {
      continue;
    }
    for (const entry of resolve(element)) {
      if (canonicalLintCode(entry.code) !== finding.code) {
        continue;
      }
      if (!entry.with) {
        broad = true;
      } else if (entry.with.some((other) => other !== id && finding.elementIds.includes(other))) {
        return "narrow";
      }
    }
  }
  return broad ? "broad" : null;
};

export const ignoresRule = (element: ExcalidrawElement, code: string): boolean =>
  lintIgnoreEntries(element).some(
    (entry) => !entry.with && canonicalLintCode(entry.code) === canonicalLintCode(code),
  );

// ---- connectivity graph ---------------------------------------------------

const COMPOSITE_FRAME_KINDS = new Set(["legend", "table", "code"]);
const CENTER_CELL = 400;

// A shape that fully contains another node is a cluster box, not a node,
// even without a kind (boards drawn before kinds existed).
const withoutContainers = (nodes: ExcalidrawElement[]): ExcalidrawElement[] => {
  const bounds = new Map(nodes.map((node) => [node.id, getElementBounds(node)]));
  const cells = new Map<string, ExcalidrawElement[]>();
  const cellOf = (x: number, y: number) => `${Math.floor(x / CENTER_CELL)}:${Math.floor(y / CENTER_CELL)}`;
  for (const node of nodes) {
    const [x1, y1, x2, y2] = bounds.get(node.id)!;
    const key = cellOf((x1 + x2) / 2, (y1 + y2) / 2);
    cells.set(key, [...(cells.get(key) ?? []), node]);
  }
  return nodes.filter((node) => {
    const outer = bounds.get(node.id)!;
    for (let cx = Math.floor(outer[0] / CENTER_CELL); cx <= Math.floor(outer[2] / CENTER_CELL); cx++) {
      for (let cy = Math.floor(outer[1] / CENTER_CELL); cy <= Math.floor(outer[3] / CENTER_CELL); cy++) {
        for (const other of cells.get(`${cx}:${cy}`) ?? []) {
          const inner = bounds.get(other.id)!;
          const larger = (outer[2] - outer[0]) * (outer[3] - outer[1]) > (inner[2] - inner[0]) * (inner[3] - inner[1]);
          if (other.id !== node.id && larger && boundsContain(outer, inner)) {
            return false;
          }
        }
      }
    }
    return true;
  });
};

const connectivity = (
  live: readonly ExcalidrawElement[],
  byId: Map<string, ExcalidrawElement>,
  resolve: (element: ExcalidrawElement) => IgnoreEntry[],
): ConnectivityGraph => {
  const isNode = (element: ExcalidrawElement): boolean => {
    if (!isBindable(element) || element.type === "text" || isFrameLike(element) || tableIdOf(element)) {
      return false;
    }
    const kind = kindOf(element);
    // The palette's "note" role is an annotation, not part of the graph.
    if ((kind && NON_NODE_KINDS.has(kind)) || roleOf(element) === "note") {
      return false;
    }
    const frame = typeof element.frameId === "string" ? byId.get(element.frameId) : undefined;
    const frameKind = frame ? kindOf(frame) : undefined;
    return !(frameKind && COMPOSITE_FRAME_KINDS.has(frameKind));
  };
  const nodes = withoutContainers(live.filter(isNode));
  const connected = new Set<string>();
  // Frames (and the frameless pseudo-frame "") that hold at least one arrow:
  // only there is an unconnected node suspicious.
  const withArrows = new Set<string>();
  let edgeCount = 0;
  for (const element of live) {
    if (!isLinear(element) || isDivider(element)) {
      continue;
    }
    const linear = asLinear(element);
    withArrows.add(element.frameId ?? "");
    const ends = [linear.startBinding?.elementId, linear.endBinding?.elementId].filter(
      (id): id is string => typeof id === "string" && byId.has(id),
    );
    for (const id of ends) {
      connected.add(id);
      withArrows.add(byId.get(id)!.frameId ?? "");
    }
    if (ends.length === 2) {
      edgeCount++;
    }
  }
  return {
    nodeCount: nodes.length,
    edgeCount,
    isolated: nodes
      .filter(
        (node) =>
          !connected.has(node.id) &&
          withArrows.has(node.frameId ?? "") &&
          !resolve(node).some((entry) => !entry.with && canonicalLintCode(entry.code) === ISOLATED_RULE),
      )
      .map((node) => node.id),
  };
};

export const buildConnectivityGraph = (
  elements: readonly ExcalidrawElement[],
): ConnectivityGraph => {
  const live = elements.filter((element) => !element.isDeleted);
  const byId = new Map(live.map((element) => [element.id, element]));
  return connectivity(live, byId, ignoreResolver(live, byId));
};

// ---- entry point ------------------------------------------------------------

const scopeIdSet = (
  live: readonly ExcalidrawElement[],
  options: LintScopeOptions,
): Set<string> | null => {
  if (options.ids && options.ids.length) {
    return new Set(options.ids);
  }
  if (options.region) {
    const set = new Set<string>();
    for (const element of live) {
      if (boundsIntersect(getElementBounds(element), options.region)) {
        set.add(element.id);
      }
    }
    return set;
  }
  return null;
};

export const lintScene = (
  elements: readonly ExcalidrawElement[],
  options: LintScopeOptions = {},
): LintResult => {
  const profile = options.profile ?? "default";
  const disabled = new Set((options.disabledRules ?? []).map(canonicalLintCode));
  const requested = options.codes?.length ? new Set(options.codes.map(canonicalLintCode)) : null;
  const floor = options.minSeverity ? SEVERITY_RANK[options.minSeverity] : 0;
  const live = elements.filter((element) => !element.isDeleted);
  const scope = scopeIdSet(live, options);
  const pairwise = scope
    ? live.length * Math.max(1, scope.size) <= MAX_PAIRWISE_ELEMENTS * MAX_PAIRWISE_ELEMENTS
    : live.length <= MAX_PAIRWISE_ELEMENTS;

  const selected = requested
    ? LINT_RULE_CODES.filter((code) => requested.has(code))
    : lintCodesForProfile(profile);
  const skipped: string[] = [];
  const active = new Set<string>();
  for (const code of selected) {
    const spec: { severity: Severity; pairwise?: boolean; needsStored?: boolean; needsProfile?: boolean } =
      LINT_RULES[code];
    if (disabled.has(code) || SEVERITY_RANK[spec.severity] < floor) {
      continue;
    }
    if (spec.needsStored && !options.stored) {
      continue;
    }
    if (spec.needsProfile && !options.boardProfile) {
      continue;
    }
    if (spec.pairwise && !pairwise) {
      skipped.push(code);
      continue;
    }
    active.add(code);
  }

  const raw: LintFinding[] = [];
  const ctx = buildLintContext(elements, {
    scope,
    active,
    minPadding: options.minPadding ?? DEFAULT_MIN_PADDING,
    viewBackgroundColor: options.viewBackgroundColor ?? "#ffffff",
    stored: options.stored,
    ...(options.boardProfile ? { boardProfile: options.boardProfile } : {}),
    sink: raw,
  });
  elementRules(ctx);
  arrowRules(ctx);
  const headerKeys = tableRules(ctx);
  layoutRules(ctx, headerKeys);
  profileRules(ctx);

  const resolve = ignoreResolver(ctx.live, ctx.byId);
  const seen = new Set<string>();
  const findings: LintFinding[] = [];
  let suppressedBroadly = 0;
  for (const finding of raw) {
    if (!active.has(finding.code) || SEVERITY_RANK[finding.severity] < floor) {
      continue;
    }
    if (scope && !finding.elementIds.some((id) => scope.has(id))) {
      continue;
    }
    const key = findingKey(finding);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const suppressed = suppressionOf(finding, ctx.byId, resolve);
    if (suppressed === "broad") {
      suppressedBroadly++;
    }
    if (!suppressed) {
      findings.push(finding);
    }
  }
  if (skipped.length && floor <= SEVERITY_RANK.info) {
    findings.push({
      code: "scene_too_large",
      severity: "info",
      elementIds: [],
      message: `Scene has ${live.length} elements; pairwise checks (${skipped.join(", ")}) were skipped. Scope the run with ids or region to include them.`,
      suggestion: { reason: "Validate a smaller scope (ids or region) to run the pairwise checks." },
    });
  }

  const summary: LintSummary = {
    errors: 0,
    warnings: 0,
    infos: 0,
    coverage: LINT_RULE_CODES.filter((code) => active.has(code)),
    suppressedBroadly,
  };
  for (const finding of findings) {
    if (finding.severity === "error") {
      summary.errors++;
    } else if (finding.severity === "warning") {
      summary.warnings++;
    } else {
      summary.infos++;
    }
  }

  return {
    findings: options.summaryOnly ? [] : findings,
    summary,
    graph: connectivity(ctx.live, ctx.byId, resolve),
    profile,
    ...(scope
      ? { scope: { kind: options.ids?.length ? "ids" : "region", matched: scope.size } as const }
      : {}),
  };
};

// Rules that judge the scene as a whole; inline per-element lint skips them.
const SCENE_LEVEL_RULES = new Set([
  "alignment_near_miss",
  "off_canvas_outlier",
  "style_many_fonts",
  "style_off_palette_color",
  "duplicate",
  "occlusion",
  "gap_irregular",
  "frame_padding_asymmetric",
  "style_font_size_outlier",
  "table_column_without_header",
  "table_row_height_inconsistent",
  "table_header_style_mismatch",
  "table_too_dense",
]);

// Kept for the old inline-warning path; the write pipeline now runs a scoped
// lintScene before and after a write and diffs findingKey.
export const lintElement = (
  element: ExcalidrawElement,
  scene: readonly ExcalidrawElement[],
  options: LintOptions = {},
): LintFinding[] =>
  lintScene([...scene.filter((other) => other.id !== element.id), element], {
    ...options,
    ids: [element.id],
    codes: lintCodesForProfile("default").filter((code) => !SCENE_LEVEL_RULES.has(code)),
  }).findings;
