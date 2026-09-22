import type {ExcalidrawElement} from "./types";

// customData is the only place Excalidraw preserves unknown data across a
// reload, so every server-side annotation of an element lives here. Keys are
// shared by the write pipeline, the lint and the composite planners.

export const ELEMENT_KINDS = [
  "container",
  "lane",
  "group-frame",
  "legend",
  "table",
  "table-cell",
  "divider",
  "annotation",
  "diagram",
  "callout",
  "badge",
  "code",
] as const;

export type ElementKind = (typeof ELEMENT_KINDS)[number];

export type LintIgnoreEntry = string | { code: string; with?: string[] };

export type TableCellRef = {
  tableId: string;
  row: string;
  col: string;
};

export type TablePartRef = {
  tableId: string;
  part: "root" | "header" | "zebra" | "divider" | "group";
};

export type ServerCustomData = {
  kind?: ElementKind;
  role?: string;
  slot?: string;
  lintIgnore?: LintIgnoreEntry[];
  protected?: boolean;
  table?: TableCellRef | TablePartRef;
  tableSpec?: unknown;
  diagramId?: string;
  legendId?: string;
  order?: number;
};

export const customDataOf = (element: ExcalidrawElement): ServerCustomData => {
  const raw = element.customData;
  return raw && typeof raw === "object" ? (raw as ServerCustomData) : {};
};

export const kindOf = (element: ExcalidrawElement): ElementKind | undefined => {
  const kind = customDataOf(element).kind;
  return typeof kind === "string" &&
    (ELEMENT_KINDS as readonly string[]).includes(kind)
    ? (kind as ElementKind)
    : undefined;
};

export const roleOf = (element: ExcalidrawElement): string | undefined => {
  const role = customDataOf(element).role;
  return typeof role === "string" ? role : undefined;
};

export const slotOf = (element: ExcalidrawElement): string | undefined => {
  const slot = customDataOf(element).slot;
  return typeof slot === "string" ? slot : undefined;
};

export const isProtected = (element: ExcalidrawElement): boolean =>
  customDataOf(element).protected === true;

export const tableRefOf = (
  element: ExcalidrawElement,
): TableCellRef | TablePartRef | undefined => {
  const ref = customDataOf(element).table;
  return ref && typeof ref === "object" && typeof ref.tableId === "string"
    ? ref
    : undefined;
};

export const isTableCellRef = (
  ref: TableCellRef | TablePartRef | undefined,
): ref is TableCellRef =>
  !!ref && typeof (ref as TableCellRef).row === "string";

// Entries may be a bare code (suppresses the rule for every finding touching
// the element) or `{code, with}` (only findings that also involve one of `with`).
export const lintIgnoreEntries = (
  element: ExcalidrawElement,
): Array<{ code: string; with?: string[] }> => {
  const custom = customDataOf(element).lintIgnore;
  const legacy = (element as { lintIgnore?: unknown }).lintIgnore;
  const raw = Array.isArray(custom) ? custom : Array.isArray(legacy) ? legacy : [];
  const entries: Array<{ code: string; with?: string[] }> = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      entries.push({ code: entry });
    } else if (
      entry &&
      typeof entry === "object" &&
      typeof (entry as { code?: unknown }).code === "string"
    ) {
      const withIds = (entry as { with?: unknown }).with;
      entries.push({
        code: (entry as { code: string }).code,
        ...(Array.isArray(withIds)
          ? { with: withIds.filter((id): id is string => typeof id === "string") }
          : {}),
      });
    }
  }
  return entries;
};

export const withCustomData = (
  element: ExcalidrawElement,
  patch: Partial<ServerCustomData>,
): Record<string, unknown> => {
  const next: Record<string, unknown> = { ...customDataOf(element) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null) {
      delete next[key];
    } else {
      next[key] = value;
    }
  }
  return next;
};

// Deterministic, readable ids (I28): a container's bound label is
// `${containerId}:label`, so agents never need to look text ids up.
export const labelIdFor = (containerId: string): string => `${containerId}:label`;

export const LABEL_ID_SUFFIX = ":label";
