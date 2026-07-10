import {describe, expect, it} from "vitest";

import {planDiagram} from "../layout";
import type {CreateAttrs} from "../../elements";
import {planCreations} from "../../elements";
import {intersectionArea} from "../geometry";

let uuidCounter = 0;
const nextId = () => `node-${++uuidCounter}`;

const FLOW = {
  nodes: [
    { id: "start", label: "Start", role: "terminal" },
    { id: "check", label: "Valid?", role: "decision" },
    { id: "work", label: "Do the work", role: "process" },
    { id: "fail", label: "Reject", role: "error" },
  ],
  edges: [
    { from: "start", to: "check" },
    { from: "check", to: "work", label: "yes" },
    { from: "check", to: "fail", label: "no" },
  ],
};

const shapeItems = (items: CreateAttrs[]): CreateAttrs[] =>
  items.filter((item) => ["rectangle", "ellipse", "diamond"].includes(item.type));

describe("planDiagram", () => {
  it("lays out a flowchart without overlapping nodes", async () => {
    const plan = await planDiagram(FLOW, nextId);
    const shapes = shapeItems(plan.items);
    expect(shapes).toHaveLength(4);
    for (let i = 0; i < shapes.length; i++) {
      for (let j = i + 1; j < shapes.length; j++) {
        const a = shapes[i];
        const b = shapes[j];
        const overlap = intersectionArea(
          [a.x!, a.y!, a.x! + a.width!, a.y! + a.height!],
          [b.x!, b.y!, b.x! + b.width!, b.y! + b.height!],
        );
        expect(overlap).toBe(0);
      }
    }
  });

  it("flows in the requested direction", async () => {
    const plan = await planDiagram({ ...FLOW, direction: "DOWN" }, nextId);
    const byId = new Map(plan.items.map((item) => [item.id, item]));
    const start = byId.get(plan.nodeElementIds.start)!;
    const check = byId.get(plan.nodeElementIds.check)!;
    const work = byId.get(plan.nodeElementIds.work)!;
    expect(start.y!).toBeLessThan(check.y!);
    expect(check.y!).toBeLessThan(work.y!);
  });

  it("maps roles to shapes and keeps role styling", async () => {
    const plan = await planDiagram(FLOW, nextId);
    const byId = new Map(plan.items.map((item) => [item.id, item]));
    expect(byId.get(plan.nodeElementIds.start)!.type).toBe("ellipse");
    expect(byId.get(plan.nodeElementIds.check)!.type).toBe("diamond");
    expect(byId.get(plan.nodeElementIds.work)!.type).toBe("rectangle");
    expect(byId.get(plan.nodeElementIds.work)!.role).toBe("process");
  });

  it("creates bound arrows and edge labels", async () => {
    const plan = await planDiagram(FLOW, nextId);
    const arrows = plan.items.filter((item) => item.type === "arrow");
    expect(arrows).toHaveLength(3);
    for (const arrow of arrows) {
      expect(arrow.fromId).toBeTruthy();
      expect(arrow.toId).toBeTruthy();
    }
    const labels = plan.items.filter((item) => item.type === "text");
    expect(labels.map((label) => label.text)).toEqual(
      expect.arrayContaining(["yes", "no"]),
    );
  });

  it("produces items planCreations accepts end-to-end", async () => {
    const plan = await planDiagram(FLOW, nextId);
    const { created } = planCreations(plan.items, []);
    const arrows = created.filter((element) => element.type === "arrow");
    expect(arrows).toHaveLength(3);
    for (const arrow of arrows) {
      const linear = arrow as { startBinding?: unknown; endBinding?: unknown };
      expect(linear.startBinding).toBeTruthy();
      expect(linear.endBinding).toBeTruthy();
    }
  });

  it("wraps grouped nodes in a labelled cluster container", async () => {
    const plan = await planDiagram(
      {
        nodes: [
          { id: "a", label: "Outside" },
          { id: "b", label: "Inside 1", group: "cluster" },
          { id: "c", label: "Inside 2", group: "cluster" },
        ],
        edges: [
          { from: "a", to: "b" },
          { from: "b", to: "c" },
        ],
        groups: [{ id: "cluster", label: "Backend" }],
      },
      nextId,
    );
    const container = plan.items.find(
      (item) => item.type === "rectangle" && item.strokeStyle === "dashed",
    )!;
    expect(container).toBeTruthy();
    const byId = new Map(plan.items.map((item) => [item.id, item]));
    for (const nodeId of ["b", "c"]) {
      const node = byId.get(plan.nodeElementIds[nodeId])!;
      expect(node.x!).toBeGreaterThanOrEqual(container.x!);
      expect(node.y!).toBeGreaterThanOrEqual(container.y!);
      expect(node.x! + node.width!).toBeLessThanOrEqual(container.x! + container.width!);
      expect(node.y! + node.height!).toBeLessThanOrEqual(container.y! + container.height!);
    }
    expect(plan.items.some((item) => item.text === "Backend")).toBe(true);
  });

  it("offsets the whole diagram by origin", async () => {
    const plan = await planDiagram(
      { ...FLOW, origin: { x: 1000, y: 2000 } },
      nextId,
    );
    for (const shape of shapeItems(plan.items)) {
      expect(shape.x!).toBeGreaterThanOrEqual(1000);
      expect(shape.y!).toBeGreaterThanOrEqual(2000);
    }
  });

  it("rejects edges to unknown nodes, duplicate ids and oversized diagrams", async () => {
    await expect(
      planDiagram({ nodes: [{ id: "a", label: "A" }], edges: [{ from: "a", to: "zz" }] }, nextId),
    ).rejects.toThrow(/unknown node/);
    await expect(
      planDiagram(
        { nodes: [{ id: "a", label: "A" }, { id: "a", label: "B" }], edges: [] },
        nextId,
      ),
    ).rejects.toThrow(/duplicate/);
    const many = Array.from({ length: 61 }, (_, i) => ({ id: `n${i}`, label: `N${i}` }));
    await expect(planDiagram({ nodes: many, edges: [] }, nextId)).rejects.toThrow(
      /split it/,
    );
  });
});
