import type {ExcalidrawElement} from "../types";
import {asLinear, asText, isLinear} from "../verify/model";
import type {LintFinding} from "../verify/lint";
import {LABEL_ID_SUFFIX} from "../customData";

export type ExpectedScene = {
  ids?: string[];
  elements?: Array<{ id: string; type?: string; label?: string; text?: string }>;
  edges?: Array<{ from: string; to: string; label?: string }>;
  frames?: string[];
  textMatch?: "exact" | "normalized";
};

const normalize = (value: string, mode: "exact" | "normalized"): string =>
  mode === "exact" ? value : value.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();

// Compare a board against what a spec says must be on it (I25/I15 check):
// missing ids, wrong type or text, missing edges and frames.
export const checkExpected = (
  elements: ReadonlyMap<string, ExcalidrawElement>,
  expected: ExpectedScene,
): LintFinding[] => {
  const mode = expected.textMatch ?? "normalized";
  const live = new Map<string, ExcalidrawElement>();
  const labelOf = new Map<string, ExcalidrawElement>();
  for (const element of elements.values()) {
    if (element.isDeleted) continue;
    live.set(element.id, element);
    const containerId = asText(element).containerId;
    if (element.type === "text" && typeof containerId === "string") labelOf.set(containerId, element);
  }
  const textOf = (element: ExcalidrawElement): string => {
    const source = element.type === "text" ? element : labelOf.get(element.id);
    return source ? String(asText(source).originalText ?? asText(source).text ?? "") : "";
  };
  const resolve = (id: string): ExcalidrawElement | undefined =>
    live.get(id) ??
    (id.endsWith(LABEL_ID_SUFFIX) ? labelOf.get(id.slice(0, -LABEL_ID_SUFFIX.length)) : undefined);
  const findings: LintFinding[] = [];
  const missing = (id: string) => {
    const tombstone = elements.get(id);
    findings.push({
      code: "expected_missing",
      severity: "error",
      elementIds: [id],
      message: `${id} is expected but not on the board${tombstone?.isDeleted ? " (it was deleted; restore can bring it back)" : ""}.`,
      suggestion: (tombstone?.isDeleted
        ? { tool: "restore", args: { ids: [id] }, risk: "review" }
        : { reason: "create it (batch_create) — the server cannot guess its geometry" }),
    });
  };
  for (const id of expected.ids ?? []) {
    if (!resolve(id)) missing(id);
  }
  for (const spec of expected.elements ?? []) {
    const element = resolve(spec.id);
    if (!element) {
      missing(spec.id);
      continue;
    }
    if (spec.type && element.type !== spec.type) {
      findings.push({
        code: "expected_mismatch",
        severity: "error",
        elementIds: [element.id],
        message: `${spec.id} is a ${element.type}, expected ${spec.type}.`,
        suggestion: { tool: "update_elements", args: { elements: [{ id: element.id, type: spec.type }] }, risk: "review" },
      });
    }
    const wanted = spec.label ?? spec.text;
    if (wanted !== undefined && normalize(textOf(element), mode) !== normalize(wanted, mode)) {
      findings.push({
        code: "expected_mismatch",
        severity: "error",
        elementIds: [element.id],
        message: `${spec.id} reads "${textOf(element)}", expected "${wanted}".`,
        suggestion: {
          tool: "update_elements",
          args: { elements: [element.type === "text" ? { id: element.id, text: wanted } : { id: element.id, label: wanted }] },
          risk: "safe",
        },
      });
    }
  }
  const arrows = [...live.values()].filter(isLinear);
  for (const edge of expected.edges ?? []) {
    const from = resolve(edge.from)?.id ?? edge.from;
    const to = resolve(edge.to)?.id ?? edge.to;
    const match = arrows.find((arrow) => {
      const linear = asLinear(arrow);
      return linear.startBinding?.elementId === from && linear.endBinding?.elementId === to;
    });
    if (!match) {
      findings.push({
        code: "expected_edge_missing",
        severity: "error",
        elementIds: [from, to].filter((id) => live.has(id)),
        message: `No arrow from ${edge.from} to ${edge.to}.`,
        suggestion: { reason: `create it: batch_create {type:"arrow", fromId:"${from}", toId:"${to}"}` },
      });
      continue;
    }
    if (edge.label !== undefined && normalize(textOf(match), mode) !== normalize(edge.label, mode)) {
      findings.push({
        code: "expected_mismatch",
        severity: "error",
        elementIds: [match.id],
        message: `Arrow ${match.id} (${edge.from} → ${edge.to}) reads "${textOf(match)}", expected "${edge.label}".`,
        suggestion: { tool: "update_elements", args: { elements: [{ id: match.id, label: edge.label }] }, risk: "safe" },
      });
    }
  }
  const frameNames = new Set(
    [...live.values()]
      .filter((element) => element.type === "frame")
      .map((element) => normalize(String(element.name ?? ""), mode)),
  );
  for (const name of expected.frames ?? []) {
    if (!frameNames.has(normalize(name, mode))) {
      findings.push({
        code: "expected_frame_missing",
        severity: "error",
        elementIds: [],
        message: `No frame named "${name}".`,
        suggestion: { reason: "create it with create_frame" },
      });
    }
  }
  return findings;
};
