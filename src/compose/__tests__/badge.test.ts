import {describe, expect, it} from "vitest";

import type {ExcalidrawElement} from "../../types";
import {resolveRole} from "../../verify/styles";
import {fitTextToContainer} from "../../verify/textMetrics";
import {badgeGroupId, planBadge} from "../badge";
import {applyPlan, element} from "./applyPlan";

const anchor = element({
  id: "step",
  type: "rectangle",
  x: 100,
  y: 50,
  width: 200,
  height: 80,
  boundElements: [{ id: "step:label", type: "text" }],
});
const anchorLabel = element({ id: "step:label", type: "text", containerId: "step", x: 150, y: 80, width: 100, height: 20 });

describe("planBadge", () => {
  it("centers a circle on the anchor's corner with a fitting label", () => {
    for (const [corner, cx, cy] of [
      ["top-left", 100, 50],
      ["top-right", 300, 50],
      ["bottom-left", 100, 130],
      ["bottom-right", 300, 130],
    ] as const) {
      const plan = planBadge({ id: "b1", anchorId: "step", text: "12", corner }, [anchor, anchorLabel]);
      const [badge] = plan.items;
      expect(badge.type).toBe("ellipse");
      expect(badge.width).toBe(badge.height);
      expect(Math.abs((badge.x ?? 0) + (badge.width ?? 0) / 2 - cx)).toBeLessThanOrEqual(0.5);
      expect(Math.abs((badge.y ?? 0) + (badge.height ?? 0) / 2 - cy)).toBeLessThanOrEqual(0.5);
      const fit = fitTextToContainer(
        element({ ...(badge as Partial<ExcalidrawElement>), id: "b1", type: "ellipse" }),
        "12",
        badge.labelFontSize,
        badge.labelFontFamily,
      );
      expect(fit.widthOverflow || fit.heightOverflow).toBe(false);
      expect(badge).toMatchObject({
        label: "12",
        backgroundColor: resolveRole("accent")!.backgroundColor,
        customData: { kind: "badge" },
      });
    }
  });

  it("keeps the same size for any short step number", () => {
    const size = (text: string) => planBadge({ id: "b", anchorId: "step", text }, [anchor]).items[0].width;
    expect(size("1")).toBe(size("2"));
    expect(size("9")).toBe(size("7"));
  });

  it("groups badge and anchor (and its label) so they move together", () => {
    const plan = planBadge({ id: "b1", anchorId: "step", text: "1" }, [anchor, anchorLabel]);
    const group = badgeGroupId("step");
    expect(plan.items[0].groupIds).toEqual([group]);
    expect(plan.extraPatches).toEqual([
      { id: "step", patch: { groupIds: [group] } },
      { id: "step:label", patch: { groupIds: [group] } },
    ]);
    const live = applyPlan(plan, [anchor, anchorLabel]);
    const second = planBadge({ id: "b2", anchorId: "step", text: "2", corner: "top-right" }, live);
    expect(second.extraPatches).toBeUndefined();
    expect(second.items[0].groupIds).toEqual([group]);
  });

  it("nests inside groups the anchor already belongs to", () => {
    const grouped = { ...anchor, groupIds: ["outer"] };
    const plan = planBadge({ id: "b1", anchorId: "step", text: "1" }, [grouped]);
    expect(plan.items[0].groupIds).toEqual([badgeGroupId("step"), "outer"]);
    expect(plan.extraPatches?.[0]).toEqual({
      id: "step",
      patch: { groupIds: [badgeGroupId("step"), "outer"] },
    });
  });

  it("throws for a missing anchor or an unknown role", () => {
    expect(() => planBadge({ id: "b", anchorId: "ghost", text: "1" }, [anchor])).toThrow(/not found/);
    expect(() => planBadge({ id: "b", anchorId: "step", text: "1", role: "banana" }, [anchor])).toThrow(
      /unknown role/,
    );
  });
});
