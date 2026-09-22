import {describe, expect, it} from "vitest";

import type {ExcalidrawElement} from "../../types";
import {BOUND_TEXT_PADDING} from "../../verify/model";
import {MUTED_TEXT_COLOR, SURFACES} from "../../verify/styles";
import {fitTextToContainer, wrapText} from "../../verify/textMetrics";
import {normalizeCode, planCodeCard} from "../code";
import type {PlannedItem} from "../types";
import {applyPlan, element} from "./applyPlan";

const CODE = "ChatKit.init(\n  ports = listOf(8080),\n    retries = 3,\n)";

const body = (items: PlannedItem[], id = "cc"): PlannedItem => items.find((item) => item.id === id)!;

const asElement = (item: PlannedItem): ExcalidrawElement =>
  element({ ...(item as Partial<ExcalidrawElement>), id: item.id, type: item.type });

describe("planCodeCard", () => {
  it("builds a monospace, left/top aligned body on the code surface", () => {
    const plan = planCodeCard({ id: "cc", x: 0, y: 900, code: CODE }, []);
    expect(plan.items.map((item) => item.id)).toEqual(["cc"]);
    expect(body(plan.items)).toMatchObject({
      type: "rectangle",
      x: 0,
      y: 900,
      label: CODE,
      labelFontFamily: 3,
      labelFontSize: 14,
      textAlign: "left",
      verticalAlign: "top",
      backgroundColor: SURFACES.code.backgroundColor,
      customData: { kind: "code" },
      groupIds: ["cc:group"],
    });
  });

  it("keeps leading spaces verbatim and never wraps in auto width", () => {
    const plan = planCodeCard({ id: "cc", x: 0, y: 0, code: CODE }, []);
    const card = body(plan.items);
    expect(card.label).toContain("\n    retries");
    expect(card.label).not.toContain(" ");
    const usable = (card.width ?? 0) - 2 * BOUND_TEXT_PADDING;
    expect(wrapText(CODE, 14, 3, usable)).toBe(CODE);
    const fit = fitTextToContainer(asElement(card), CODE, 14, 3);
    expect(fit.widthOverflow || fit.heightOverflow).toBe(false);
  });

  it("grows the height with the line count", () => {
    const heights = [1, 3, 8].map((lines) => {
      const code = Array.from({ length: lines }, (_, i) => `line_${i}()`).join("\n");
      return body(planCodeCard({ id: "cc", x: 0, y: 0, code }, []).items).height ?? 0;
    });
    expect(heights[1]).toBeGreaterThan(heights[0]);
    expect(heights[2]).toBeGreaterThan(heights[1]);
    expect((heights[2] - heights[0]) / 7).toBeCloseTo((heights[1] - heights[0]) / 2, 0);
  });

  it("wraps into a fixed width and still fits", () => {
    const long = "val veryLongIdentifierName = computeSomething(alpha, beta, gamma, delta)";
    const card = body(planCodeCard({ id: "cc", x: 0, y: 0, code: long, width: 200 }, []).items);
    expect(card.width).toBe(200);
    const fit = fitTextToContainer(asElement(card), long, 14, 3);
    expect(fit.heightOverflow).toBe(false);
    expect(card.height).toBeGreaterThan(body(planCodeCard({ id: "cc", x: 0, y: 0, code: "x" }, []).items).height ?? 0);
  });

  it("places the title above and a muted source line below", () => {
    const plan = planCodeCard(
      { id: "cc", x: 10, y: 100, code: CODE, title: "Step 2", source: "SampleChatKit.kt:108" },
      [],
    );
    expect(plan.items.map((item) => item.id)).toEqual(["cc:title", "cc", "cc:source"]);
    const [title, card, source] = plan.items;
    expect(title).toMatchObject({ type: "text", x: 10, y: 100, text: "Step 2" });
    expect((title.y ?? 0) + (title.height ?? 0)).toBeLessThan(card.y ?? 0);
    expect(source.y ?? 0).toBeGreaterThan((card.y ?? 0) + (card.height ?? 0));
    expect(source.strokeColor).toBe(MUTED_TEXT_COLOR);
    expect(new Set(plan.items.map((item) => item.groupIds?.join()))).toEqual(new Set(["cc:group"]));
    expect(plan.items.every((item) => (item.customData as { kind: string }).kind === "code")).toBe(true);
    expect(plan.bounds.y).toBe(100);
  });

  it("drops a title that is no longer requested", () => {
    const first = planCodeCard({ id: "cc", x: 0, y: 0, code: CODE, title: "Step 2" }, []);
    const live = applyPlan(first, []);
    const second = planCodeCard({ id: "cc", x: 0, y: 0, code: CODE }, live);
    expect(second.removeIds).toEqual(["cc:title"]);
    expect(second.previousBounds).toEqual(first.bounds);
  });

  it("normalizes tabs, CRLF, NBSP and trailing newlines", () => {
    expect(normalizeCode("a\r\n\tb c\n\n")).toBe("a\n    b c");
  });

  it("rejects empty code and foreign ids", () => {
    expect(() => planCodeCard({ id: "cc", x: 0, y: 0, code: "  \n" }, [])).toThrow(/non-empty code/);
    const foreign = element({ id: "cc", type: "rectangle" });
    expect(() => planCodeCard({ id: "cc", x: 0, y: 0, code: "x" }, [foreign])).toThrow(/not a code card/);
  });
});
