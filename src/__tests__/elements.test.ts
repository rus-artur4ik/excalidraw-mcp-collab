import {describe, expect, it} from "vitest";

import {applyUpdate, buildNewElement, detachDeleted, markDeleted, planCreations, planReorder,} from "../elements";
import {asLinear, asText, lineHeightForFamily} from "../verify/model";
import {lintScene} from "../verify/lint";

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

describe("label styling reaches the label, not the box", () => {
  const createLabelled = (extra: Record<string, unknown>) =>
    planCreations(
      [{ type: "rectangle", id: "box", width: 200, height: 80, label: "Fresh", ...extra }],
      [],
    );

  it("applies fontSize and fontFamily on a labelled shape to the bound text", () => {
    const { created } = createLabelled({ fontSize: 14, fontFamily: 3 });
    const text = created.find((element) => element.type === "text")!;
    expect(asText(text).fontSize).toBe(14);
    expect(asText(text).fontFamily).toBe(3);
  });

  it("does not leave text styling on the container", () => {
    const { created } = createLabelled({ fontSize: 14, fontFamily: 3 });
    const box = created.find((element) => element.id === "box")!;
    expect(box.fontSize).toBeUndefined();
    expect(box.fontFamily).toBeUndefined();
  });

  it("lets labelFontSize/labelFontFamily override fontSize/fontFamily", () => {
    const { created } = createLabelled({
      fontSize: 14,
      fontFamily: 3,
      labelFontSize: 28,
      labelFontFamily: 5,
    });
    const text = created.find((element) => element.type === "text")!;
    expect(asText(text).fontSize).toBe(28);
    expect(asText(text).fontFamily).toBe(5);
  });

  it("still honours labelColor", () => {
    const { created } = createLabelled({ labelColor: "#e03131" });
    const text = created.find((element) => element.type === "text")!;
    expect(text.strokeColor).toBe("#e03131");
  });

  it("sizes the bound text with the requested font, not the default", () => {
    const small = createLabelled({ fontSize: 10 }).created.find((e) => e.type === "text")!;
    const large = createLabelled({ fontSize: 30 }).created.find((e) => e.type === "text")!;
    expect(small.height).toBeLessThan(large.height);
  });
});

describe("planCreations labels map", () => {
  it("maps each container id to the id of the label it created", () => {
    const { created, labels } = planCreations(
      [
        { type: "rectangle", id: "gate", label: "Gate" },
        { type: "diamond", id: "check", label: "Valid?" },
      ],
      [],
    );
    const textOf = (containerId: string) =>
      created.find((element) => asText(element).containerId === containerId)!.id;
    expect(labels).toEqual({ gate: textOf("gate"), check: textOf("check") });
  });

  it("maps an arrow to its own bound label", () => {
    const { created, labels } = planCreations(
      [
        { type: "rectangle", id: "a", width: 60, height: 60 },
        { type: "rectangle", id: "b", x: 400, width: 60, height: 60 },
        { type: "arrow", id: "edge", fromId: "a", toId: "b", label: "yes" },
      ],
      [],
    );
    const text = created.find((element) => asText(element).containerId === "edge")!;
    expect(labels.edge).toBe(text.id);
    expect(asText(text).text).toBe("yes");
  });
});

describe("planCreations arrow routing", () => {
  const shapes = [
    { type: "rectangle", id: "a", width: 60, height: 60 },
    { type: "rectangle", id: "b", x: 400, width: 60, height: 60 },
  ];

  it("keeps both bindings when routed through waypoints", () => {
    const { created } = planCreations(
      [...shapes, { type: "arrow", id: "edge", fromId: "a", toId: "b", waypoints: [[230, -80]] }],
      [],
    );
    const arrow = asLinear(created.find((element) => element.id === "edge")!);
    expect(arrow.startBinding?.elementId).toBe("a");
    expect(arrow.endBinding?.elementId).toBe("b");
    expect(arrow.points).toHaveLength(3);
  });
});

describe("lintIgnore is stowed in customData", () => {
  it("moves the flat field into customData on create", () => {
    const arrow = buildNewElement(
      { type: "arrow", lintIgnore: ["arrow_unbound_endpoint"] },
      [],
    );
    expect(arrow.customData).toEqual({ lintIgnore: ["arrow_unbound_endpoint"] });
    expect(arrow.lintIgnore).toBeUndefined();
  });

  it("moves it on update too, preserving other customData", () => {
    const arrow = buildNewElement({ type: "arrow", customData: { origin: "bot" } }, []);
    const updated = applyUpdate(arrow, { lintIgnore: ["isolated"] } as never);
    expect(updated.customData).toEqual({ origin: "bot", lintIgnore: ["isolated"] });
  });
});

describe("detachDeleted", () => {
  const shape = (id: string, boundElements: { id: string; type: string }[] | null) =>
    buildNewElement({ type: "rectangle", id, boundElements }, []);

  it("strips boundElements entries pointing at a deleted arrow", () => {
    const from = shape("A", [{ id: "R", type: "arrow" }]);
    const to = shape("B", [{ id: "R", type: "arrow" }]);
    const detached = detachDeleted([from, to], new Set(["R"]));
    expect(detached).toHaveLength(2);
    expect(detached.every((element) => element.boundElements === null)).toBe(true);
  });

  it("keeps unrelated back-references", () => {
    const from = shape("A", [{ id: "R", type: "arrow" }, { id: "T", type: "text" }]);
    const [detached] = detachDeleted([from], new Set(["R"]));
    expect(detached.boundElements).toEqual([{ id: "T", type: "text" }]);
  });

  it("nulls an arrow binding that pointed at a deleted shape", () => {
    const arrow = buildNewElement(
      {
        type: "arrow",
        id: "R",
        startBinding: { elementId: "A", fixedPoint: [1, 0.5], mode: "orbit" },
        endBinding: { elementId: "B", fixedPoint: [0, 0.5], mode: "orbit" },
      },
      [],
    );
    const [detached] = detachDeleted([arrow], new Set(["A"]));
    expect(asLinear(detached).startBinding).toBeNull();
    expect(asLinear(detached).endBinding).toEqual({
      elementId: "B",
      fixedPoint: [0, 0.5],
      mode: "orbit",
    });
  });

  it("leaves untouched elements out of the result", () => {
    expect(detachDeleted([shape("A", null)], new Set(["R"]))).toEqual([]);
  });

  it("does not re-emit the deleted elements themselves", () => {
    const arrow = buildNewElement({ type: "arrow", id: "R" }, []);
    expect(detachDeleted([arrow], new Set(["R"]))).toEqual([]);
  });
});

describe("deleting never leaves a dangling binding", () => {
  const connectedScene = () => {
    const { created } = planCreations(
      [
        { type: "rectangle", id: "a", width: 60, height: 60 },
        { type: "rectangle", id: "b", x: 400, width: 60, height: 60 },
        { type: "arrow", id: "hunt", fromId: "a", toId: "b" },
      ],
      [],
    );
    return created;
  };

  const deleteWithoutDetaching = (scene: ReturnType<typeof connectedScene>, ids: Set<string>) =>
    scene.map((element) => (ids.has(element.id) ? markDeleted(element) : element));

  const deleteAsServerDoes = (scene: ReturnType<typeof connectedScene>, ids: Set<string>) => {
    const afterDelete = deleteWithoutDetaching(scene, ids);
    const survivors = afterDelete.filter((element) => !element.isDeleted);
    const detached = new Map(
      detachDeleted(survivors, ids).map((element) => [element.id, element]),
    );
    return afterDelete.map((element) => detached.get(element.id) ?? element);
  };

  it("starts from a scene the linter already considers clean", () => {
    expect(lintScene(connectedScene()).summary.errors).toBe(0);
  });

  it("regression guard: deleting the arrow without detaching leaves two errors", () => {
    const scene = deleteWithoutDetaching(connectedScene(), new Set(["hunt"]));
    const { findings } = lintScene(scene);
    const backrefs = findings.filter((f) => f.code === "binding_backref_missing");
    expect(backrefs).toHaveLength(2);
  });

  it("deleting the arrow strips the back-reference from both endpoints", () => {
    const scene = deleteAsServerDoes(connectedScene(), new Set(["hunt"]));
    expect(lintScene(scene).summary.errors).toBe(0);
    for (const id of ["a", "b"]) {
      const shape = scene.find((element) => element.id === id)!;
      expect(shape.boundElements ?? []).toHaveLength(0);
    }
  });

  it("deleting an endpoint unbinds the surviving arrow", () => {
    const scene = deleteAsServerDoes(connectedScene(), new Set(["a"]));
    expect(lintScene(scene).summary.errors).toBe(0);
    const arrow = asLinear(scene.find((element) => element.id === "hunt")!);
    expect(arrow.startBinding).toBeNull();
    expect(arrow.endBinding?.elementId).toBe("b");
  });
});

describe("buildNewElement image defaults", () => {
  it("fills status saved and unit scale on image elements", () => {
    const image = buildNewElement(
      { type: "image", fileId: "abc123", width: 200, height: 100 },
      [],
    );
    expect(image.fileId).toBe("abc123");
    expect(image.status).toBe("saved");
    expect(image.scale).toEqual([1, 1]);
  });

  it("keeps an explicit scale", () => {
    const image = buildNewElement(
      { type: "image", fileId: "abc123", scale: [2, 2] },
      [],
    );
    expect(image.scale).toEqual([2, 2]);
  });
});
