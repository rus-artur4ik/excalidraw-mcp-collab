import {describe, expect, it} from "vitest";

import type {ExcalidrawElement} from "../../types";
import {BOUND_TEXT_PADDING} from "../../verify/model";
import {resolveRole, SURFACES} from "../../verify/styles";
import {fitTextToContainer, measureText, wrapText} from "../../verify/textMetrics";
import {planTable, readTableSpec, type TablePlan, type TableSpecInput} from "../table";
import type {PlannedItem} from "../types";
import {applyPlan, element, liveOnly} from "./applyPlan";

const T = "t_err";

const baseSpec: TableSpecInput = {
  origin: { x: 100, y: 200 },
  columns: [
    { key: "s", header: "Symptom" },
    { key: "c", header: "Cause" },
    { key: "f", header: "Fix" },
  ],
  rows: [
    { key: "spin", cells: { s: "Spinner hangs", c: "no binding", f: "bind it" } },
    { key: "blank", cells: { s: "Blank screen", c: "token expired", f: "refresh" } },
    { key: "slow", cells: { s: "Slow", c: "N+1 queries", f: "batch" } },
  ],
};

const item = (plan: TablePlan, id: string): PlannedItem => {
  const found = plan.items.find((candidate) => candidate.id === id);
  if (!found) {
    throw new Error(`no planned item ${id}`);
  }
  return found;
};

const asElement = (planned: PlannedItem): ExcalidrawElement =>
  element({ ...(planned as Partial<ExcalidrawElement>), id: planned.id, type: planned.type });

const create = (spec: TableSpecInput = baseSpec, live: ExcalidrawElement[] = []) => {
  const plan = planTable({ tableId: T, spec }, live);
  return { plan, live: applyPlan(plan, live) };
};

const cellItems = (plan: TablePlan) =>
  plan.items.filter((candidate) => (candidate.customData as { kind?: string })?.kind === "table-cell");

describe("planTable: creation", () => {
  it("emits deterministic ids for root, header, cells and rules", () => {
    const { plan } = create();
    const ids = plan.items.map((candidate) => candidate.id);
    expect(ids[0]).toBe(T);
    expect(ids).toContain(`${T}:hbg`);
    expect(ids).toContain(`${T}:_h:s`);
    expect(ids).toContain(`${T}:spin:c`);
    expect(ids).toContain(`${T}:slow:f`);
    expect(ids).toContain(`${T}:hr:0`);
    expect(ids.filter((id) => id.startsWith(`${T}:hr:`))).toHaveLength(3);
    expect(new Set(ids).size).toBe(ids.length);
    expect(plan.cells.spin.c).toBe(`${T}:spin:c`);
    expect(plan.cells._h.s).toBe(`${T}:_h:s`);
    expect(plan.removeIds).toEqual([]);
    expect(plan.previousBounds).toBeUndefined();

    const again = planTable({ tableId: T, spec: baseSpec }, []);
    expect(again.items).toEqual(plan.items);
  });

  it("stores the merged spec on the root and marks every part", () => {
    const { plan, live } = create();
    const root = item(plan, T);
    expect(root.customData).toMatchObject({ kind: "table", table: { tableId: T, part: "root" } });
    expect(readTableSpec(live, T)?.rows.map((row) => row.key)).toEqual(["spin", "blank", "slow"]);
    expect(item(plan, `${T}:spin:c`).customData).toEqual({
      kind: "table-cell",
      table: { tableId: T, row: "spin", col: "c" },
    });
    expect(item(plan, `${T}:hr:0`)).toMatchObject({
      type: "line",
      roughness: 0,
      startArrowhead: null,
      endArrowhead: null,
      customData: { kind: "divider", table: { tableId: T, part: "divider" } },
    });
    const groupIds = plan.items.map((candidate) => candidate.groupIds);
    expect(new Set(groupIds.map((ids) => ids?.join()))).toEqual(new Set([`${T}:group`]));
  });

  it("puts header background and dividers under the cells", () => {
    const { plan } = create();
    const index = (id: string) => plan.items.findIndex((candidate) => candidate.id === id);
    expect(index(T)).toBe(0);
    expect(index(`${T}:hbg`)).toBeLessThan(index(`${T}:_h:s`));
    expect(index(`${T}:hr:1`)).toBeLessThan(index(`${T}:spin:s`));
    expect(item(plan, `${T}:hbg`).backgroundColor).toBe(SURFACES.header.backgroundColor);
  });

  it("requires an origin or a frame for a new table", () => {
    const { origin: _origin, ...withoutOrigin } = baseSpec;
    expect(() => planTable({ tableId: T, spec: withoutOrigin }, [])).toThrow(/origin/);
  });

  it("places a new table in a frame below its existing content", () => {
    const frame = element({ id: "fr", type: "frame", x: 0, y: 0, width: 1200, height: 800 });
    const title = element({ id: "title", type: "text", x: 40, y: 40, width: 300, height: 40, frameId: "fr" });
    const { origin: _origin, ...withoutOrigin } = baseSpec;
    const plan = planTable({ tableId: T, spec: withoutOrigin, frameId: "fr" }, [frame, title]);
    expect(plan.bounds.y).toBeGreaterThan(80);
    expect(plan.bounds.x).toBeGreaterThan(0);
    expect(plan.items.every((candidate) => candidate.frameId === "fr")).toBe(true);
  });

  it("rejects bad keys, unknown columns and roles, and foreign ids", () => {
    expect(() =>
      planTable({ tableId: T, spec: { ...baseSpec, columns: [{ key: "a:b" }] } }, []),
    ).toThrow(/must not contain/);
    expect(() =>
      planTable({ tableId: T, spec: { ...baseSpec, rows: [{ key: "r", cells: { zz: "x" } }] } }, []),
    ).toThrow(/unknown column "zz"/);
    expect(() =>
      planTable({ tableId: T, spec: { ...baseSpec, rows: [{ key: "r", role: "banana" }] } }, []),
    ).toThrow(/unknown role/);
    const foreign = element({ id: T, type: "rectangle" });
    expect(() => planTable({ tableId: T, spec: baseSpec }, [foreign])).toThrow(/not a table/);
  });
});

describe("planTable: geometry", () => {
  it("keeps every label exactly cellPadding from the grid lines and fitting its cell", () => {
    const { plan } = create({ ...baseSpec, cellPadding: { x: 12, y: 8 } });
    const root = item(plan, T);
    const first = item(plan, `${T}:_h:s`);
    // The client puts a left/top label 5 px inside its container.
    expect((first.x ?? 0) + BOUND_TEXT_PADDING).toBe((root.x ?? 0) + 12);
    expect((first.y ?? 0) + BOUND_TEXT_PADDING).toBe((root.y ?? 0) + 8);
    for (const cell of cellItems(plan)) {
      if (typeof cell.label !== "string") {
        continue;
      }
      const fit = fitTextToContainer(asElement(cell), cell.label, cell.labelFontSize, cell.labelFontFamily);
      expect(fit.widthOverflow || fit.heightOverflow).toBe(false);
    }
  });

  it("sizes auto columns so the widest text does not wrap", () => {
    const long = "A considerably longer cause text";
    const { plan } = create({
      ...baseSpec,
      rows: [...(baseSpec.rows ?? []), { key: "long", cells: { c: long } }],
    });
    const cell = item(plan, `${T}:long:c`);
    const usable = (cell.width ?? 0) - 2 * BOUND_TEXT_PADDING;
    expect(usable).toBeGreaterThanOrEqual(measureText(long, 16, 5).width);
    expect(wrapText(long, 16, 5, usable)).toBe(long);
    // The row stays one line tall like its neighbours.
    expect(cell.height).toBe(item(plan, `${T}:spin:c`).height);
  });

  it("wraps at maxWidth and grows the row instead", () => {
    const long = "one two three four five six seven eight nine ten eleven twelve";
    const { plan } = create({
      ...baseSpec,
      columns: [{ key: "c", maxWidth: 160 }],
      rows: [{ key: "spin", cells: { c: long } }],
    });
    const cell = item(plan, `${T}:spin:c`);
    expect((cell.width ?? 0) + 2 * (12 - BOUND_TEXT_PADDING)).toBe(160);
    expect(cell.height).toBeGreaterThan(item(plan, `${T}:_h:c`).height ?? 0);
    const fit = fitTextToContainer(asElement(cell), long, 16, 5);
    expect(fit.heightOverflow).toBe(false);
  });

  it("aligns number and mark columns and uses monospace for code", () => {
    const { plan } = create({
      origin: { x: 0, y: 0 },
      numbered: "1.",
      columns: [
        { key: "n", header: "Count", role: "number" },
        { key: "m", header: "OK", role: "mark" },
        { key: "k", header: "Key", role: "code" },
      ],
      rows: [{ key: "r1", cells: { n: "12", m: "✓", k: "ctx.id" } }],
    });
    expect(item(plan, `${T}:r1:n`).textAlign).toBe("right");
    expect(item(plan, `${T}:r1:m`).textAlign).toBe("center");
    expect(item(plan, `${T}:r1:k`).labelFontFamily).toBe(3);
    expect(item(plan, `${T}:_h:k`).labelFontFamily).toBe(5);
    expect(item(plan, `${T}:r1:_n`).label).toBe("1.");
    expect(item(plan, `${T}:_h:_n`).label).toBeUndefined();
    expect(item(plan, `${T}:r1:_n`).x).toBeLessThan(item(plan, `${T}:r1:n`).x ?? 0);
  });

  it("colors palette-role rows and cells with the subtle tone", () => {
    const { plan } = create({
      ...baseSpec,
      rows: [
        { key: "spin", role: "error" },
        { key: "blank", cells: { c: { text: "token expired", role: "accent" } } },
      ],
    });
    expect(item(plan, `${T}:z:spin`).backgroundColor).toBe(resolveRole("error", "subtle")?.backgroundColor);
    expect(item(plan, `${T}:z:blank:c`).backgroundColor).toBe(resolveRole("accent", "subtle")?.backgroundColor);
    expect(item(plan, `${T}:spin:s`).backgroundColor).toBe("transparent");
  });

  it("draws zebra rows, column rules and the border as asked", () => {
    const { plan } = create({
      ...baseSpec,
      tableStyle: { zebra: { every: 2 }, columnRules: true, border: "none" },
    });
    const ids = plan.items.map((candidate) => candidate.id);
    expect(ids).toContain(`${T}:z:blank`);
    expect(ids).not.toContain(`${T}:z:spin`);
    expect(ids.filter((id) => id.startsWith(`${T}:vr:`))).toHaveLength(2);
    expect(item(plan, T).strokeColor).toBe("transparent");
  });

  it("puts a row-group label band before the group's first row", () => {
    const { plan } = create({
      ...baseSpec,
      rowGroups: [{ label: "Network", rows: ["blank", "slow"] }],
    });
    const band = item(plan, `${T}:g:0`);
    expect(band.label).toBe("Network");
    expect(band.textAlign).toBe("left");
    expect((band.y ?? 0)).toBeGreaterThan(item(plan, `${T}:spin:s`).y ?? 0);
    expect((band.y ?? 0) + (band.height ?? 0)).toBeLessThanOrEqual(item(plan, `${T}:blank:s`).y ?? 0);
    expect(plan.items.map((candidate) => candidate.id)).toContain(`${T}:gbg:0`);
  });
});

describe("planTable: merge semantics", () => {
  const xOf = (plan: TablePlan, id: string) => item(plan, id).x ?? 0;
  const wOf = (plan: TablePlan, id: string) => item(plan, id).width ?? 0;

  it("widens one column with a one-column call and shifts only what is right of it", () => {
    const first = create();
    const second = planTable({ tableId: T, spec: { columns: [{ key: "c", width: 440 }] } }, first.live);
    const delta = 440 - (wOf(first.plan, `${T}:spin:c`) + 2 * (12 - BOUND_TEXT_PADDING));
    expect(delta).toBeGreaterThan(0);
    for (const row of ["_h", "spin", "blank", "slow"]) {
      const s = `${T}:${row}:s`;
      const c = `${T}:${row}:c`;
      const f = `${T}:${row}:f`;
      expect(xOf(second, s)).toBe(xOf(first.plan, s));
      expect(wOf(second, s)).toBe(wOf(first.plan, s));
      expect(xOf(second, c)).toBe(xOf(first.plan, c));
      expect(wOf(second, c)).toBe(wOf(first.plan, c) + delta);
      expect(xOf(second, f)).toBe(xOf(first.plan, f) + delta);
      expect(wOf(second, f)).toBe(wOf(first.plan, f));
      expect(item(second, s).y).toBe(item(first.plan, s).y);
    }
    expect(second.bounds.width).toBe(first.plan.bounds.width + delta);
    expect(second.bounds.x).toBe(100);
    expect(second.previousBounds).toEqual(first.plan.bounds);
    expect(second.removeIds).toEqual([]);
    expect(second.spec.rows).toHaveLength(3);
    expect(second.spec.columns.find((column) => column.key === "c")).toMatchObject({ header: "Cause", width: 440 });
  });

  it("inserts a row after another and pushes the rows below down", () => {
    const first = create();
    const second = planTable(
      {
        tableId: T,
        spec: {
          rows: [
            { key: "x", after: "spin", cells: { s: "New", c: "cause" } },
            { key: "y", after: "spin", cells: { s: "Newer" } },
          ],
        },
      },
      first.live,
    );
    expect(second.spec.rows.map((row) => row.key)).toEqual(["spin", "x", "y", "blank", "slow"]);
    const y = (plan: TablePlan, row: string) => item(plan, `${T}:${row}:s`).y ?? 0;
    expect(y(second, "spin")).toBe(y(first.plan, "spin"));
    expect(y(second, "x")).toBeGreaterThan(y(second, "spin"));
    expect(y(second, "y")).toBeGreaterThan(y(second, "x"));
    const inserted = y(second, "blank") - y(first.plan, "blank");
    expect(inserted).toBeGreaterThan(0);
    expect(y(second, "slow") - y(first.plan, "slow")).toBe(inserted);
    expect(second.bounds.height - first.plan.bounds.height).toBe(inserted);
    expect(item(second, `${T}:y:c`).label).toBeUndefined();
  });

  it("removes rows listed in removeRows together with their labels", () => {
    const first = create();
    const second = planTable({ tableId: T, spec: { removeRows: ["blank"] } }, first.live);
    expect(second.spec.rows.map((row) => row.key)).toEqual(["spin", "slow"]);
    expect(second.removeIds).toEqual(
      expect.arrayContaining([`${T}:blank:s`, `${T}:blank:s:label`, `${T}:blank:c`, `${T}:blank:f:label`]),
    );
    expect(second.removeIds.some((id) => id.includes(":spin:") || id.includes(":slow:"))).toBe(false);
    expect(item(second, `${T}:slow:s`).y).toBe(item(first.plan, `${T}:blank:s`).y);
    const after = liveOnly(applyPlan(second, first.live));
    expect(after.some((el) => el.id.startsWith(`${T}:blank:`))).toBe(false);
  });

  it("prunes rows only when rows are passed, and columns only when columns are passed", () => {
    const first = create();
    const rowsOnly = planTable(
      { tableId: T, spec: { prune: true, rows: [{ key: "slow", cells: { f: "batch it" } }] } },
      first.live,
    );
    expect(rowsOnly.spec.rows.map((row) => row.key)).toEqual(["slow"]);
    expect(rowsOnly.spec.columns.map((column) => column.key)).toEqual(["s", "c", "f"]);
    expect(rowsOnly.spec.rows[0].cells).toEqual({ s: "Slow", c: "N+1 queries", f: "batch it" });

    const columnsOnly = planTable(
      { tableId: T, spec: { prune: true, columns: [{ key: "s" }, { key: "f" }] } },
      first.live,
    );
    expect(columnsOnly.spec.columns.map((column) => column.key)).toEqual(["s", "f"]);
    expect(columnsOnly.spec.rows).toHaveLength(3);
    expect(columnsOnly.removeIds).toEqual(expect.arrayContaining([`${T}:_h:c`, `${T}:spin:c`]));
  });

  it("reorders rows with rowOrder", () => {
    const first = create();
    const second = planTable({ tableId: T, spec: { rowOrder: ["slow", "spin"] } }, first.live);
    expect(second.spec.rows.map((row) => row.key)).toEqual(["slow", "spin", "blank"]);
    expect(() => planTable({ tableId: T, spec: { rowOrder: ["nope"] } }, first.live)).toThrow(/unknown row/);
  });

  it("keeps cell text edited on the board over the stored spec", () => {
    const first = create();
    const edited = first.live.map((el) =>
      el.id === `${T}:spin:c:label` ? { ...el, text: "binding lost", originalText: "binding lost" } : el,
    );
    const second = planTable({ tableId: T, spec: { columns: [{ key: "f", width: 200 }] } }, edited);
    expect(item(second, `${T}:spin:c`).label).toBe("binding lost");
    expect(second.spec.rows[0].cells.c).toBe("binding lost");
  });

  it("drops the label of a cell whose text was cleared", () => {
    const first = create();
    const second = planTable({ tableId: T, spec: { rows: [{ key: "spin", cells: { f: "" } }] } }, first.live);
    expect(item(second, `${T}:spin:f`).label).toBeUndefined();
    expect(second.removeIds).toEqual([`${T}:spin:f:label`]);
  });

  it("never deletes a user's copy of a cell", () => {
    const first = create();
    const copy = {
      ...first.live.find((el) => el.id === `${T}:spin:c`)!,
      id: "random-copy",
      x: 2000,
    };
    const second = planTable({ tableId: T, spec: { removeRows: ["spin"] } }, [...first.live, copy]);
    expect(second.removeIds).not.toContain("random-copy");
  });

  it("revives a table whose root is gone only with a fresh origin", () => {
    const first = create();
    const deleted = first.live.map((el) => (el.id === T ? { ...el, isDeleted: true } : el));
    expect(() => planTable({ tableId: T, spec: { columns: [{ key: "c", width: 300 }] } }, deleted)).toThrow(
      /origin/,
    );
  });
});
