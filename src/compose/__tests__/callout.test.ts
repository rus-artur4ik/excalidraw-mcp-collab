import {describe, expect, it} from "vitest";

import type {ExcalidrawElement} from "../../types";
import {getElementBounds} from "../../verify/geometry";
import {resolveRole} from "../../verify/styles";
import {fitTextToContainer} from "../../verify/textMetrics";
import {planCallout} from "../callout";
import type {PlannedItem} from "../types";
import {element} from "./applyPlan";

const anchor = element({ id: "node", type: "rectangle", x: 0, y: 0, width: 160, height: 80 });

const boxOf = (items: PlannedItem[]) => items.find((item) => item.type === "rectangle")!;
const ptrOf = (items: PlannedItem[]) => items.find((item) => item.type === "arrow")!;

const rectOf = (item: PlannedItem) => ({
  minX: item.x ?? 0,
  minY: item.y ?? 0,
  maxX: (item.x ?? 0) + (item.width ?? 0),
  maxY: (item.y ?? 0) + (item.height ?? 0),
});

const intersects = (item: PlannedItem, other: ExcalidrawElement) => {
  const a = rectOf(item);
  const [minX, minY, maxX, maxY] = getElementBounds(other);
  return a.minX < maxX && minX < a.maxX && a.minY < maxY && minY < a.maxY;
};

const gapTo = (item: PlannedItem, other: ExcalidrawElement) => {
  const a = rectOf(item);
  const [minX, minY, maxX, maxY] = getElementBounds(other);
  const dx = Math.max(minX - a.maxX, a.minX - maxX, 0);
  const dy = Math.max(minY - a.maxY, a.minY - maxY, 0);
  return Math.hypot(dx, dy);
};

describe("planCallout", () => {
  it("puts a note box right of the anchor with a straight bound pointer", () => {
    const plan = planCallout({ id: "co", anchorId: "node", text: "Retries are capped at 3" }, [anchor]);
    const box = boxOf(plan.items);
    const ptr = ptrOf(plan.items);
    expect(plan.items.map((item) => item.id)).toEqual(["co", "co:ptr"]);
    expect((box.x ?? 0)).toBeGreaterThanOrEqual(160 + 40);
    expect(gapTo(box, anchor)).toBeLessThanOrEqual(120);
    expect(box).toMatchObject({
      label: "Retries are capped at 3",
      backgroundColor: resolveRole("note", "subtle")!.backgroundColor,
      strokeColor: resolveRole("note")!.strokeColor,
      customData: { kind: "callout" },
    });
    expect(ptr).toMatchObject({
      fromId: "co",
      toId: "node",
      startAnchor: { side: "left" },
      endAnchor: { side: "right" },
      route: "straight",
      customData: { kind: "callout" },
    });
    const fit = fitTextToContainer(
      element({ ...(box as Partial<ExcalidrawElement>), id: "co", type: "rectangle" }),
      box.label as string,
      box.labelFontSize,
      box.labelFontFamily,
    );
    expect(fit.widthOverflow || fit.heightOverflow).toBe(false);
  });

  it("moves to the next side when the preferred one is taken, never overlapping", () => {
    const blocker = element({ id: "right", type: "rectangle", x: 190, y: -200, width: 400, height: 500 });
    const arrow = element({
      id: "wire",
      type: "arrow",
      x: 80,
      y: 80,
      width: 0,
      height: 400,
      points: [
        [0, 0],
        [0, 400],
      ],
    });
    const scene = [anchor, blocker, arrow];
    const plan = planCallout({ id: "co", anchorId: "node", text: "Watch this" }, scene);
    const box = boxOf(plan.items);
    for (const other of scene) {
      expect(intersects(box, other)).toBe(false);
    }
    expect(plan.warnings).toBeUndefined();
    expect(gapTo(box, anchor)).toBeLessThanOrEqual(120);
    expect(ptrOf(plan.items).endAnchor).toEqual({ side: "top" });
  });

  it("does not treat a lane around the anchor as an obstacle", () => {
    const lane = element({ id: "lane", type: "rectangle", x: -100, y: -100, width: 800, height: 400 });
    const plan = planCallout({ id: "co", anchorId: "node", text: "Inside the lane" }, [lane, anchor]);
    expect(ptrOf(plan.items).endAnchor).toEqual({ side: "right" });
    expect(plan.warnings).toBeUndefined();
  });

  it("honours an explicit side and a role", () => {
    const plan = planCallout(
      { id: "co", anchorId: "node", text: "Left note", side: "left", role: "error" },
      [anchor],
    );
    const box = boxOf(plan.items);
    expect((box.x ?? 0) + (box.width ?? 0)).toBeLessThanOrEqual(-40);
    expect(box.backgroundColor).toBe(resolveRole("error", "subtle")!.backgroundColor);
  });

  it("falls back to the least-covered spot with a warning on a crowded board", () => {
    const wall = element({ id: "wall", type: "rectangle", x: -1000, y: -1000, width: 900, height: 2200 });
    const wall2 = element({ id: "wall2", type: "rectangle", x: 170, y: -1000, width: 900, height: 2200 });
    const plan = planCallout({ id: "co", anchorId: "node", text: "Crowded", maxDistance: 60 }, [
      anchor,
      wall,
      element({ id: "top", type: "rectangle", x: -100, y: -1000, width: 270, height: 990 }),
      element({ id: "bottom", type: "rectangle", x: -100, y: 90, width: 270, height: 990 }),
      wall2,
    ]);
    expect(plan.warnings?.[0]).toMatch(/no free spot/);
    expect(plan.items).toHaveLength(2);
  });

  it("anchors through a bound label to its container and rejects a missing anchor", () => {
    const label = element({ id: "node:label", type: "text", containerId: "node", x: 40, y: 30, width: 80, height: 20 });
    const plan = planCallout({ id: "co", anchorId: "node:label", text: "Via label" }, [anchor, label]);
    expect(ptrOf(plan.items).toId).toBe("node");
    expect(() => planCallout({ id: "co", anchorId: "ghost", text: "x" }, [anchor])).toThrow(/not found/);
  });
});
