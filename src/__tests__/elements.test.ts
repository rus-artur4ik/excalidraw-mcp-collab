import {describe, expect, it} from "vitest";

import {applyUpdate, buildNewElement, planCreations, planReorder,} from "../elements";
import {lineHeightForFamily} from "../verify/model";

describe("buildNewElement text sizing", () => {
  it("auto-sizes a text element to its content instead of 100x100", () => {
    const text = buildNewElement({ type: "text", text: "hello" }, []);
    expect(text.width).toBeGreaterThan(0);
    expect(text.width).toBeLessThan(100);
    expect(text.height).toBe(Math.ceil(20 * lineHeightForFamily(5)));
  });

  it("wraps to an explicit width and turns off autoResize", () => {
    const text = buildNewElement(
      { type: "text", text: "one two three four five six seven", width: 60 },
      [],
    );
    expect(text.width).toBe(60);
    expect(String(text.text)).toContain("\n");
    expect(text.autoResize).toBe(false);
    expect(text.height).toBeGreaterThan(Math.ceil(20 * lineHeightForFamily(5)));
  });

  it("does not auto-size bound text (containerId present)", () => {
    const text = buildNewElement(
      { type: "text", text: "x", containerId: "box", width: 42, height: 42 },
      [],
    );
    expect(text.width).toBe(42);
    expect(text.height).toBe(42);
  });
});

describe("buildNewElement linear geometry", () => {
  it("derives width/height from explicit points", () => {
    const line = buildNewElement(
      { type: "line", x: 0, y: 0, points: [[0, 0], [120, 40]] },
      [],
    );
    expect(line.width).toBe(120);
    expect(line.height).toBe(40);
    expect(line.points as number[][]).toHaveLength(2);
  });

  it("converts a bbox-only line into a visible 2-point segment", () => {
    const line = buildNewElement({ type: "line", width: 150, height: 0 }, []);
    expect(line.points as number[][]).toEqual([[0, 0], [150, 0]]);
    expect(line.width).toBe(150);
  });
});

describe("planCreations bound text", () => {
  it("binds text to a pre-existing container and back-references it", () => {
    const box = buildNewElement(
      { type: "rectangle", id: "box", x: 0, y: 0, width: 200, height: 100 },
      [],
    );
    const { created, containerUpdates } = planCreations(
      [{ type: "text", containerId: "box", text: "hi" }],
      [box],
    );
    expect(created).toHaveLength(1);
    expect(created[0].type).toBe("text");
    expect(created[0].containerId).toBe("box");
    expect(containerUpdates).toHaveLength(1);
    expect(containerUpdates[0].boundElements).toEqual([
      { id: created[0].id, type: "text" },
    ]);
  });

  it("creates container + bound text from a label in one call (patched in place)", () => {
    const { created, containerUpdates } = planCreations(
      [{ type: "rectangle", x: 0, y: 0, width: 200, height: 100, label: "Title" }],
      [],
    );
    expect(created.map((e) => e.type)).toEqual(["rectangle", "text"]);
    expect(created[1].containerId).toBe(created[0].id);
    expect(created[0].boundElements).toEqual([{ id: created[1].id, type: "text" }]);
    expect(containerUpdates).toHaveLength(0);
  });

  it("back-references a container created earlier in the same batch", () => {
    const { created, containerUpdates } = planCreations(
      [
        { type: "rectangle", id: "box", x: 0, y: 0, width: 200, height: 100 },
        { type: "text", containerId: "box", text: "hi" },
      ],
      [],
    );
    expect(containerUpdates).toHaveLength(0);
    const rect = created.find((e) => e.id === "box");
    const text = created.find((e) => e.type === "text");
    expect(rect?.boundElements).toEqual([{ id: text?.id, type: "text" }]);
  });

  it("throws when the container does not exist", () => {
    expect(() =>
      planCreations([{ type: "text", containerId: "ghost", text: "x" }], []),
    ).toThrow(/container not found/);
  });
});

describe("planCreations arrow binding", () => {
  it("binds an arrow to two shapes created in the same batch", () => {
    const { created, containerUpdates } = planCreations(
      [
        { type: "rectangle", id: "s1", x: 0, y: 0, width: 100, height: 100 },
        { type: "rectangle", id: "s2", x: 300, y: 0, width: 100, height: 100 },
        { type: "arrow", id: "arr", fromId: "s1", toId: "s2" },
      ],
      [],
    );
    const arrow = created.find((e) => e.id === "arr");
    expect(arrow?.type).toBe("arrow");
    expect((arrow as { startBinding?: { elementId: string } }).startBinding?.elementId).toBe("s1");
    expect((arrow as { endBinding?: { elementId: string } }).endBinding?.elementId).toBe("s2");
    expect(created.find((e) => e.id === "s1")?.boundElements).toEqual([
      { id: "arr", type: "arrow" },
    ]);
    expect(created.find((e) => e.id === "s2")?.boundElements).toEqual([
      { id: "arr", type: "arrow" },
    ]);
    expect(containerUpdates).toHaveLength(0);
  });

  it("binds an arrow to pre-existing shapes and records back-refs as container updates", () => {
    const s1 = buildNewElement(
      { type: "rectangle", id: "s1", x: 0, y: 0, width: 100, height: 100 },
      [],
    );
    const s2 = buildNewElement(
      { type: "rectangle", id: "s2", x: 300, y: 0, width: 100, height: 100 },
      [s1],
    );
    const { created, containerUpdates } = planCreations(
      [{ type: "arrow", id: "arr", fromId: "s1", toId: "s2" }],
      [s1, s2],
    );
    expect(created.map((e) => e.id)).toEqual(["arr"]);
    expect(containerUpdates.map((e) => e.id).sort()).toEqual(["s1", "s2"]);
    expect(containerUpdates.find((e) => e.id === "s1")?.boundElements).toEqual([
      { id: "arr", type: "arrow" },
    ]);
  });

  it("throws when a bound endpoint is missing", () => {
    expect(() =>
      planCreations([{ type: "arrow", fromId: "ghost", toId: "s2" }], []),
    ).toThrow(/connect source not found/);
  });

  it("throws when an arrow is bound to itself", () => {
    expect(() =>
      planCreations([{ type: "arrow", fromId: "s1", toId: "s1" }], []),
    ).toThrow(/connect an element to itself/);
  });

  it("binds an arrow listed before the shapes it connects in the same batch", () => {
    const { created, containerUpdates } = planCreations(
      [
        { type: "arrow", id: "arr", fromId: "s1", toId: "s2" },
        { type: "rectangle", id: "s1", x: 0, y: 0, width: 100, height: 100 },
        { type: "rectangle", id: "s2", x: 300, y: 0, width: 100, height: 100 },
      ],
      [],
    );
    const arrow = created.find((e) => e.id === "arr");
    expect(arrow?.type).toBe("arrow");
    expect((arrow as { startBinding?: { elementId: string } }).startBinding?.elementId).toBe("s1");
    expect(created.find((e) => e.id === "s1")?.boundElements).toEqual([
      { id: "arr", type: "arrow" },
    ]);
    expect(containerUpdates).toHaveLength(0);
  });
});

describe("planCreations frame + verticalAlign", () => {
  it("passes frameId through to the created element", () => {
    const { created } = planCreations(
      [{ type: "rectangle", id: "r", frameId: "frame-1", x: 0, y: 0, width: 50, height: 50 }],
      [],
    );
    expect(created[0].frameId).toBe("frame-1");
  });

  it("pins a label to the top of its container when verticalAlign is top", () => {
    const { created } = planCreations(
      [
        {
          type: "rectangle",
          id: "box",
          x: 0,
          y: 0,
          width: 200,
          height: 120,
          label: "Title",
          verticalAlign: "top",
        },
      ],
      [],
    );
    const text = created.find((e) => e.type === "text");
    expect(text?.verticalAlign).toBe("top");
    expect((text?.y ?? 0)).toBeLessThan(30);
  });
});

describe("applyUpdate", () => {
  it("honors an explicit index in the patch and bumps the version", () => {
    const box = buildNewElement({ type: "rectangle", id: "box" }, []);
    const moved = applyUpdate(box, { index: "zz" });
    expect(moved.index).toBe("zz");
    expect(moved.version).toBe(box.version + 1);
  });
});

describe("planReorder", () => {
  const scene = () => {
    const a = buildNewElement({ type: "rectangle", id: "a" }, []);
    const b = buildNewElement({ type: "rectangle", id: "b" }, [a]);
    const c = buildNewElement({ type: "rectangle", id: "c" }, [a, b]);
    return { a, b, c, elements: [a, b, c] };
  };

  it("brings an element to the front (above the current top)", () => {
    const { a, c, elements } = scene();
    const [moved] = planReorder(elements, ["a"], { to: "front" });
    expect(moved.id).toBe("a");
    expect(moved.index! > c.index!).toBe(true);
    expect(moved.version).toBe(a.version + 1);
  });

  it("sends an element to the back (below the current bottom)", () => {
    const { a, elements } = scene();
    const [moved] = planReorder(elements, ["c"], { to: "back" });
    expect(moved.id).toBe("c");
    expect(moved.index! < a.index!).toBe(true);
  });

  it("places an element just above an anchor", () => {
    const { b, c, elements } = scene();
    const [moved] = planReorder(elements, ["a"], { to: "above", anchorId: "b" });
    expect(moved.index! > b.index!).toBe(true);
    expect(moved.index! < c.index!).toBe(true);
  });

  it("pulls a container's bound text along and keeps it above the container", () => {
    const box = buildNewElement({ type: "rectangle", id: "box" }, []);
    const other = buildNewElement({ type: "rectangle", id: "other" }, [box]);
    const text = buildNewElement(
      { type: "text", id: "text", containerId: "box" },
      [box, other],
    );
    const result = planReorder([box, other, text], ["box"], { to: "front" });
    const ids = result.map((e) => e.id).sort();
    expect(ids).toEqual(["box", "text"]);
    const boxOut = result.find((e) => e.id === "box")!;
    const textOut = result.find((e) => e.id === "text")!;
    expect(textOut.index! > boxOut.index!).toBe(true);
    expect(boxOut.index! > other.index!).toBe(true);
  });

  it("rejects an anchor that is also being reordered", () => {
    const { elements } = scene();
    expect(() =>
      planReorder(elements, ["a", "b"], { to: "above", anchorId: "a" }),
    ).toThrow(/anchor cannot be one of the reordered/);
  });
});
