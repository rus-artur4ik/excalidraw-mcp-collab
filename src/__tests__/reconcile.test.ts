import {describe, expect, it} from "vitest";

import {reassertElement} from "../elements";
import {decideIncoming, mergeByVersion} from "../reconcile";
import {el} from "../verify/__tests__/factory";

describe("mergeByVersion", () => {
  it("keeps the higher version per id and unions disjoint ids", () => {
    const mineA = el({ type: "rectangle", id: "a", version: 3 });
    const theirsA = el({ type: "rectangle", id: "a", version: 5 });
    const mineB = el({ type: "rectangle", id: "b", version: 1 });
    const theirsC = el({ type: "rectangle", id: "c", version: 1 });

    const merged = mergeByVersion([mineA, mineB], [theirsA, theirsC]);
    const byId = new Map(merged.map((element) => [element.id, element]));

    expect(merged).toHaveLength(3);
    expect(byId.get("a")?.version).toBe(5);
    expect(byId.has("b")).toBe(true);
    expect(byId.has("c")).toBe(true);
  });

  it("keeps mine on a version tie so the bot's write is not lost to a stale echo", () => {
    const mine = el({ type: "rectangle", id: "a", version: 4, strokeColor: "#mine" });
    const theirs = el({ type: "rectangle", id: "a", version: 4, strokeColor: "#theirs" });

    expect(mergeByVersion([mine], [theirs])[0].strokeColor).toBe("#mine");
  });

  it("preserves a stored element the bot never saw (no clobber)", () => {
    const human = el({ type: "rectangle", id: "human", version: 2 });
    const merged = mergeByVersion([el({ type: "rectangle", id: "bot" })], [human]);
    expect(merged.map((element) => element.id).sort()).toEqual(["bot", "human"]);
  });
});

describe("decideIncoming", () => {
  const base = { botDeleted: false, resurrectCount: 0, maxResurrections: 3 };

  it("ignores an incoming element that is not strictly newer", () => {
    const current = el({ type: "rectangle", id: "a", version: 5 });
    const incoming = el({ type: "rectangle", id: "a", version: 5 });
    expect(
      decideIncoming({ ...base, incoming, current, isOwned: true, snapshot: current }).action,
    ).toBe("ignore");
  });

  it("accepts a newer incoming edit to a non-owned element", () => {
    const current = el({ type: "rectangle", id: "a", version: 1 });
    const incoming = el({ type: "rectangle", id: "a", version: 2 });
    expect(
      decideIncoming({ ...base, incoming, current, isOwned: false, snapshot: undefined }).action,
    ).toBe("accept");
  });

  it("resurrects an owned element a human session tombstones", () => {
    const snapshot = el({ type: "rectangle", id: "a", version: 1, isDeleted: false });
    const incoming = el({ type: "rectangle", id: "a", version: 4, isDeleted: true });

    const decision = decideIncoming({
      ...base,
      incoming,
      current: snapshot,
      isOwned: true,
      snapshot,
    });

    expect(decision.action).toBe("resurrect");
    if (decision.action === "resurrect") {
      expect(decision.element.isDeleted).toBe(false);
      expect(decision.element.version).toBe(5);
    }
  });

  it("yields once the resurrection budget is spent", () => {
    const snapshot = el({ type: "rectangle", id: "a", version: 1 });
    const incoming = el({ type: "rectangle", id: "a", version: 9, isDeleted: true });

    expect(
      decideIncoming({
        ...base,
        incoming,
        current: snapshot,
        isOwned: true,
        snapshot,
        resurrectCount: 3,
      }).action,
    ).toBe("yield");
  });

  it("does not resist a deletion the bot itself made", () => {
    const current = el({ type: "rectangle", id: "a", version: 2 });
    const incoming = el({ type: "rectangle", id: "a", version: 5, isDeleted: true });

    expect(
      decideIncoming({
        ...base,
        incoming,
        current,
        isOwned: true,
        botDeleted: true,
        snapshot: undefined,
      }).action,
    ).toBe("accept");
  });

  it("flags a soft conflict when a human overwrites an owned element", () => {
    const current = el({ type: "rectangle", id: "a", version: 2 });
    const incoming = el({ type: "rectangle", id: "a", version: 3, isDeleted: false });

    const decision = decideIncoming({
      ...base,
      incoming,
      current,
      isOwned: true,
      snapshot: current,
    });

    expect(decision.action).toBe("accept_conflict");
    if (decision.action === "accept_conflict") {
      expect(decision.kind).toBe("overwritten_by_incoming");
    }
  });
});

describe("reassertElement", () => {
  it("revives a snapshot above the incoming deletion version", () => {
    const revived = reassertElement(
      el({ type: "rectangle", id: "a", version: 2, isDeleted: false }),
      7,
    );
    expect(revived.isDeleted).toBe(false);
    expect(revived.version).toBe(8);
  });
});
