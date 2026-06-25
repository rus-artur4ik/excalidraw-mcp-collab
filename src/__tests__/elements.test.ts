import {describe, expect, it} from "vitest";

import {buildNewElement, planCreations} from "../elements";
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
