import {describe, expect, it} from "vitest";

import {mergeForPersist} from "../../reconcile";
import {asLinear, asText, BOUND_TEXT_PADDING} from "../../verify/model";
import {globalLinearPoints} from "../../verify/geometry";
import {arrowLabelAnchor} from "../boundText";
import {createItems} from "../create";
import {deleteTargets, restoreFrom} from "../lifecycle";
import {moveElements} from "../move";
import {resolveTarget} from "../selector";
import {updateItems} from "../update";
import {buildEnvelope, planWrite} from "../write";
import {Board} from "./helpers";

const center = (element: { x: number; y: number; width: number; height: number }) => [
  element.x + element.width / 2,
  element.y + element.height / 2,
];

describe("I01: re-creating a deleted id", () => {
  it("revives above the tombstone version and reports it", () => {
    const board = new Board();
    board.create([{ type: "rectangle", id: "db_11", x: 0, y: 0, width: 100, height: 60 }]);
    board.run((txn) => {
      updateItems(txn, [{ id: "db_11", x: 10 }]);
      updateItems(txn, [{ id: "db_11", x: 20 }]);
    });
    board.run((txn) => {
      deleteTargets(txn, [txn.live("db_11")!]);
    });
    const tombstone = board.get("db_11");
    expect(tombstone.isDeleted).toBe(true);

    const txn = board.create([{ type: "rectangle", id: "db_11", x: 0, y: 0, width: 100, height: 60 }]);
    const revived = board.get("db_11");
    expect(revived.isDeleted).toBe(false);
    expect(revived.version).toBe(tombstone.version + 1);
    expect(txn.report.revived.get("db_11")).toBe(tombstone.version);
  });

  it("revives a label id too and keeps the index slot", () => {
    const board = new Board();
    board.create([{ type: "rectangle", id: "k1", x: 0, y: 0, width: 160, height: 60, label: "Old" }]);
    const labelTomb = board.get("k1:label");
    const index = board.get("k1").index;
    board.run((txn) => deleteTargets(txn, [txn.live("k1")!]));
    board.create([{ type: "rectangle", id: "k1", x: 0, y: 0, width: 160, height: 60, label: "New" }]);
    expect(board.get("k1").index).toBe(index);
    expect(board.get("k1:label").version).toBeGreaterThan(labelTomb.version);
    expect(asText(board.get("k1:label")).originalText).toBe("New");
  });

  it("refuses a live id by default", () => {
    const board = new Board();
    board.create([{ type: "rectangle", id: "a", width: 10, height: 10 }]);
    expect(() => board.create([{ type: "rectangle", id: "a", width: 10, height: 10 }])).toThrow(/already exists/);
  });

  it("persist: a created id beats a stored tombstone with a higher version", () => {
    const board = new Board();
    board.create([{ type: "rectangle", id: "p_bottombar", width: 10, height: 10 }]);
    const mine = board.get("p_bottombar");
    const storedTomb = { ...mine, isDeleted: true, version: mine.version + 5 };
    const merge = mergeForPersist([mine], [storedTomb], new Set(["p_bottombar"]));
    const winner = merge.merged.find((element) => element.id === "p_bottombar")!;
    expect(winner.isDeleted).toBe(false);
    expect(winner.version).toBe(storedTomb.version + 1);
    expect(merge.bumped).toHaveLength(1);
    expect(merge.storedWins).toHaveLength(0);
  });

  it("persist: reports a stored copy that won over an update", () => {
    const board = new Board();
    board.create([{ type: "rectangle", id: "x", width: 10, height: 10 }]);
    const mine = board.get("x");
    const theirs = { ...mine, version: mine.version + 3, x: 999 };
    const merge = mergeForPersist([mine], [theirs]);
    expect(merge.storedWins.map((element) => element.x)).toEqual([999]);
  });
});

describe("I03 + I07: labels and arrows follow their container", () => {
  it("re-lays out the label when the container is resized and keeps textAlign left", () => {
    const board = new Board();
    board.create([
      {
        type: "rectangle",
        id: "cell",
        x: 100,
        y: 100,
        width: 200,
        height: 80,
        label: "Symptom",
        textAlign: "left",
        verticalAlign: "top",
      },
    ]);
    const label = board.get("cell:label");
    expect(label.x).toBeCloseTo(100 + BOUND_TEXT_PADDING);
    expect(label.y).toBeCloseTo(100 + BOUND_TEXT_PADDING);
    const txn = board.run((t) => {
      updateItems(t, [{ id: "cell", x: 300, width: 480 }]);
    });
    const moved = board.get("cell:label");
    expect(moved.x).toBeCloseTo(300 + BOUND_TEXT_PADDING);
    expect(asText(moved).textAlign).toBe("left");
    expect(txn.report.relaidOut.has("cell:label")).toBe(true);
  });

  it("re-aims bound arrow ends when a shape moves", () => {
    const board = new Board();
    board.create([
      { type: "rectangle", id: "a", x: 0, y: 0, width: 100, height: 60 },
      { type: "rectangle", id: "b", x: 300, y: 0, width: 100, height: 60 },
      { type: "arrow", id: "ab", fromId: "a", toId: "b" },
    ]);
    const before = globalLinearPoints(board.get("ab"));
    const txn = board.run((t) => {
      updateItems(t, [{ id: "b", y: 200 }]);
    });
    const after = globalLinearPoints(board.get("ab"));
    expect(txn.report.rerouted.has("ab")).toBe(true);
    expect(after[after.length - 1][1]).toBeGreaterThan(before[before.length - 1][1] + 100);
    // Still bound on both ends.
    expect(asLinear(board.get("ab")).endBinding?.elementId).toBe("b");
  });

  it("never empties an arrow label when the arrow is rerouted", () => {
    const board = new Board();
    board.create([
      { type: "rectangle", id: "a", x: 0, y: 0, width: 100, height: 60 },
      { type: "rectangle", id: "b", x: 300, y: 200, width: 100, height: 60 },
      { type: "arrow", id: "ab", fromId: "a", toId: "b", label: "calls" },
    ]);
    board.run((t) => {
      updateItems(t, [{ id: "ab", route: "orthogonal" }]);
    });
    board.run((t) => {
      updateItems(t, [{ id: "b", x: 500 }]);
    });
    const label = board.get("ab:label");
    expect(asText(label).text).toBe("calls");
    expect(label.width).toBeGreaterThan(0);
  });

  it("places an arrow label on the path like the client (middle segment)", () => {
    const board = new Board();
    board.create([
      { type: "rectangle", id: "a", x: 0, y: 0, width: 100, height: 60 },
      { type: "rectangle", id: "b", x: 400, y: 300, width: 100, height: 60 },
      { type: "arrow", id: "ab", fromId: "a", toId: "b", route: "orthogonal", label: "yes" },
    ]);
    const arrow = board.get("ab");
    const label = board.get("ab:label");
    const [ax, ay] = arrowLabelAnchor(arrow);
    const [lx, ly] = center(label);
    expect(lx).toBeCloseTo(ax, 0);
    expect(ly).toBeCloseTo(ay, 0);
  });
});

describe("I05 / N01: update applies what batch_create understands", () => {
  it("applies labelFontSize and role, keeps alignment, reports nothing ignored", () => {
    const board = new Board();
    board.create([
      { type: "rectangle", id: "h", x: 0, y: 0, width: 240, height: 60, label: "Header", textAlign: "left", labelFontSize: 20 },
    ]);
    const txn = board.run((t) => {
      updateItems(t, [{ id: "h", labelFontSize: 16, role: "accent" }]);
    });
    const label = board.get("h:label");
    expect(asText(label).fontSize).toBe(16);
    expect(asText(label).textAlign).toBe("left");
    expect(label.x).toBeCloseTo(BOUND_TEXT_PADDING);
    expect((board.get("h").customData as { role?: string }).role).toBe("accent");
    expect(board.get("h").backgroundColor).not.toBe("transparent");
    expect(txn.report.ignoredFields).toEqual([]);
  });

  it("reports unknown and read-only fields instead of writing them", () => {
    const board = new Board();
    board.create([{ type: "rectangle", id: "r", width: 50, height: 50 }]);
    const txn = board.run((t) => {
      updateItems(t, [{ id: "r", colour: "red", version: 99, strokeColor: "#e03131" }]);
    });
    expect(txn.report.ignoredFields.map((entry) => entry.field).sort()).toEqual(["colour", "version"]);
    expect((board.get("r") as Record<string, unknown>).colour).toBeUndefined();
    expect(board.get("r").strokeColor).toBe("#e03131");
  });

  it("rebinds an arrow in place: back-references move, style and label stay", () => {
    const board = new Board();
    board.create([
      { type: "rectangle", id: "a", x: 0, y: 0, width: 100, height: 60 },
      { type: "rectangle", id: "b", x: 300, y: 0, width: 100, height: 60 },
      { type: "rectangle", id: "c", x: 300, y: 300, width: 100, height: 60 },
      { type: "arrow", id: "ra_1", fromId: "a", toId: "b", strokeStyle: "dashed", label: "uses" },
    ]);
    board.run((t) => {
      updateItems(t, [{ id: "ra_1", toId: "c" }]);
    });
    const arrow = board.get("ra_1");
    expect(asLinear(arrow).endBinding?.elementId).toBe("c");
    expect(arrow.strokeStyle).toBe("dashed");
    expect((board.get("b").boundElements ?? []).some((ref) => ref.id === "ra_1")).toBe(false);
    expect((board.get("c").boundElements ?? []).some((ref) => ref.id === "ra_1")).toBe(true);
    expect(asText(board.get("ra_1:label")).text).toBe("uses");
  });

  it("changes text into a rectangle keeping the id and incoming arrows", () => {
    const board = new Board();
    board.create([
      { type: "text", id: "h_l2", x: 100, y: 100, text: "Layer 2" },
      { type: "rectangle", id: "src", x: 100, y: 300, width: 100, height: 60 },
      { type: "arrow", id: "in", fromId: "src", toId: "h_l2" },
    ]);
    board.run((t) => {
      updateItems(t, [{ id: "h_l2", type: "rectangle", role: "process" }]);
    });
    expect(board.get("h_l2").type).toBe("rectangle");
    expect(asText(board.get("h_l2:label")).originalText).toBe("Layer 2");
    expect(asLinear(board.get("in")).endBinding?.elementId).toBe("h_l2");
  });

  it("dx/dy move the element with its label and bound arrows", () => {
    const board = new Board();
    board.create([
      { type: "rectangle", id: "a", x: 0, y: 0, width: 100, height: 60, label: "A" },
      { type: "rectangle", id: "b", x: 300, y: 0, width: 100, height: 60 },
      { type: "arrow", id: "ab", fromId: "a", toId: "b" },
    ]);
    const labelBefore = board.get("a:label");
    board.run((t) => {
      updateItems(t, [{ id: "a", dy: 100 }]);
    });
    expect(board.get("a").y).toBe(100);
    expect(board.get("a:label").y).toBeCloseTo(labelBefore.y + 100);
    expect(globalLinearPoints(board.get("ab"))[0][1]).toBeGreaterThan(50);
  });

  it("binds a free text to an arrow as its label", () => {
    const board = new Board();
    board.create([
      { type: "rectangle", id: "a", x: 0, y: 0, width: 100, height: 60 },
      { type: "rectangle", id: "b", x: 300, y: 0, width: 100, height: 60 },
      { type: "arrow", id: "ab", fromId: "a", toId: "b" },
      { type: "text", id: "t", x: 600, y: 600, text: "sync" },
    ]);
    board.run((t) => {
      updateItems(t, [{ id: "t", containerId: "ab" }]);
    });
    const text = board.get("t");
    expect(asText(text).containerId).toBe("ab");
    expect((board.get("ab").boundElements ?? []).some((ref) => ref.id === "t")).toBe(true);
    const [ax, ay] = arrowLabelAnchor(board.get("ab"));
    expect(center(text)[0]).toBeCloseTo(ax, 0);
    expect(center(text)[1]).toBeCloseTo(ay, 0);
  });

  it("text edited on a label keeps originalText in sync", () => {
    const board = new Board();
    board.create([{ type: "rectangle", id: "k", width: 200, height: 60, label: "auto-U3" }]);
    board.run((t) => {
      updateItems(t, [{ id: "k:label", text: "Ports you implement" }]);
    });
    const label = asText(board.get("k:label"));
    expect(label.originalText).toBe("Ports you implement");
    expect(String(label.text).replace(/\n/g, " ")).toBe("Ports you implement");
  });
});

describe("I04: move_elements", () => {
  it("moves a frame with its children, their labels and inner arrows", () => {
    const board = new Board();
    board.create([
      { type: "frame", id: "f", x: 0, y: 0, width: 600, height: 300, name: "F" },
      { type: "rectangle", id: "a", x: 20, y: 40, width: 100, height: 60, frameId: "f", label: "A" },
      { type: "rectangle", id: "b", x: 300, y: 40, width: 100, height: 60, frameId: "f" },
      { type: "rectangle", id: "out", x: 900, y: 40, width: 100, height: 60 },
      { type: "arrow", id: "ab", fromId: "a", toId: "b", frameId: "f" },
      { type: "arrow", id: "bo", fromId: "b", toId: "out" },
    ]);
    const abBefore = board.get("ab");
    board.run((t) => {
      moveElements(t, [t.live("f")!], 0, 160);
    });
    expect(board.get("a").y).toBe(200);
    expect(board.get("a:label").y).toBeGreaterThan(200);
    expect(board.get("ab").y).toBeCloseTo(abBefore.y + 160);
    const bo = globalLinearPoints(board.get("bo"));
    expect(bo[0][1]).toBeGreaterThan(150);
    expect(board.get("out").y).toBe(40);
  });

  it("target.after selects what lies below an anchor in its frame", () => {
    const board = new Board();
    board.create([
      { type: "frame", id: "f", x: 0, y: 0, width: 600, height: 600 },
      { type: "rectangle", id: "r1", x: 20, y: 20, width: 100, height: 60, frameId: "f" },
      { type: "rectangle", id: "r2", x: 20, y: 120, width: 100, height: 60, frameId: "f", label: "two" },
      { type: "rectangle", id: "r3", x: 20, y: 220, width: 100, height: 60, frameId: "f" },
    ]);
    const hit = resolveTarget(board.live(), { after: { anchorId: "r1", axis: "y" } }).map((e) => e.id);
    expect(hit.sort()).toEqual(["r2", "r3"]);
  });
});

describe("envelope and dry run", () => {
  it("dry run plans without touching the base map", () => {
    const board = new Board();
    board.create([{ type: "rectangle", id: "a", width: 50, height: 50 }]);
    const planned = planWrite(board.elements, { dryRun: true }, (txn) => updateItems(txn, [{ id: "a", x: 500 }]));
    const envelope = buildEnvelope(planned, { sceneVersion: 0, prevSceneVersion: 0, dryRun: true });
    expect(envelope.dryRun).toBe(true);
    expect(envelope.changed.updated).toEqual(["a"]);
    expect(board.get("a").x).toBe(0);
  });

  it("restores a deleted container with its label and re-binds the arrow", () => {
    const board = new Board();
    board.create([
      { type: "rectangle", id: "a", x: 0, y: 0, width: 100, height: 60, label: "A" },
      { type: "rectangle", id: "b", x: 300, y: 0, width: 100, height: 60 },
      { type: "arrow", id: "ab", fromId: "a", toId: "b" },
    ]);
    board.run((t) => deleteTargets(t, [t.live("b")!]));
    expect(asLinear(board.get("ab")).endBinding).toBeNull();
    board.run((t) =>
      restoreFrom(t, ["b"], (id) => {
        const element = t.get(id);
        return element?.isDeleted ? element : undefined;
      }),
    );
    expect(board.get("b").isDeleted).toBe(false);
    expect(asLinear(board.get("ab")).endBinding?.elementId).toBe("b");
  });

  it("creates arrows between shapes defined later in the same batch", () => {
    const board = new Board();
    const txn = board.txn();
    createItems(txn, [
      { type: "arrow", id: "x", fromId: "p", toId: "q" },
      { type: "rectangle", id: "p", x: 0, y: 0, width: 50, height: 50 },
      { type: "rectangle", id: "q", x: 200, y: 0, width: 50, height: 50 },
    ]);
    board.commit(txn);
    expect(asLinear(board.get("x")).startBinding?.elementId).toBe("p");
  });
});

describe("I18: anchors and straight routes", () => {
  it("route straight makes a horizontal arrow between overlapping rows", () => {
    const board = new Board();
    board.create([
      { type: "rectangle", id: "a", x: 0, y: 0, width: 100, height: 60 },
      { type: "rectangle", id: "b", x: 300, y: 30, width: 100, height: 60 },
      { type: "arrow", id: "ab", fromId: "a", toId: "b", route: "straight" },
    ]);
    const points = globalLinearPoints(board.get("ab"));
    expect(points).toHaveLength(2);
    expect(points[0][1]).toBeCloseTo(points[1][1]);
  });

  it("spreads arrows that share a side", () => {
    const board = new Board();
    board.create([
      { type: "rectangle", id: "t", x: 200, y: 300, width: 300, height: 60 },
      { type: "rectangle", id: "s1", x: 0, y: 0, width: 100, height: 60 },
      { type: "rectangle", id: "s2", x: 300, y: 0, width: 100, height: 60 },
      { type: "rectangle", id: "s3", x: 600, y: 0, width: 100, height: 60 },
      { type: "arrow", id: "a1", fromId: "s1", toId: "t", endAnchor: { side: "top" } },
      { type: "arrow", id: "a2", fromId: "s2", toId: "t", endAnchor: { side: "top" } },
      { type: "arrow", id: "a3", fromId: "s3", toId: "t", endAnchor: { side: "top" } },
    ]);
    const xs = ["a1", "a2", "a3"].map((id) => {
      const points = globalLinearPoints(board.get(id));
      return Math.round(points[points.length - 1][0]);
    });
    expect(new Set(xs).size).toBe(3);
    expect(Math.min(...xs)).toBeGreaterThan(200);
    expect(Math.max(...xs)).toBeLessThan(500);
  });
});

describe("wrap, styleFrom, snap, frames, expected", () => {
  it("balanced wrap evens a two-line label and bakes the break", async () => {
    const { bakeLineBreaks } = await import("../boundText");
    const greedy = bakeLineBreaks("Retries are capped at three per request", 20, 5, 330, { wrap: "words" });
    const balanced = bakeLineBreaks("Retries are capped at three per request", 20, 5, 330, { wrap: "balanced" });
    expect(balanced.split("\n")).toHaveLength(greedy.split("\n").length);
    const lastWords = (text: string) => text.split("\n").at(-1)!.split(" ").length;
    expect(lastWords(balanced)).toBeGreaterThanOrEqual(lastWords(greedy));
  });

  it("nowrap keeps a key together and a line never starts with a joiner", async () => {
    const { bakeLineBreaks } = await import("../boundText");
    const text = bakeLineBreaks("see auto-I1 · 01 for the details of the flow", 20, 5, 120, { nowrap: ["auto-\\w+ · \\d+"] });
    expect(text).toContain("auto-I1 · 01");
    for (const line of text.split("\n")) {
      expect(line.startsWith("·")).toBe(false);
    }
  });

  it("styleFrom copies colors and label style", () => {
    const board = new Board();
    board.create([
      { type: "rectangle", id: "src", width: 100, height: 60, role: "accent", label: "A", labelFontSize: 14, textAlign: "left" },
      { type: "rectangle", id: "dst", x: 200, width: 100, height: 60, label: "B" },
    ]);
    board.run((txn) => {
      updateItems(txn, [{ id: "dst", styleFrom: "src" }]);
    });
    expect(board.get("dst").backgroundColor).toBe(board.get("src").backgroundColor);
    expect(asText(board.get("dst:label")).fontSize).toBe(14);
    expect(asText(board.get("dst:label")).textAlign).toBe("left");
  });

  it("snap rounds the geometry a write touched", () => {
    const board = new Board();
    const planned = planWrite(board.elements, { snap: 8 }, (txn) =>
      createItems(txn, [{ type: "rectangle", id: "s", x: 13, y: 21, width: 101, height: 59 }]),
    );
    const snapped = planned.txn.live("s")!;
    expect([snapped.x, snapped.y, snapped.width, snapped.height]).toEqual([16, 24, 104, 56]);
  });

  it("layout_frames flows frames with their content and records the order", async () => {
    const { layoutFrames } = await import("../frames");
    const board = new Board();
    board.create([
      { type: "frame", id: "f1", x: 500, y: 500, width: 300, height: 200 },
      { type: "frame", id: "f2", x: 0, y: 0, width: 300, height: 200 },
      { type: "rectangle", id: "inner", x: 520, y: 520, width: 50, height: 50, frameId: "f1" },
    ]);
    board.run((txn) => {
      layoutFrames(txn, { order: ["f1", "f2"], origin: { x: 0, y: 0 }, gap: 100 });
    });
    expect([board.get("f1").x, board.get("f1").y]).toEqual([0, 0]);
    expect(board.get("f2").x).toBe(400);
    expect([board.get("inner").x, board.get("inner").y]).toEqual([20, 20]);
    expect((board.get("f2").customData as { order?: number }).order).toBe(1);
  });

  it("expected-scene checks report what is missing or different", async () => {
    const { checkExpected } = await import("../expected");
    const board = new Board();
    board.create([
      { type: "rectangle", id: "a", width: 100, height: 60, label: "Gateway" },
      { type: "rectangle", id: "b", x: 300, width: 100, height: 60, label: "Store" },
    ]);
    const findings = checkExpected(board.elements, {
      ids: ["zz"],
      elements: [{ id: "a", label: "gateway" }, { id: "b", label: "Storage" }],
      edges: [{ from: "a", to: "b" }],
      frames: ["01 · Flow"],
    });
    expect(findings.map((finding) => finding.code).sort()).toEqual([
      "expected_edge_missing",
      "expected_frame_missing",
      "expected_mismatch",
      "expected_missing",
    ]);
  });

  it("reports unknown create fields and does not write them", () => {
    const board = new Board();
    const txn = board.create([{ type: "rectangle", id: "u", width: 10, height: 10, colour: "red" } as never]);
    expect(txn.report.ignoredFields).toEqual([expect.objectContaining({ id: "u", field: "colour" })]);
    expect((board.get("u") as Record<string, unknown>).colour).toBeUndefined();
  });
});

describe("fixes from the lint review", () => {
  it("binds a free arrow end through update_elements fromId", () => {
    const board = new Board();
    board.create([
      { type: "rectangle", id: "box", x: 0, y: 0, width: 100, height: 60 },
      { type: "arrow", id: "free", x: 300, y: 30, points: [[0, 0], [100, 0]] },
    ]);
    board.run((txn) => {
      updateItems(txn, [{ id: "free", fromId: "box" }]);
    });
    const arrow = asLinear(board.get("free"));
    expect(arrow.startBinding?.elementId).toBe("box");
    expect((board.get("box").boundElements ?? []).some((ref) => ref.id === "free")).toBe(true);
    const start = globalLinearPoints(board.get("free"))[0];
    expect(start[0]).toBeGreaterThan(100);
    expect(start[0]).toBeLessThan(110);
  });

  it("a grown box leaves the lint's minimum padding around its label", async () => {
    const { lintScene } = await import("../../verify/lint");
    const board = new Board();
    board.create([{ type: "rectangle", id: "g", width: 60, height: 30, label: "A much longer label than fits", fit: "both" }]);
    const findings = lintScene(board.live(), { ids: ["g"], codes: ["text_overflow"] }).findings;
    expect(findings).toEqual([]);
  });
});
