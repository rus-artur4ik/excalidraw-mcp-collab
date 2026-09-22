import {generateKeyBetween} from "fractional-indexing";

import type {ExcalidrawElement} from "../types";
import {buildNewElement} from "../elements";
import {customDataOf, ELEMENT_KINDS} from "../customData";
import {isRoleName, resolveRole, resolveSurface, ROLE_NAMES, SURFACE_NAMES} from "../verify/styles";
import {invalidArgs} from "./errors";
import type {SceneTxn} from "./txn";

const indexKey = (element: ExcalidrawElement): string =>
  typeof element.index === "string" ? element.index : "";

// A fractional index strictly between `element` and whatever sits directly
// above it, so a label lands right over its container (not on top of the board).
export const indexJustAbove = (txn: SceneTxn, element: ExcalidrawElement): string => {
  const own = indexKey(element);
  let upper: string | null = null;
  for (const other of txn.all()) {
    const key = indexKey(other);
    if (other.id !== element.id && key > own && (upper === null || key < upper)) {
      upper = key;
    }
  }
  try {
    return generateKeyBetween(own || null, upper);
  } catch {
    return generateKeyBetween(own || null, null);
  }
};

export type NewElementOptions = {
  // Keep a revived tombstone's stacking/frame/group unless the caller set them.
  inherit?: boolean;
};

// Create (or revive) one element inside the transaction. A revived id takes
// the tombstone's version + 1: a fresh version 1 would lose the version race
// against the stored tombstone and silently vanish on the next reload.
export const putNewElement = (
  txn: SceneTxn,
  attrs: Partial<ExcalidrawElement> & { type: string },
  options: NewElementOptions = { inherit: true },
): ExcalidrawElement => {
  let element = buildNewElement(attrs, txn.all());
  const previous = typeof attrs.id === "string" ? txn.get(attrs.id) : undefined;
  if (previous) {
    if (!previous.isDeleted) {
      throw invalidArgs(`element ${attrs.id} already exists`, { ids: [attrs.id as string] });
    }
    const inherit = options.inherit !== false;
    const frame =
      typeof previous.frameId === "string" ? txn.live(previous.frameId) : undefined;
    element = {
      ...element,
      version: previous.version + 1,
      ...(inherit && attrs.index === undefined && typeof previous.index === "string"
        ? { index: previous.index }
        : {}),
      ...(inherit && attrs.frameId === undefined && frame ? { frameId: frame.id } : {}),
      ...(inherit && attrs.groupIds === undefined && previous.groupIds?.length
        ? { groupIds: previous.groupIds }
        : {}),
    };
    if (!txn.report.created.has(element.id)) {
      txn.report.revived.set(element.id, previous.version);
    }
  } else {
    txn.report.created.add(element.id);
  }
  txn.report.forceWin.add(element.id);
  txn.put(element);
  return element;
};

export type StyleInput = {
  role?: unknown;
  tone?: unknown;
  surface?: unknown;
  strokeColor?: unknown;
  backgroundColor?: unknown;
  labelColor?: unknown;
};

export type ResolvedStyle = {
  strokeColor?: string;
  backgroundColor?: string;
  labelColor?: string;
  role?: string;
  tone?: string;
  surface?: string;
};

// Role (optionally in its subtle tone) or surface colors for a shape (fill +
// stroke, label color for its text) or for a standalone text (its text color
// is the role's label color — a role's stroke is often too light as text).
// Explicit colors win.
export const roleStyle = (type: string, input: StyleInput): ResolvedStyle => {
  const explicit = (value: unknown): string | undefined =>
    typeof value === "string" ? value : undefined;
  if (input.surface !== undefined && input.surface !== null) {
    if (input.role !== undefined && input.role !== null) {
      throw invalidArgs("role and surface are mutually exclusive", { field: "surface" });
    }
    const surface = resolveSurface(String(input.surface));
    if (!surface) {
      throw invalidArgs(`unknown surface "${String(input.surface)}"; valid surfaces: ${SURFACE_NAMES.join(", ")}`, {
        field: "surface",
      });
    }
    if (type === "text") {
      return { surface: String(input.surface), strokeColor: explicit(input.strokeColor) ?? surface.textColor };
    }
    return {
      surface: String(input.surface),
      strokeColor: explicit(input.strokeColor) ?? surface.strokeColor,
      backgroundColor: explicit(input.backgroundColor) ?? surface.backgroundColor,
      labelColor: explicit(input.labelColor) ?? surface.textColor,
    };
  }
  if (input.role === undefined || input.role === null) {
    return {};
  }
  if (typeof input.role !== "string" || !isRoleName(input.role)) {
    throw invalidArgs(`unknown role "${String(input.role)}"; valid roles: ${ROLE_NAMES.join(", ")}`, {
      field: "role",
    });
  }
  const tone = input.tone === undefined || input.tone === null ? "solid" : String(input.tone);
  if (tone !== "solid" && tone !== "subtle") {
    throw invalidArgs(`unknown tone "${tone}"; valid tones: solid, subtle`, { field: "tone" });
  }
  const role = resolveRole(input.role, tone);
  if (!role) {
    return {};
  }
  const toneTag = tone === "subtle" ? { tone } : {};
  if (type === "text") {
    return {
      role: input.role,
      ...toneTag,
      strokeColor: explicit(input.strokeColor) ?? role.labelColor,
    };
  }
  return {
    role: input.role,
    ...toneTag,
    strokeColor: explicit(input.strokeColor) ?? role.strokeColor,
    backgroundColor: explicit(input.backgroundColor) ?? role.backgroundColor,
    labelColor: explicit(input.labelColor) ?? role.labelColor,
  };
};

export const assertKind = (value: unknown): void => {
  if (value !== undefined && value !== null && !(ELEMENT_KINDS as readonly unknown[]).includes(value)) {
    throw invalidArgs(`unknown kind "${String(value)}"; valid kinds: ${ELEMENT_KINDS.join(", ")}`, {
      field: "kind",
    });
  }
};

// Server annotations that live in customData (kind, role, slot, lintIgnore,
// protected), merged over whatever customData the element already carries.
export const mergedCustomData = (
  base: ExcalidrawElement | undefined,
  attrs: Record<string, unknown>,
  style?: ResolvedStyle,
): Record<string, unknown> | undefined => {
  const keys = ["kind", "slot", "lintIgnore", "protected"] as const;
  const styled = !!style && (style.role !== undefined || style.surface !== undefined);
  const touches =
    keys.some((key) => key in attrs) || styled || attrs.customData !== undefined;
  if (!touches) {
    return undefined;
  }
  assertKind(attrs.kind);
  const next: Record<string, unknown> = {
    ...(base ? customDataOf(base) : {}),
    ...((attrs.customData as Record<string, unknown> | undefined) ?? {}),
  };
  for (const key of keys) {
    if (!(key in attrs)) {
      continue;
    }
    const value = attrs[key];
    if (value === null || value === undefined || value === false) {
      delete next[key];
    } else {
      next[key] = value;
    }
  }
  if (styled) {
    // One palette source per element: a role replaces a surface and vice versa.
    delete next.role;
    delete next.tone;
    delete next.surface;
    if (style?.role !== undefined) next.role = style.role;
    if (style?.tone !== undefined) next.tone = style.tone;
    if (style?.surface !== undefined) next.surface = style.surface;
  }
  return next;
};

export const pickDefined = <T extends Record<string, unknown>>(value: T): Partial<T> => {
  const result: Partial<T> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) {
      (result as Record<string, unknown>)[key] = entry;
    }
  }
  return result;
};

const STYLE_FIELDS = [
  "strokeColor",
  "backgroundColor",
  "fillStyle",
  "strokeWidth",
  "strokeStyle",
  "roughness",
  "opacity",
  "roundness",
] as const;

// `styleFrom: <id>` fills every style field the item does not set itself from
// another element (and its label's font, alignment and color).
export const expandStyleFrom = <T extends Record<string, unknown>>(
  txn: SceneTxn,
  item: T,
  labelOf: (element: ExcalidrawElement) => ExcalidrawElement | undefined,
): T => {
  const sourceId = item.styleFrom;
  if (typeof sourceId !== "string") {
    return item;
  }
  const source = txn.live(sourceId);
  if (!source) {
    throw invalidArgs(`styleFrom: element ${sourceId} not found`, { ids: [sourceId], field: "styleFrom" });
  }
  const next: Record<string, unknown> = { ...item };
  delete next.styleFrom;
  for (const key of STYLE_FIELDS) {
    if (next[key] === undefined && source[key] !== undefined) {
      next[key] = source[key];
    }
  }
  const label = source.type === "text" ? source : labelOf(source);
  if (label) {
    const view = label as Record<string, unknown>;
    const pairs: Array<[string, string]> =
      source.type === "text"
        ? [["fontSize", "fontSize"], ["fontFamily", "fontFamily"], ["textAlign", "textAlign"]]
        : [["labelFontSize", "fontSize"], ["labelFontFamily", "fontFamily"], ["textAlign", "textAlign"], ["verticalAlign", "verticalAlign"], ["labelColor", "strokeColor"]];
    for (const [target, from] of pairs) {
      if (next[target] === undefined && view[from] !== undefined) {
        next[target] = view[from];
      }
    }
  }
  const custom = source.customData as { role?: unknown; tone?: unknown; surface?: unknown } | undefined;
  if (next.role === undefined && next.surface === undefined && typeof custom?.role === "string") {
    next.role = custom.role;
    if (custom.tone !== undefined && next.tone === undefined) next.tone = custom.tone;
  }
  return next as T;
};
