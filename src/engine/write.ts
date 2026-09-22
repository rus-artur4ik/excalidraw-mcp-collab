import type {ExcalidrawElement} from "../types";
import {findingKey, type LintFinding, lintScene} from "../verify/lint";
import type {BoardProfile} from "../profile";
import {applyUpdate} from "../elements";
import {ToolError} from "./errors";
import {followShapes} from "./follow";
import {relayoutTouchedStacks} from "./stack";
import {SceneTxn} from "./txn";

export type LintMode = "new" | "touched" | "errors" | "summary" | "off";

export type WriteOptions = {
  dryRun?: boolean;
  strict?: "warn" | "error";
  lint?: LintMode;
  // Optimistic precondition: {id: version}. Any mismatch aborts the write.
  expect?: Record<string, number>;
  note?: string;
  returnElements?: boolean;
  // Round x/y/width/height of the shapes this write changed to this grid.
  snap?: number;
  // The board's style profile: the lint checks font sizes and role meanings
  // against it.
  boardProfile?: BoardProfile | null;
};

export type LintDelta = {
  new?: LintFinding[];
  findings?: LintFinding[];
  resolved: number;
  persisting: Record<string, number>;
  errors: number;
  warnings: number;
};

export type ChangeSummary = {
  created: string[];
  updated: string[];
  deleted: string[];
  revived: Array<{ id: string; previousVersion: number }>;
};

export {findingKey};

export const summarizeChanges = (txn: SceneTxn): ChangeSummary => {
  const summary: ChangeSummary = { created: [], updated: [], deleted: [], revived: [] };
  for (const element of txn.changed()) {
    const before = txn.original(element.id);
    if (element.isDeleted) {
      if (before && !before.isDeleted) summary.deleted.push(element.id);
      continue;
    }
    if (!before) {
      summary.created.push(element.id);
    } else if (before.isDeleted) {
      summary.revived.push({ id: element.id, previousVersion: before.version });
    } else {
      summary.updated.push(element.id);
    }
  }
  return summary;
};

const countBy = (findings: readonly LintFinding[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const finding of findings) {
    counts[finding.code] = (counts[finding.code] ?? 0) + 1;
  }
  return counts;
};

// Lint only what this write touched, before and after, and report what is
// new — the agent sees the effect of its own call, not the board's backlog.
export const lintDelta = (
  txn: SceneTxn,
  mode: LintMode,
  boardProfile?: BoardProfile | null,
): LintDelta | undefined => {
  if (mode === "off") {
    return undefined;
  }
  const scope = txn.changed().map((element) => element.id);
  if (!scope.length) {
    return undefined;
  }
  const after = lintScene(txn.liveElements(), { ids: scope, ...(boardProfile ? { boardProfile } : {}) }).findings;
  const errors = after.filter((finding) => finding.severity === "error").length;
  const warnings = after.filter((finding) => finding.severity === "warning").length;
  if (mode === "touched") {
    return { findings: after, resolved: 0, persisting: {}, errors, warnings };
  }
  const before = lintScene(txn.baseLiveElements(), { ids: scope, ...(boardProfile ? { boardProfile } : {}) }).findings;
  const beforeKeys = new Set(before.map(findingKey));
  const afterKeys = new Set(after.map(findingKey));
  const fresh = after.filter((finding) => !beforeKeys.has(findingKey(finding)));
  const persisting = countBy(after.filter((finding) => beforeKeys.has(findingKey(finding))));
  const resolved = before.filter((finding) => !afterKeys.has(findingKey(finding))).length;
  if (mode === "summary") {
    return { resolved, persisting: { ...persisting, ...prefixed(countBy(fresh)) }, errors, warnings };
  }
  if (mode === "errors") {
    return {
      new: fresh.filter((finding) => finding.severity === "error"),
      resolved,
      persisting,
      errors,
      warnings,
    };
  }
  return { new: fresh, resolved, persisting, errors, warnings };
};

const prefixed = (counts: Record<string, number>): Record<string, number> => {
  const result: Record<string, number> = {};
  for (const [code, count] of Object.entries(counts)) {
    result[`new:${code}`] = count;
  }
  return result;
};

export const checkExpectedVersions = (
  elements: ReadonlyMap<string, ExcalidrawElement>,
  expect: Record<string, number> | undefined,
): void => {
  if (!expect) {
    return;
  }
  const changed: Array<{ id: string; expected: number; actual: number | null }> = [];
  for (const [id, version] of Object.entries(expect)) {
    const element = elements.get(id);
    const actual = element && !element.isDeleted ? element.version : null;
    if (actual !== version) {
      changed.push({ id, expected: version, actual });
    }
  }
  if (changed.length) {
    throw new ToolError(
      "conflict",
      "the board changed since you read it; re-read these elements and retry",
      { retryable: true, details: { ids: changed.map((entry) => entry.id), changed } },
    );
  }
};

export type PlannedWrite<T> = {
  txn: SceneTxn;
  result: T;
  lint?: LintDelta;
  // Taken while the base map still holds the pre-write state: the commit
  // writes the staged elements into that same map.
  summary: ChangeSummary;
};

// Plan a write against a snapshot of the scene: nothing is committed here.
export const planWrite = <T>(
  base: ReadonlyMap<string, ExcalidrawElement>,
  options: WriteOptions,
  fn: (txn: SceneTxn) => T,
): PlannedWrite<T> => {
  checkExpectedVersions(base, options.expect);
  const txn = new SceneTxn(base);
  const result = fn(txn);
  if (options.snap && options.snap > 0) {
    snapChanged(txn, options.snap);
  }
  // A stack keeps its gaps: if this write grew or moved a member, the rest of
  // that stack follows before anything is linted or committed.
  relayoutTouchedStacks(txn);
  if (options.strict === "error" && txn.report.ignoredFields.length) {
    throw new ToolError(
      "unsupported_field",
      `nothing was written: ${txn.report.ignoredFields.length} field(s) would have been ignored`,
      { retryable: false, details: { ignoredFields: txn.report.ignoredFields } },
    );
  }
  return {
    txn,
    result,
    lint: lintDelta(txn, options.lint ?? "new", options.boardProfile),
    summary: summarizeChanges(txn),
  };
};

// N09: round the geometry of every shape this write touched, then let labels
// and arrows follow the snapped boxes.
const snapChanged = (txn: SceneTxn, step: number): void => {
  const round = (value: number): number => Math.round(value / step) * step;
  const snapped: string[] = [];
  for (const element of txn.changed()) {
    if (element.isDeleted || element.type === "text" || element.type === "arrow" || element.type === "line" || element.type === "freedraw") {
      continue;
    }
    const next = { x: round(element.x), y: round(element.y), width: Math.max(step, round(element.width)), height: Math.max(step, round(element.height)) };
    if (next.x === element.x && next.y === element.y && next.width === element.width && next.height === element.height) {
      continue;
    }
    txn.put(applyUpdate(element, next));
    snapped.push(element.id);
  }
  if (snapped.length) {
    followShapes(txn, snapped);
    for (const id of snapped) txn.report.snapped.add(id);
  }
};

const nonEmpty = <T>(value: T[] | undefined): T[] | undefined =>
  value && value.length ? value : undefined;

export type Envelope = {
  dryRun?: true;
  commitId?: string;
  sceneVersion: number;
  prevSceneVersion: number;
  changed: Partial<ChangeSummary>;
  labels?: Record<string, string>;
  persisted?:
    | { ok: true; lifted?: Array<{ id: string; version: number }> }
    | { ok: false; lost: Array<{ id: string; storedVersion: number; localVersion: number }> };
  conflicts?: unknown[];
  ignoredFields?: SceneTxn["report"]["ignoredFields"];
  missing?: string[];
  skipped?: SceneTxn["report"]["skipped"];
  alreadyApplied?: string[];
  collateral?: SceneTxn["report"]["collateral"];
  relaidOut?: string[];
  rerouted?: string[];
  fit?: SceneTxn["report"]["fit"];
  snapped?: string[];
  warnings?: string[];
  lint?: LintDelta;
  elements?: ExcalidrawElement[];
};

export const buildEnvelope = (
  planned: PlannedWrite<unknown>,
  extra: {
    sceneVersion: number;
    prevSceneVersion: number;
    dryRun?: boolean;
    commitId?: string;
    persisted?: Envelope["persisted"];
    conflicts?: unknown[];
    returnElements?: boolean;
    // The committed elements as they are live after persist (versions may
    // have been lifted); defaults to the planned ones.
    finalElements?: ExcalidrawElement[];
  },
): Envelope => {
  const { txn } = planned;
  const report = txn.report;
  const summary = planned.summary;
  const changed: Partial<ChangeSummary> = {};
  if (summary.created.length) changed.created = summary.created;
  if (summary.updated.length) changed.updated = summary.updated;
  if (summary.deleted.length) changed.deleted = summary.deleted;
  if (summary.revived.length) changed.revived = summary.revived;
  const warnings = [...report.warnings];
  if (!extra.dryRun && extra.sceneVersion < extra.prevSceneVersion) {
    warnings.push(
      `scene_version_regressed: sceneVersion went from ${extra.prevSceneVersion} to ${extra.sceneVersion}; some change did not stick — validate_scene with codes:["not_persisted"]`,
    );
  }
  const envelope: Envelope = {
    ...(extra.dryRun ? { dryRun: true as const } : {}),
    ...(extra.commitId ? { commitId: extra.commitId } : {}),
    sceneVersion: extra.sceneVersion,
    prevSceneVersion: extra.prevSceneVersion,
    changed,
  };
  if (Object.keys(report.labels).length) envelope.labels = report.labels;
  if (extra.persisted) envelope.persisted = extra.persisted;
  if (extra.conflicts?.length) envelope.conflicts = extra.conflicts;
  envelope.ignoredFields = nonEmpty(report.ignoredFields);
  envelope.missing = nonEmpty(report.missing);
  envelope.skipped = nonEmpty(report.skipped);
  envelope.alreadyApplied = nonEmpty(report.alreadyApplied);
  envelope.collateral = nonEmpty(report.collateral);
  envelope.relaidOut = nonEmpty([...report.relaidOut]);
  envelope.rerouted = nonEmpty([...report.rerouted]);
  envelope.fit = nonEmpty(report.fit);
  envelope.snapped = nonEmpty([...report.snapped]);
  envelope.warnings = nonEmpty(warnings);
  if (planned.lint) envelope.lint = planned.lint;
  if (extra.returnElements) {
    envelope.elements = (extra.finalElements ?? txn.changed()).filter((element) => !element.isDeleted);
  }
  for (const key of Object.keys(envelope) as Array<keyof Envelope>) {
    if (envelope[key] === undefined) delete envelope[key];
  }
  return envelope;
};

// Same sum as scene.getSceneVersion, without importing the Firestore layer.
export const sceneVersionOf = (elements: Iterable<ExcalidrawElement>): number => {
  let total = 0;
  for (const element of elements) {
    total += element.version;
  }
  return total;
};
