import type {ExcalidrawElement} from "../types";
import {type BoardProfile, fontSizeFor, resolveProfile} from "../profile";
import {customDataOf, tableRefOf} from "../customData";
import {BOUND_TEXT_PADDING, DEFAULT_FONT_FAMILY, isFrameLike} from "../verify/model";
import {
  isRoleName,
  isSurfaceName,
  resolveRole,
  ROLE_NAMES,
  SURFACE_NAMES,
  SURFACES,
  type SurfaceName,
} from "../verify/styles";
import {
  assertKey,
  AUTO_WIDTH_SLACK,
  boundLabelsOf,
  elementBounds,
  labelTextOf,
  liveById,
  measureBlock,
  orphanLabelIds,
  outerGroupIds,
  staleIds,
} from "./common";
import type {ComposePlan, PlanBounds, PlannedItem} from "./types";

export type TableAlign = "left" | "center" | "right";
export type TableVerticalAlign = "top" | "middle" | "bottom";
export type TableTextRole = "text" | "code" | "mark" | "number";
export type TableNumbering = "1." | "A" | false;

// A cell's role is a text role (text|code|mark|number) or a palette role name.
export type TableCellInput = string | { text: string; role?: string };

export type TableColumnInput = {
  key: string;
  header?: string;
  width?: "auto" | number;
  minWidth?: number;
  maxWidth?: number;
  align?: TableAlign;
  role?: TableTextRole;
};

export type TableRowInput = {
  key: string;
  cells?: Record<string, TableCellInput>;
  // Text role or palette role for every cell of the row.
  role?: string;
  // Row key to insert/move this row after; "_h" puts it first.
  after?: string;
};

export type TableRowGroupInput = { label: string; rows: string[] };

export type TableStyleInput = {
  header?: { surface?: SurfaceName };
  zebra?: { every?: number; surface?: SurfaceName } | false;
  border?: "outer" | "none";
  rowRules?: "hairline" | "none";
  columnRules?: boolean;
};

export type TableSpecInput = {
  origin?: { x: number; y: number };
  frameId?: string;
  columns?: TableColumnInput[];
  rows?: TableRowInput[];
  rowOrder?: string[];
  rowGroups?: TableRowGroupInput[];
  headerRow?: boolean;
  numbered?: TableNumbering;
  fontSize?: number;
  // Header cells only; defaults to fontSize, or to the profile's colHeader step.
  headerFontSize?: number;
  fontFamily?: number;
  cellPadding?: { x?: number; y?: number };
  rowMinHeight?: number;
  verticalAlign?: TableVerticalAlign;
  tableStyle?: TableStyleInput;
  prune?: boolean;
  removeRows?: string[];
};

export type StoredTableRow = {
  key: string;
  cells: Record<string, TableCellInput>;
  role?: string;
};

export type StoredTableStyle = {
  header: { surface: SurfaceName };
  zebra: { every: number; surface: SurfaceName } | false;
  border: "outer" | "none";
  rowRules: "hairline" | "none";
  columnRules: boolean;
};

// The merged spec as stored in the root's customData.tableSpec.
export type StoredTableSpec = {
  version: 1;
  columns: TableColumnInput[];
  rows: StoredTableRow[];
  rowGroups: TableRowGroupInput[];
  headerRow: boolean;
  numbered: TableNumbering;
  // Left unset the table follows the board profile (and, without one, the
  // built-in defaults); a value here is a size this table pins for itself.
  fontSize?: number;
  headerFontSize?: number;
  fontFamily: number;
  cellPadding?: { x: number; y: number };
  rowMinHeight: number;
  verticalAlign: TableVerticalAlign;
  tableStyle: StoredTableStyle;
};

export type TablePlan = ComposePlan & {
  spec: StoredTableSpec;
  // rowKey ("_h" for the header) → colKey ("_n" for the number column) → element id.
  cells: Record<string, Record<string, string>>;
};

export const HEADER_ROW_KEY = "_h";
export const NUMBER_COLUMN_KEY = "_n";

const RESERVED_KEYS = new Set([HEADER_ROW_KEY, NUMBER_COLUMN_KEY]);
const TEXT_ROLES = new Set<string>(["text", "code", "mark", "number"]);
const CODE_FONT_FAMILY = 3;
const MIN_AUTO_CONTENT_RATIO = 1; // an empty auto column is still one em wide
const MIN_CONTENT_WIDTH = 8;
const FRAME_INSET = 40;
const FRAME_CONTENT_GAP = 32;
const DEFAULT_FONT_SIZE = 16;
const DEFAULT_CELL_PADDING = { x: 12, y: 8 };
const DIVIDER_WIDTH = 1;

const DEFAULT_TABLE_STYLE: StoredTableStyle = {
  header: { surface: "header" },
  zebra: false,
  border: "outer",
  rowRules: "hairline",
  columnRules: false,
};

const emptySpec = (): StoredTableSpec => ({
  version: 1,
  columns: [],
  rows: [],
  rowGroups: [],
  headerRow: true,
  numbered: false,
  fontFamily: DEFAULT_FONT_FAMILY,
  rowMinHeight: 0,
  verticalAlign: "top",
  tableStyle: { ...DEFAULT_TABLE_STYLE },
});

export const tableCellId = (tableId: string, rowKey: string, colKey: string): string =>
  `${tableId}:${rowKey}:${colKey}`;

const tableGroupId = (tableId: string): string => `${tableId}:group`;

const cellParts = (value: TableCellInput | undefined): { text: string; role?: string } =>
  value === undefined
    ? { text: "" }
    : typeof value === "string"
      ? { text: value }
      : { text: String(value.text ?? ""), ...(value.role ? { role: value.role } : {}) };

const assertRole = (role: string | undefined, where: string): void => {
  if (role === undefined || TEXT_ROLES.has(role) || isRoleName(role)) {
    return;
  }
  throw new Error(
    `unknown role "${role}" on ${where}; use text, code, mark, number or a palette role (${ROLE_NAMES.join(", ")})`,
  );
};

const assertSurface = (surface: unknown, where: string): SurfaceName | undefined => {
  if (surface === undefined) {
    return undefined;
  }
  if (!isSurfaceName(surface)) {
    throw new Error(
      `unknown surface "${String(surface)}" for ${where}; valid surfaces: ${SURFACE_NAMES.join(", ")}`,
    );
  }
  return surface;
};

const assertPositive = (value: unknown, what: string, allowZero = false): number | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (!allowZero && value === 0)) {
    throw new Error(`${what} must be a ${allowZero ? "non-negative" : "positive"} number`);
  }
  return value;
};

const cloneSpec = (spec: StoredTableSpec): StoredTableSpec =>
  JSON.parse(JSON.stringify(spec)) as StoredTableSpec;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

// Tolerates older or hand-edited specs: anything missing falls back to defaults.
const parseStoredSpec = (raw: unknown): StoredTableSpec | undefined => {
  if (!isRecord(raw) || !Array.isArray(raw.columns) || !Array.isArray(raw.rows)) {
    return undefined;
  }
  const defaults = emptySpec();
  const style = isRecord(raw.tableStyle) ? raw.tableStyle : {};
  return cloneSpec({
    ...defaults,
    ...(raw as Partial<StoredTableSpec>),
    version: 1,
    rowGroups: Array.isArray(raw.rowGroups) ? (raw.rowGroups as TableRowGroupInput[]) : [],
    ...(isRecord(raw.cellPadding) ? { cellPadding: { ...DEFAULT_CELL_PADDING, ...raw.cellPadding } } : {}),
    tableStyle: { ...defaults.tableStyle, ...(style as Partial<StoredTableStyle>) },
  });
};

export const readTableSpec = (
  live: readonly ExcalidrawElement[],
  tableId: string,
): StoredTableSpec | undefined => {
  const root = liveById(live).get(tableId);
  return root ? parseStoredSpec(customDataOf(root).tableSpec) : undefined;
};

// The board is the source of truth for text: a cell retyped in the browser or
// through update_elements must survive the next set_table call.
const refreshTextsFromLive = (
  spec: StoredTableSpec,
  tableId: string,
  byId: Map<string, ExcalidrawElement>,
  live: readonly ExcalidrawElement[],
): void => {
  const liveText = (id: string): string | undefined => {
    const cell = byId.get(id);
    if (!cell) {
      return undefined;
    }
    const [label] = boundLabelsOf(cell, live);
    return label ? labelTextOf(label) : "";
  };
  if (spec.headerRow) {
    for (const column of spec.columns) {
      const text = liveText(tableCellId(tableId, HEADER_ROW_KEY, column.key));
      if (text !== undefined && text !== (column.header ?? "")) {
        column.header = text;
      }
    }
  }
  for (const row of spec.rows) {
    for (const column of spec.columns) {
      const text = liveText(tableCellId(tableId, row.key, column.key));
      const stored = row.cells[column.key];
      if (text === undefined || text === cellParts(stored).text) {
        continue;
      }
      row.cells[column.key] =
        stored && typeof stored === "object" ? { ...stored, text } : text;
    }
  }
};

const mergeColumns = (spec: StoredTableSpec, input: TableSpecInput): void => {
  if (!input.columns) {
    return;
  }
  const seen = new Set<string>();
  for (const column of input.columns) {
    const key = assertKey(column?.key, "column");
    if (RESERVED_KEYS.has(key)) {
      throw new Error(`column key "${key}" is reserved`);
    }
    if (seen.has(key)) {
      throw new Error(`column "${key}" is listed twice`);
    }
    seen.add(key);
    if (column.width !== undefined && column.width !== "auto") {
      assertPositive(column.width, `width of column "${key}"`);
    }
    assertPositive(column.minWidth, `minWidth of column "${key}"`, true);
    assertPositive(column.maxWidth, `maxWidth of column "${key}"`);
    assertRole(column.role, `column "${key}"`);
    if (column.role && !TEXT_ROLES.has(column.role)) {
      throw new Error(`column "${key}" role must be one of text, code, mark, number`);
    }
    const existing = spec.columns.find((candidate) => candidate.key === key);
    const defined = Object.fromEntries(
      Object.entries(column).filter(([, value]) => value !== undefined),
    ) as TableColumnInput;
    if (existing) {
      Object.assign(existing, defined);
    } else {
      spec.columns.push({ ...defined });
    }
  }
  if (input.prune) {
    spec.columns = spec.columns.filter((column) => seen.has(column.key));
    for (const row of spec.rows) {
      for (const colKey of Object.keys(row.cells)) {
        if (!seen.has(colKey)) {
          delete row.cells[colKey];
        }
      }
    }
  }
};

const mergeRows = (spec: StoredTableSpec, input: TableSpecInput): void => {
  const removed = new Set(input.removeRows ?? []);
  spec.rows = spec.rows.filter((row) => !removed.has(row.key));
  if (!input.rows) {
    return;
  }
  const columnKeys = new Set(spec.columns.map((column) => column.key));
  const seen = new Set<string>();
  // Several rows inserted after the same key keep the order of the call.
  const lastInsertedAfter = new Map<string, string>();
  for (const rowInput of input.rows) {
    const key = assertKey(rowInput?.key, "row");
    if (RESERVED_KEYS.has(key)) {
      throw new Error(`row key "${key}" is reserved`);
    }
    if (seen.has(key)) {
      throw new Error(`row "${key}" is listed twice`);
    }
    if (removed.has(key)) {
      throw new Error(`row "${key}" is both in rows and removeRows`);
    }
    seen.add(key);
    assertRole(rowInput.role, `row "${key}"`);
    const cells = rowInput.cells ?? {};
    for (const [colKey, value] of Object.entries(cells)) {
      if (!columnKeys.has(colKey)) {
        throw new Error(
          `row "${key}" has a cell for unknown column "${colKey}"; known columns: ${[...columnKeys].join(", ") || "none"}`,
        );
      }
      if (typeof value !== "string" && !(isRecord(value) && typeof value.text === "string")) {
        throw new Error(`cell "${key}"/"${colKey}" must be a string or {text, role?}`);
      }
      if (typeof value !== "string") {
        assertRole(value.role, `cell "${key}"/"${colKey}"`);
      }
    }
    const index = spec.rows.findIndex((row) => row.key === key);
    const row: StoredTableRow =
      index >= 0 ? spec.rows[index] : { key, cells: {} };
    row.cells = { ...row.cells, ...cells };
    if (rowInput.role !== undefined) {
      row.role = rowInput.role;
    }
    if (index >= 0 && rowInput.after === undefined) {
      continue;
    }
    if (index >= 0) {
      spec.rows.splice(index, 1);
    }
    let at = spec.rows.length;
    if (rowInput.after !== undefined) {
      if (rowInput.after === key) {
        throw new Error(`row "${key}" cannot be placed after itself`);
      }
      const anchor = lastInsertedAfter.get(rowInput.after) ?? rowInput.after;
      if (anchor === HEADER_ROW_KEY) {
        at = 0;
      } else {
        const anchorIndex = spec.rows.findIndex((candidate) => candidate.key === anchor);
        if (anchorIndex < 0) {
          throw new Error(`row "${key}" is placed after unknown row "${rowInput.after}"`);
        }
        at = anchorIndex + 1;
      }
      lastInsertedAfter.set(rowInput.after, key);
    }
    spec.rows.splice(at, 0, row);
  }
  if (input.prune) {
    spec.rows = spec.rows.filter((row) => seen.has(row.key));
  }
};

const applyRowOrder = (spec: StoredTableSpec, rowOrder: string[] | undefined): void => {
  if (!rowOrder) {
    return;
  }
  const byKey = new Map(spec.rows.map((row) => [row.key, row]));
  const ordered: StoredTableRow[] = [];
  for (const key of rowOrder) {
    const row = byKey.get(key);
    if (!row) {
      throw new Error(`rowOrder names unknown row "${key}"`);
    }
    if (!ordered.includes(row)) {
      ordered.push(row);
    }
  }
  spec.rows = [...ordered, ...spec.rows.filter((row) => !ordered.includes(row))];
};

const mergeScalars = (spec: StoredTableSpec, input: TableSpecInput): void => {
  if (input.headerRow !== undefined) {
    spec.headerRow = input.headerRow;
  }
  if (input.numbered !== undefined) {
    if (input.numbered !== false && input.numbered !== "1." && input.numbered !== "A") {
      throw new Error(`numbered must be "1.", "A" or false`);
    }
    spec.numbered = input.numbered;
  }
  spec.fontSize = assertPositive(input.fontSize, "fontSize") ?? spec.fontSize;
  spec.headerFontSize = assertPositive(input.headerFontSize, "headerFontSize") ?? spec.headerFontSize;
  spec.fontFamily = assertPositive(input.fontFamily, "fontFamily") ?? spec.fontFamily;
  spec.rowMinHeight = assertPositive(input.rowMinHeight, "rowMinHeight", true) ?? spec.rowMinHeight;
  if (input.cellPadding) {
    const previous = spec.cellPadding ?? DEFAULT_CELL_PADDING;
    spec.cellPadding = {
      x: assertPositive(input.cellPadding.x, "cellPadding.x", true) ?? previous.x,
      y: assertPositive(input.cellPadding.y, "cellPadding.y", true) ?? previous.y,
    };
  }
  if (input.verticalAlign !== undefined) {
    if (!["top", "middle", "bottom"].includes(input.verticalAlign)) {
      throw new Error(`verticalAlign must be top, middle or bottom`);
    }
    spec.verticalAlign = input.verticalAlign;
  }
  const style = input.tableStyle;
  if (style) {
    if (style.header) {
      spec.tableStyle.header = {
        surface: assertSurface(style.header.surface, "the header") ?? spec.tableStyle.header.surface,
      };
    }
    if (style.zebra === false) {
      spec.tableStyle.zebra = false;
    } else if (style.zebra) {
      const previous = spec.tableStyle.zebra || { every: 2, surface: "subtle" as SurfaceName };
      const every = assertPositive(style.zebra.every, "zebra.every") ?? previous.every;
      spec.tableStyle.zebra = {
        every: Math.max(1, Math.round(every)),
        surface: assertSurface(style.zebra.surface, "zebra rows") ?? previous.surface,
      };
    }
    if (style.border !== undefined) {
      spec.tableStyle.border = style.border === "none" ? "none" : "outer";
    }
    if (style.rowRules !== undefined) {
      spec.tableStyle.rowRules = style.rowRules === "none" ? "none" : "hairline";
    }
    if (style.columnRules !== undefined) {
      spec.tableStyle.columnRules = !!style.columnRules;
    }
  }
};

const mergeRowGroups = (spec: StoredTableSpec, input: TableSpecInput): void => {
  const rowKeys = new Set(spec.rows.map((row) => row.key));
  if (input.rowGroups) {
    spec.rowGroups = input.rowGroups.map((group, index) => {
      if (!isRecord(group) || typeof group.label !== "string" || !Array.isArray(group.rows)) {
        throw new Error(`rowGroups[${index}] must be {label, rows}`);
      }
      for (const key of group.rows) {
        if (!rowKeys.has(key)) {
          throw new Error(`rowGroups[${index}] ("${group.label}") names unknown row "${key}"`);
        }
      }
      return { label: group.label, rows: [...group.rows] };
    });
  }
  // Rows removed later leave their groups; a group without rows disappears.
  spec.rowGroups = spec.rowGroups
    .map((group) => ({ ...group, rows: group.rows.filter((key) => rowKeys.has(key)) }))
    .filter((group) => group.rows.length > 0);
};

export const mergeTableSpec = (
  base: StoredTableSpec | undefined,
  input: TableSpecInput,
): StoredTableSpec => {
  const spec = base ? cloneSpec(base) : emptySpec();
  mergeScalars(spec, input);
  mergeColumns(spec, input);
  mergeRows(spec, input);
  applyRowOrder(spec, input.rowOrder);
  mergeRowGroups(spec, input);
  return spec;
};

const numberLabel = (index: number, style: TableNumbering): string => {
  if (style === "A") {
    let n = index + 1;
    let label = "";
    while (n > 0) {
      const rem = (n - 1) % 26;
      label = String.fromCharCode(65 + rem) + label;
      n = Math.floor((n - 1) / 26);
    }
    return label;
  }
  return `${index + 1}.`;
};

type ColumnLayout = {
  key: string;
  header: string;
  align: TableAlign;
  role: TableTextRole;
  spec?: TableColumnInput;
  x: number;
  width: number;
};

type CellLayout = {
  text: string;
  fontSize: number;
  fontFamily: number;
  align: TableAlign;
  labelColor: string;
  paletteRole?: string;
};

type Band =
  | { kind: "header"; y: number; height: number }
  | { kind: "group"; y: number; height: number; index: number; label: string }
  | { kind: "row"; y: number; height: number; row: StoredTableRow; ordinal: number };

const columnAlign = (column: TableColumnInput | undefined, key: string): TableAlign => {
  if (key === NUMBER_COLUMN_KEY) {
    return "right";
  }
  if (column?.align) {
    return column.align;
  }
  return column?.role === "number" ? "right" : column?.role === "mark" ? "center" : "left";
};

const resolveOrigin = (
  tableId: string,
  input: { spec: TableSpecInput },
  root: ExcalidrawElement | undefined,
  frame: ExcalidrawElement | undefined,
  byId: Map<string, ExcalidrawElement>,
  profile: BoardProfile | null | undefined,
): { x: number; y: number } => {
  if (input.spec?.origin) {
    return { x: input.spec.origin.x, y: input.spec.origin.y };
  }
  if (root) {
    return { x: root.x, y: root.y };
  }
  if (frame) {
    // Below whatever the frame already holds, so a new table never lands on content.
    let bottom = -Infinity;
    for (const element of byId.values()) {
      if (element.frameId === frame.id && !element.id.startsWith(`${tableId}:`)) {
        const b = elementBounds(element);
        bottom = Math.max(bottom, b.y + b.height);
      }
    }
    const { frameInset, blockGap } = profile
      ? resolveProfile(profile).spacing
      : { frameInset: FRAME_INSET, blockGap: FRAME_CONTENT_GAP };
    return {
      x: frame.x + frameInset,
      y: Number.isFinite(bottom) ? bottom + blockGap : frame.y + frameInset,
    };
  }
  throw new Error(
    `table "${tableId}" does not exist yet: pass spec.origin (or a frameId to place it in) to create it`,
  );
};

export const planTable = (
  input: { tableId: string; spec: TableSpecInput; frameId?: string },
  live: readonly ExcalidrawElement[],
  profile?: BoardProfile | null,
): TablePlan => {
  const { tableId } = input;
  if (typeof tableId !== "string" || !tableId.length) {
    throw new Error("tableId must be a non-empty string");
  }
  const byId = liveById(live);
  const root = byId.get(tableId);
  if (root && (root.type !== "rectangle" || tableRefOf(root)?.tableId !== tableId)) {
    throw new Error(`element "${tableId}" exists and is not a table; pick another tableId`);
  }

  const stored = root ? parseStoredSpec(customDataOf(root).tableSpec) : undefined;
  if (stored) {
    refreshTextsFromLive(stored, tableId, byId, live);
  }
  const spec = mergeTableSpec(stored, input.spec ?? {});
  if (!spec.columns.length) {
    throw new Error(`table "${tableId}" needs at least one column`);
  }

  const requestedFrameId = input.frameId ?? input.spec?.frameId;
  const frame = requestedFrameId ? byId.get(requestedFrameId) : undefined;
  if (requestedFrameId && (!frame || !isFrameLike(frame))) {
    throw new Error(`frame "${requestedFrameId}" not found`);
  }
  const frameId = requestedFrameId ?? root?.frameId ?? null;
  const origin = resolveOrigin(tableId, input, root, frame, byId, profile);

  const groupId = tableGroupId(tableId);
  const groupIds = [groupId, ...outerGroupIds(root, groupId)];
  // Fresh objects per item: the core may mutate what it is handed.
  const common = () => ({
    frameId,
    groupIds: [...groupIds],
    roughness: 0,
    opacity: 100,
    fillStyle: "solid",
    strokeStyle: "solid",
    roundness: null,
  });

  const { fontFamily, verticalAlign } = spec;
  // Sizes the spec pins win; otherwise the board profile sets the body and
  // column-header steps, and without a profile the built-in defaults do. A
  // spec that pins only fontSize keeps headers at that size, as before.
  const fontSize = spec.fontSize ?? (profile ? fontSizeFor(profile, "body") : DEFAULT_FONT_SIZE);
  const headerFontSize =
    spec.headerFontSize ??
    spec.fontSize ??
    (profile ? fontSizeFor(profile, "colHeader") : fontSize);
  const cellPadding =
    spec.cellPadding ??
    (profile
      ? { x: resolveProfile(profile).spacing.cellPadding, y: resolveProfile(profile).spacing.cellPadding }
      : DEFAULT_CELL_PADDING);
  // The client keeps a bound label 5 px inside its container, so the cell box
  // is inset by the rest of the padding; below 5 px the client wins anyway.
  const padX = Math.max(BOUND_TEXT_PADDING, cellPadding.x);
  const padY = Math.max(BOUND_TEXT_PADDING, cellPadding.y);
  const insetX = padX - BOUND_TEXT_PADDING;
  const insetY = padY - BOUND_TEXT_PADDING;
  const baseText = SURFACES.base.textColor;
  const headerSurface = SURFACES[spec.tableStyle.header.surface];

  const columns: ColumnLayout[] = [
    ...(spec.numbered
      ? [
          {
            key: NUMBER_COLUMN_KEY,
            header: "",
            align: "right" as TableAlign,
            role: "text" as TableTextRole,
            x: 0,
            width: 0,
          },
        ]
      : []),
    ...spec.columns.map((column) => ({
      key: column.key,
      header: column.header ?? "",
      align: columnAlign(column, column.key),
      role: column.role ?? "text",
      spec: column,
      x: 0,
      width: 0,
    })),
  ];

  const bodyCell = (row: StoredTableRow, column: ColumnLayout, ordinal: number): CellLayout => {
    if (column.key === NUMBER_COLUMN_KEY) {
      const rowPalette = isRoleName(row.role) ? row.role : undefined;
      return {
        text: numberLabel(ordinal, spec.numbered),
        fontSize,
        fontFamily,
        align: "right",
        labelColor: rowPalette ? resolveRole(rowPalette, "subtle")!.labelColor : baseText,
      };
    }
    const { text, role: cellRole } = cellParts(row.cells[column.key]);
    const textRole =
      [cellRole, row.role].find((role) => role && TEXT_ROLES.has(role)) ?? column.role;
    const paletteRole = [cellRole, row.role].find((role) => isRoleName(role));
    const align = textRole === "mark" ? "center" : textRole === "number" ? "right" : column.align;
    return {
      text,
      fontSize,
      fontFamily: textRole === "code" ? CODE_FONT_FAMILY : fontFamily,
      align,
      labelColor: paletteRole ? resolveRole(paletteRole, "subtle")!.labelColor : baseText,
      ...(paletteRole && paletteRole === cellRole ? { paletteRole } : {}),
    };
  };

  const ordinals = new Map(spec.rows.map((row, index) => [row.key, index]));
  const cellsByRow = new Map(
    spec.rows.map((row) => [
      row.key,
      columns.map((column) => bodyCell(row, column, ordinals.get(row.key)!)),
    ]),
  );
  const headerCells: CellLayout[] = columns.map((column) => ({
    text: column.header,
    fontSize: headerFontSize,
    fontFamily,
    align: column.align,
    labelColor: headerSurface.textColor,
  }));

  // Widths: 'auto' is the widest unwrapped line of the column plus padding.
  let cursorX = origin.x;
  columns.forEach((column, index) => {
    const texts = [
      ...(spec.headerRow ? [headerCells[index]] : []),
      ...spec.rows.map((row) => cellsByRow.get(row.key)![index]),
    ];
    const natural = texts.reduce(
      (max, cell) => Math.max(max, measureBlock(cell.text, cell.fontSize, cell.fontFamily).width),
      0,
    );
    const requested = column.spec?.width;
    let width =
      typeof requested === "number"
        ? requested
        : Math.max(natural, fontSize * MIN_AUTO_CONTENT_RATIO) + 2 * padX + AUTO_WIDTH_SLACK;
    if (typeof column.spec?.minWidth === "number") {
      width = Math.max(width, column.spec.minWidth);
    }
    if (typeof column.spec?.maxWidth === "number") {
      width = Math.min(width, column.spec.maxWidth);
    }
    column.width = Math.ceil(Math.max(width, 2 * padX + MIN_CONTENT_WIDTH));
    column.x = cursorX;
    cursorX += column.width;
  });
  const tableWidth = cursorX - origin.x;

  const rowHeight = (cells: CellLayout[]): number => {
    const tallest = cells.reduce(
      (max, cell, index) =>
        Math.max(
          max,
          measureBlock(cell.text, cell.fontSize, cell.fontFamily, columns[index].width - 2 * padX).height,
        ),
      measureBlock("", cells[0]?.fontSize ?? fontSize, fontFamily).height,
    );
    return Math.ceil(Math.max(tallest + 2 * padY, spec.rowMinHeight));
  };

  // Bands top→bottom: header, then rows with each group's label before its first row.
  const bands: Band[] = [];
  let cursorY = origin.y;
  if (spec.headerRow) {
    const height = rowHeight(headerCells);
    bands.push({ kind: "header", y: cursorY, height });
    cursorY += height;
  }
  const groupStart = new Map<string, number[]>();
  spec.rowGroups.forEach((group, index) => {
    const first = spec.rows.find((row) => group.rows.includes(row.key));
    if (first) {
      groupStart.set(first.key, [...(groupStart.get(first.key) ?? []), index]);
    }
  });
  for (const row of spec.rows) {
    for (const index of groupStart.get(row.key) ?? []) {
      const label = spec.rowGroups[index].label;
      const height = Math.ceil(
        measureBlock(label, fontSize, fontFamily, tableWidth - 2 * padX).height + 2 * padY,
      );
      bands.push({ kind: "group", y: cursorY, height, index, label });
      cursorY += height;
    }
    const height = rowHeight(cellsByRow.get(row.key)!);
    bands.push({ kind: "row", y: cursorY, height, row, ordinal: ordinals.get(row.key)! });
    cursorY += height;
  }
  const tableHeight = cursorY - origin.y;

  const part = (name: "header" | "zebra" | "divider" | "group") => ({
    kind: name === "divider" ? ("divider" as const) : ("table" as const),
    table: { tableId, part: name },
  });

  const rootItem: PlannedItem = {
    ...common(),
    id: tableId,
    type: "rectangle",
    x: origin.x,
    y: origin.y,
    width: tableWidth,
    height: tableHeight,
    backgroundColor: SURFACES.base.backgroundColor,
    strokeColor: spec.tableStyle.border === "outer" ? headerSurface.strokeColor : "transparent",
    strokeWidth: DIVIDER_WIDTH,
    customData: { kind: "table", table: { tableId, part: "root" }, tableSpec: cloneSpec(spec) },
  };

  // Grid boxes: a whole band, or one column's slice of it.
  const bandBox = (band: Band): PlanBounds => ({
    x: origin.x,
    y: band.y,
    width: tableWidth,
    height: band.height,
  });
  const cellBox = (band: Band, column: ColumnLayout): PlanBounds => ({
    x: column.x,
    y: band.y,
    width: column.width,
    height: band.height,
  });

  const fill = (
    id: string,
    box: PlanBounds,
    color: string,
    partName: "header" | "zebra" | "group",
  ): PlannedItem => ({
    ...common(),
    id,
    type: "rectangle",
    ...box,
    backgroundColor: color,
    strokeColor: "transparent",
    strokeWidth: DIVIDER_WIDTH,
    customData: part(partName),
  });

  const rule = (id: string, x: number, y: number, dx: number, dy: number, color: string): PlannedItem => ({
    ...common(),
    id,
    type: "line",
    x,
    y,
    width: dx,
    height: dy,
    points: [
      [0, 0],
      [dx, dy],
    ],
    strokeColor: color,
    backgroundColor: "transparent",
    strokeWidth: DIVIDER_WIDTH,
    startArrowhead: null,
    endArrowhead: null,
    customData: part("divider"),
  });

  const cellItem = (
    id: string,
    box: PlanBounds,
    cell: CellLayout,
    customData: Record<string, unknown>,
  ): PlannedItem => ({
    ...common(),
    id,
    type: "rectangle",
    x: box.x + insetX,
    y: box.y + insetY,
    width: box.width - 2 * insetX,
    height: box.height - 2 * insetY,
    backgroundColor: "transparent",
    strokeColor: "transparent",
    strokeWidth: DIVIDER_WIDTH,
    ...(cell.text.length ? { label: cell.text } : {}),
    labelFontSize: cell.fontSize,
    labelFontFamily: cell.fontFamily,
    labelColor: cell.labelColor,
    textAlign: cell.align,
    verticalAlign,
    customData,
  });

  const backgrounds: PlannedItem[] = [];
  const cellFills: PlannedItem[] = [];
  const groupFills: PlannedItem[] = [];
  const groupLabels: PlannedItem[] = [];
  const cellItems: PlannedItem[] = [];
  const cells: Record<string, Record<string, string>> = {};
  const zebra = spec.tableStyle.zebra;

  for (const band of bands) {
    if (band.kind === "header") {
      backgrounds.push(fill(`${tableId}:hbg`, bandBox(band), headerSurface.backgroundColor, "header"));
      cells[HEADER_ROW_KEY] = {};
      columns.forEach((column, index) => {
        const id = tableCellId(tableId, HEADER_ROW_KEY, column.key);
        cells[HEADER_ROW_KEY][column.key] = id;
        cellItems.push(
          cellItem(id, cellBox(band, column), headerCells[index], {
            kind: "table-cell",
            table: { tableId, row: HEADER_ROW_KEY, col: column.key },
          }),
        );
      });
      continue;
    }
    if (band.kind === "group") {
      groupFills.push(
        fill(`${tableId}:gbg:${band.index}`, bandBox(band), headerSurface.backgroundColor, "group"),
      );
      groupLabels.push(
        cellItem(
          `${tableId}:g:${band.index}`,
          bandBox(band),
          { text: band.label, fontSize, fontFamily, align: "left", labelColor: headerSurface.textColor },
          part("group"),
        ),
      );
      continue;
    }
    const { row } = band;
    const rowPalette = isRoleName(row.role) ? row.role : undefined;
    const zebraColor =
      zebra && (band.ordinal + 1) % zebra.every === 0 ? SURFACES[zebra.surface].backgroundColor : undefined;
    const bandColor = rowPalette ? resolveRole(rowPalette, "subtle")!.backgroundColor : zebraColor;
    if (bandColor) {
      backgrounds.push(fill(`${tableId}:z:${row.key}`, bandBox(band), bandColor, "zebra"));
    }
    cells[row.key] = {};
    const layouts = cellsByRow.get(row.key)!;
    columns.forEach((column, index) => {
      const cell = layouts[index];
      const id = tableCellId(tableId, row.key, column.key);
      cells[row.key][column.key] = id;
      if (cell.paletteRole) {
        cellFills.push(
          fill(
            `${tableId}:z:${row.key}:${column.key}`,
            cellBox(band, column),
            resolveRole(cell.paletteRole, "subtle")!.backgroundColor,
            "zebra",
          ),
        );
      }
      cellItems.push(
        cellItem(id, cellBox(band, column), cell, {
          kind: "table-cell",
          table: { tableId, row: row.key, col: column.key },
        }),
      );
    });
  }

  const columnRules: PlannedItem[] = spec.tableStyle.columnRules
    ? columns.slice(1).map((column, index) =>
        rule(`${tableId}:vr:${index}`, column.x, origin.y, 0, tableHeight, SURFACES.base.strokeColor),
      )
    : [];
  const rowRules: PlannedItem[] = [];
  bands.slice(1).forEach((band, index) => {
    const underHeader = bands[index].kind === "header";
    if (spec.tableStyle.rowRules === "hairline" || underHeader) {
      rowRules.push(
        rule(
          `${tableId}:hr:${rowRules.length}`,
          origin.x,
          band.y,
          tableWidth,
          0,
          underHeader ? headerSurface.strokeColor : SURFACES.base.strokeColor,
        ),
      );
    }
  });

  // Group bands are opaque and sit above the column rules, so a section label
  // reads as one merged row without splitting the vertical lines in pieces.
  const items: PlannedItem[] = [
    rootItem,
    ...backgrounds,
    ...cellFills,
    ...columnRules,
    ...groupFills,
    ...rowRules,
    ...groupLabels,
    ...cellItems,
  ];

  const plannedIds = new Set(items.map((item) => item.id));
  const removeIds = [
    ...staleIds(
      live,
      plannedIds,
      (element) =>
        element.id.startsWith(`${tableId}:`) && tableRefOf(element)?.tableId === tableId,
    ),
    ...orphanLabelIds(items, byId, live),
  ];

  return {
    items,
    removeIds: [...new Set(removeIds)],
    bounds: { x: origin.x, y: origin.y, width: tableWidth, height: tableHeight },
    ...(root ? { previousBounds: elementBounds(root) } : {}),
    spec,
    cells,
  };
};
