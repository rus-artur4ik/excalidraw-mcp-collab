import {describe, expect, it} from "vitest";

import type {ExcalidrawElement} from "../../types";
import {DEFAULT_PROFILE, type BoardProfile} from "../../profile";
import {planCallout} from "../callout";
import {planCodeCard} from "../code";
import {planLegend} from "../legend";
import {planTable, type TablePlan, type TableSpecInput} from "../table";
import type {ComposePlan, PlannedItem} from "../types";
import {element} from "./applyPlan";

// A profile that differs from every built-in default, so a test that passes
// only because the numbers happen to agree cannot exist.
const PROFILE: BoardProfile = {
  typeScale: { title: 34, frameTitle: 26, colHeader: 22, body: 18, caption: 12, code: 11 },
  spacing: { unit: 6, cellPadding: 16, frameInset: 60, blockGap: 48 },
};

const T = "t_profile";

const spec: TableSpecInput = {
  origin: { x: 0, y: 0 },
  columns: [{ key: "a", header: "Name" }, { key: "b", header: "Value" }],
  rows: [
    { key: "r1", cells: { a: "alpha", b: "1" } },
    { key: "r2", cells: { a: "beta", b: "2" } },
  ],
};

const item = (plan: ComposePlan, id: string): PlannedItem => {
  const found = plan.items.find((candidate) => candidate.id === id);
  if (!found) {
    throw new Error(`no planned item ${id}`);
  }
  return found;
};

const labelSizes = (plan: TablePlan, rowKey: string): number[] =>
  Object.values(plan.cells[rowKey]).map((id) => item(plan, id).labelFontSize as number);

describe("planTable with a board profile", () => {
  it("takes colHeader for headers and body for cells when the spec pins no size", () => {
    const plan = planTable({ tableId: T, spec }, [], PROFILE);
    expect(labelSizes(plan, "_h")).toEqual([22, 22]);
    expect(labelSizes(plan, "r1")).toEqual([18, 18]);
  });

  it("keeps the built-in defaults without a profile", () => {
    const plan = planTable({ tableId: T, spec }, []);
    expect(labelSizes(plan, "_h")).toEqual([16, 16]);
    expect(labelSizes(plan, "r1")).toEqual([16, 16]);
  });

  it("lets the spec override the profile, and headers follow a pinned fontSize", () => {
    const plan = planTable({ tableId: T, spec: { ...spec, fontSize: 24 } }, [], PROFILE);
    expect(labelSizes(plan, "_h")).toEqual([24, 24]);
    expect(labelSizes(plan, "r1")).toEqual([24, 24]);
  });

  it("honours an explicit headerFontSize over the profile", () => {
    const plan = planTable({ tableId: T, spec: { ...spec, headerFontSize: 30 } }, [], PROFILE);
    expect(labelSizes(plan, "_h")).toEqual([30, 30]);
    expect(labelSizes(plan, "r1")).toEqual([18, 18]);
  });

  it("keeps a size the table pinned earlier when it is re-planned", () => {
    const first = planTable({ tableId: T, spec: { ...spec, fontSize: 15 } }, []);
    const live = [
      element({
        id: T,
        type: "rectangle",
        customData: { kind: "table", table: { tableId: T, part: "root" }, tableSpec: first.spec },
      }),
    ] as ExcalidrawElement[];
    const again = planTable({ tableId: T, spec: {} }, live, PROFILE);
    expect(labelSizes(again, "r1")).toEqual([15, 15]);
  });

  it("pads cells with the profile's cellPadding", () => {
    const withProfile = planTable({ tableId: T, spec }, [], PROFILE);
    const without = planTable({ tableId: T, spec }, []);
    const cellOf = (plan: TablePlan) => item(plan, plan.cells.r1.a);
    // 16px of padding on each side against the default 12: the same text needs
    // a wider column, and the row gets taller than with 8px above and below.
    expect((cellOf(withProfile).width as number) - (cellOf(without).width as number)).toBeGreaterThan(0);
    expect(withProfile.bounds.height).toBeGreaterThan(without.bounds.height);
  });

  it("insets a new table in a frame by the profile's frameInset", () => {
    const frame = element({ id: "F", type: "frame", x: 500, y: 700, width: 900, height: 600 });
    const plan = planTable({ tableId: T, spec: { ...spec, origin: undefined }, frameId: "F" }, [frame], PROFILE);
    expect(plan.bounds.x).toBe(500 + PROFILE.spacing!.frameInset!);
    expect(plan.bounds.y).toBe(700 + PROFILE.spacing!.frameInset!);
  });
});

describe("planLegend, planCodeCard and planCallout with a board profile", () => {
  it("sets legend labels to the caption step and pads with cellPadding", () => {
    const input = {
      legendId: "lg",
      origin: { x: 0, y: 0 },
      items: [{ role: "accent", label: "you" }, { role: "process", label: "sdk" }],
    };
    const withProfile = planLegend(input, [], PROFILE);
    const without = planLegend(input, []);
    expect(item(withProfile, "lg:0:text").fontSize).toBe(12);
    expect(without.items.find((i) => i.id === "lg:0:text")!.fontSize).toBe(16);
    // 16px panel padding instead of 12 pushes the first chip further in.
    expect(item(withProfile, "lg:0:chip").x).toBe(16);
    expect(item(without, "lg:0:chip").x).toBe(12);
  });

  it("keeps the legend's explicit fontSize over the profile", () => {
    const plan = planLegend(
      { legendId: "lg", origin: { x: 0, y: 0 }, items: [{ label: "x" }], fontSize: 21 },
      [],
      PROFILE,
    );
    expect(item(plan, "lg:0:text").fontSize).toBe(21);
  });

  it("sets the code card's body, title and source from the scale", () => {
    const input = { id: "cc", x: 0, y: 0, code: "const a = 1;", title: "Setup", source: "app.ts" };
    const plan = planCodeCard(input, [], PROFILE);
    expect(item(plan, "cc").labelFontSize).toBe(11);
    expect(item(plan, "cc:title").fontSize).toBe(18);
    expect(item(plan, "cc:source").fontSize).toBe(12);
    const without = planCodeCard(input, []);
    expect(item(without, "cc").labelFontSize).toBe(14);
    expect(item(without, "cc:title").fontSize).toBe(16);
    expect(item(without, "cc:source").fontSize).toBe(12);
  });

  it("sets the callout's label to the body step and pads with cellPadding", () => {
    const anchor = element({ id: "n1", type: "rectangle", x: 0, y: 0, width: 120, height: 60 });
    const input = { id: "co", anchorId: "n1", text: "watch out" };
    const withProfile = planCallout(input, [anchor], PROFILE);
    const without = planCallout(input, [anchor]);
    expect(item(withProfile, "co").labelFontSize).toBe(18);
    expect(item(without, "co").labelFontSize).toBe(16);
    expect(item(withProfile, "co").height as number).toBeGreaterThan(item(without, "co").height as number);
  });
});

describe("DEFAULT_PROFILE", () => {
  it("agrees with the planners' own built-in defaults where they overlap", () => {
    // planTable's DEFAULT_FONT_SIZE and FRAME_INSET/FRAME_CONTENT_GAP were the
    // numbers the series already used; the profile documents them.
    expect(DEFAULT_PROFILE.typeScale.body).toBe(16);
    expect(DEFAULT_PROFILE.spacing.frameInset).toBe(40);
    expect(DEFAULT_PROFILE.spacing.blockGap).toBe(32);
    expect(DEFAULT_PROFILE.typeScale.code).toBe(14);
  });
});
