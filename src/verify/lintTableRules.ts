import type {ExcalidrawElement} from "../types";
import {isTableCellRef, roleOf, slotOf, tableRefOf} from "../customData";
import type {Bounds} from "./model";
import {boundsContain, getCommonBounds} from "./geometry";
import {
    containerIdOf,
    fontSizeOf,
    layoutLabelIn,
    type LintContext,
    reasonSuggestion,
    standaloneTextBox,
    textContent,
    updateSuggestion,
} from "./lintContext";

const MIN_CELL_PADDING = 4;
const HEIGHT_TOLERANCE = 1;
// "_h" is set_table's header row key.
const HEADER_ROW = /^(?:[_$]{0,2})(?:header|head|th|h)$/i;
const MAX_LISTED = 20;

type Cell = {
  row: string;
  col: string;
  // The element that occupies the cell: its container, or the text itself.
  box: ExcalidrawElement;
  label?: ExcalidrawElement;
};

type Table = {
  id: string;
  cells: Cell[];
  parts: ExcalidrawElement[];
  all: ExcalidrawElement[];
};

const collectTables = (ctx: LintContext): Map<string, Table> => {
  const tables = new Map<string, Table>();
  const table = (id: string): Table => {
    let entry = tables.get(id);
    if (!entry) {
      entry = { id, cells: [], parts: [], all: [] };
      tables.set(id, entry);
    }
    return entry;
  };
  const seen = new Set<string>();
  for (const element of ctx.live) {
    const ref = tableRefOf(element);
    if (!ref) {
      continue;
    }
    const entry = table(ref.tableId);
    entry.all.push(element);
    if (!isTableCellRef(ref)) {
      entry.parts.push(element);
      continue;
    }
    const key = `${ref.tableId}|${ref.row}|${ref.col}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const containerId = containerIdOf(element);
    const container = containerId ? ctx.byId.get(containerId) : undefined;
    if (element.type === "text") {
      entry.cells.push({ row: ref.row, col: ref.col, box: container ?? element, label: element });
    } else {
      entry.cells.push({ row: ref.row, col: ref.col, box: element, label: ctx.labelOf(element) });
    }
  }
  return tables;
};

const center = (element: ExcalidrawElement): [number, number] => [
  element.x + (element.width || 0) / 2,
  element.y + (element.height || 0) / 2,
];

const isHeaderMarked = (element: ExcalidrawElement | undefined): boolean =>
  !!element && [roleOf(element), slotOf(element)].some((value) => value === "header" || value === "table-header");

// Header cells: inside a `part: "header"` band, in a row keyed like
// "header", or marked with role/slot "header".
const headerCellsOf = (table: Table): Set<Cell> => {
  const bands = table.parts.filter((part) => (tableRefOf(part) as { part?: string }).part === "header");
  const headers = new Set<Cell>();
  for (const cell of table.cells) {
    const [cx, cy] = center(cell.box);
    const inBand = bands.some(
      (band) =>
        cx >= band.x && cx <= band.x + (band.width || 0) && cy >= band.y && cy <= band.y + (band.height || 0),
    );
    if (inBand || HEADER_ROW.test(cell.row) || isHeaderMarked(cell.box) || isHeaderMarked(cell.label)) {
      headers.add(cell);
    }
  }
  return headers;
};

const hasText = (cell: Cell): boolean => !!cell.label && !!textContent(cell.label).trim();

const majorityOf = <T>(values: readonly T[]): T => {
  const counts = new Map<T, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
};

const textBoxOf = (cell: Cell): Bounds | null => {
  if (!cell.label || !textContent(cell.label).trim()) {
    return null;
  }
  return cell.box === cell.label ? standaloneTextBox(cell.label) : layoutLabelIn(cell.box, cell.label).box;
};

// Grid lines sit halfway between neighbouring columns/rows and on the
// table's outer edge; padding is measured from the text to them.
const gridLines = (
  groups: Map<string, Cell[]>,
  outer: [number, number],
  axis: "x" | "y",
): Map<string, [number, number]> => {
  const size = axis === "x" ? "width" : "height";
  const spans = [...groups.entries()]
    .map(([key, cells]) => ({
      key,
      start: Math.min(...cells.map((c) => c.box[axis])),
      end: Math.max(...cells.map((c) => c.box[axis] + (c.box[size] || 0))),
    }))
    .sort((a, b) => a.start - b.start);
  const lines = new Map<string, [number, number]>();
  spans.forEach((span, i) => {
    const before = i === 0 ? Math.min(outer[0], span.start) : (spans[i - 1].end + span.start) / 2;
    const after = i === spans.length - 1 ? Math.max(outer[1], span.end) : (span.end + spans[i + 1].start) / 2;
    lines.set(span.key, [before, after]);
  });
  return lines;
};

const groupBy = (cells: readonly Cell[], key: (cell: Cell) => string): Map<string, Cell[]> => {
  const groups = new Map<string, Cell[]>();
  for (const cell of cells) {
    groups.set(key(cell), [...(groups.get(key(cell)) ?? []), cell]);
  }
  return groups;
};

// Returns header-label ids keyed for style_font_size_outlier, so column
// headers are compared across every table of the board.
export const tableRules = (ctx: LintContext): Map<string, string> => {
  const headerKeys = new Map<string, string>();
  const tables = collectTables(ctx);
  for (const table of tables.values()) {
    const headers = headerCellsOf(table);
    for (const cell of headers) {
      if (cell.label) {
        headerKeys.set(cell.label.id, "table-header");
      }
    }
    const touched =
      !ctx.scope ||
      table.all.some((element) => ctx.scope!.has(element.id)) ||
      table.cells.some((cell) => ctx.scope!.has(cell.box.id) || (cell.label && ctx.scope!.has(cell.label.id)));
    if (!touched || !table.cells.length) {
      continue;
    }
    const body = table.cells.filter((cell) => !headers.has(cell));

    if (ctx.on("table_column_without_header") && headers.size) {
      const byCol = groupBy(body.filter(hasText), (cell) => cell.col);
      for (const [col, cells] of byCol) {
        // set_table's number column ("1.", "A") has no header by design.
        if (col === "_n") {
          continue;
        }
        const header = [...headers].find((cell) => cell.col === col);
        if (header && hasText(header)) {
          continue;
        }
        ctx.emit({
          code: "table_column_without_header",
          severity: "warning",
          elementIds: [...(header ? [header.box.id] : []), ...cells.slice(0, MAX_LISTED).map((cell) => cell.box.id)],
          kind: col,
          message: `Column "${col}" of table ${table.id} has ${cells.length} filled cell${cells.length > 1 ? "s" : ""} but ${header ? "an empty" : "no"} header.`,
          suggestion: reasonSuggestion(
            header
              ? `Give the header a label: update_elements {id: "${header.box.id}", label: "…"} or set_table columns:[{key: "${col}", header: "…"}].`
              : `Add a header: set_table for ${table.id} with columns:[{key: "${col}", header: "…"}].`,
          ),
        });
      }
    }

    if (ctx.on("table_row_height_inconsistent")) {
      for (const [row, cells] of groupBy(table.cells, (cell) => cell.row)) {
        const boxes = cells.filter((cell) => cell.box.type !== "text");
        if (boxes.length < 2) {
          continue;
        }
        const heights = boxes.map((cell) => cell.box.height || 0);
        const tallest = Math.max(...heights);
        if (tallest - Math.min(...heights) <= HEIGHT_TOLERANCE) {
          continue;
        }
        const top = Math.min(...boxes.map((cell) => cell.box.y));
        const patches = boxes
          .filter((cell) => Math.abs((cell.box.height || 0) - tallest) > HEIGHT_TOLERANCE || Math.abs(cell.box.y - top) > HEIGHT_TOLERANCE)
          .map((cell) => ({
            id: cell.box.id,
            ...(Math.abs(cell.box.y - top) > HEIGHT_TOLERANCE ? { y: top } : {}),
            height: tallest,
          }));
        ctx.emit({
          code: "table_row_height_inconsistent",
          severity: "warning",
          elementIds: boxes.map((cell) => cell.box.id),
          kind: row,
          message: `Cells of row "${row}" in table ${table.id} have different heights (${[...new Set(heights.map(Math.round))].join(", ")}px).`,
          suggestion: updateSuggestion(patches, "review", "Gives every cell of the row the tallest height; re-running set_table does the same."),
        });
      }
    }

    if (ctx.on("table_header_style_mismatch")) {
      const labels = [...headers].map((cell) => cell.label).filter((label): label is ExcalidrawElement => !!label && !!textContent(label).trim());
      if (labels.length >= 2) {
        const size = majorityOf(labels.map(fontSizeOf));
        const color = majorityOf(labels.map((label) => label.strokeColor));
        const off = labels.filter((label) => fontSizeOf(label) !== size || label.strokeColor !== color);
        if (off.length) {
          const sizes = new Set(labels.map(fontSizeOf));
          const colors = new Set(labels.map((label) => label.strokeColor));
          ctx.emit({
            code: "table_header_style_mismatch",
            severity: "warning",
            elementIds: off.map((label) => label.id),
            kind: sizes.size > 1 && colors.size > 1 ? "both" : sizes.size > 1 ? "fontSize" : "strokeColor",
            message: `Header cells of table ${table.id} mix ${[
              ...(sizes.size > 1 ? [`font sizes ${[...sizes].join("/")}`] : []),
              ...(colors.size > 1 ? [`colors ${[...colors].join("/")}`] : []),
            ].join(" and ")}.`,
            suggestion: updateSuggestion(
              off.map((label) => ({
                id: label.id,
                ...(fontSizeOf(label) !== size ? { fontSize: size } : {}),
                ...(label.strokeColor !== color ? { strokeColor: color } : {}),
              })),
              "safe",
            ),
          });
        }
      }
    }

    if (ctx.on("table_too_dense")) {
      const outer = getCommonBounds(table.all);
      const columns = gridLines(groupBy(table.cells, (cell) => cell.col), [outer[0], outer[2]], "x");
      const rows = gridLines(groupBy(table.cells, (cell) => cell.row), [outer[1], outer[3]], "y");
      const dense: Array<{ cell: Cell; padding: number }> = [];
      for (const cell of table.cells) {
        const box = textBoxOf(cell);
        const colLines = columns.get(cell.col);
        const rowLines = rows.get(cell.row);
        if (!box || !colLines || !rowLines) {
          continue;
        }
        // Text spilling out of its cell container is table_cell_overflow's.
        if (cell.box !== cell.label && !boundsContain(ctx.bounds(cell.box), box)) {
          continue;
        }
        const padding = Math.min(box[0] - colLines[0], colLines[1] - box[2], box[1] - rowLines[0], rowLines[1] - box[3]);
        if (padding < MIN_CELL_PADDING) {
          dense.push({ cell, padding });
        }
      }
      if (dense.length) {
        const worst = Math.min(...dense.map((entry) => entry.padding));
        ctx.emit({
          code: "table_too_dense",
          severity: "warning",
          elementIds: dense.slice(0, MAX_LISTED).map((entry) => entry.cell.label?.id ?? entry.cell.box.id),
          details: { minPadding: Math.round(worst), cells: dense.length },
          message: `${dense.length} cell${dense.length > 1 ? "s" : ""} of table ${table.id} leave${dense.length > 1 ? "" : "s"} under ${MIN_CELL_PADDING}px between text and grid line (worst ${Math.round(worst)}px).`,
          suggestion: reasonSuggestion(
            `Re-run set_table for ${table.id} with a larger cellPadding or wider columns; moving single cells breaks the grid.`,
          ),
        });
      }
    }
  }
  return headerKeys;
};
