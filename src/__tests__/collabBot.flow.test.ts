import {randomBytes} from "crypto";

import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {InMemoryTransport} from "@modelcontextprotocol/sdk/inMemory.js";
import {beforeEach, describe, expect, it, vi} from "vitest";

import type {ExcalidrawElement} from "../types";
import type {BoardProfile} from "../profile";
import type {SceneLogInput} from "../scene";
import {asLinear} from "../verify/model";

// A fake Firestore scene doc with the real merge semantics, so the tests see
// what a reload would see.
const store = vi.hoisted(() => ({
  elements: new Map<string, unknown>(),
  history: [] as string[],
  log: [] as Array<Record<string, unknown>>,
  roomKey: "",
}));

vi.mock("../scene", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../scene")>();
  const { mergeForPersist } = await import("../reconcile");
  return {
    ...actual,
    persistScene: vi.fn(
      async (
        _roomId: string,
        _roomKey: string,
        elements: readonly ExcalidrawElement[],
        opts: { reviveIds?: ReadonlySet<string>; log?: SceneLogInput } = {},
      ) => {
        const mine = actual.getSyncableElements(elements);
        const stored = [...store.elements.values()] as ExcalidrawElement[];
        const merge = mergeForPersist(mine, stored, opts.reviveIds);
        store.elements = new Map(merge.merged.map((element) => [element.id, element]));
        if (opts.log) {
          store.log.unshift({ ...opts.log, ts: Date.now(), sceneVersionAfter: actual.getSceneVersion(merge.merged) });
        }
        return {
          sceneVersion: actual.getSceneVersion(merge.merged),
          storedWins: merge.storedWins,
          bumped: merge.bumped,
        };
      },
    ),
    appendSceneHistory: vi.fn(async () => {
      const id = `h${store.history.length + 1}`;
      store.history.push(id);
      return id;
    }),
    loadScene: vi.fn(async () => [...store.elements.values()]),
    listSceneHistory: vi.fn(async () => []),
    loadSceneHistoryEntry: vi.fn(async () => null),
    appendSceneLogEntry: vi.fn(async () => undefined),
    listSceneLog: vi.fn(async (_roomId: string, opts: { limit?: number; ids?: string[] } = {}) =>
      store.log
        .filter((entry) => !opts.ids?.length || (entry.ids as string[]).some((id) => opts.ids!.includes(id)))
        .slice(0, opts.limit ?? 20)
        .map((entry) => ({ ...entry, hasBefore: !!entry.before })),
    ),
    getSceneLogEntry: vi.fn(async (_roomId: string, commitId: string) => {
      const entry = store.log.find((row) => row.commitId === commitId);
      return entry ? { ...entry, hasBefore: !!entry.before } : null;
    }),
    loadSceneLogBefore: vi.fn(async (_roomId: string, roomKey: string, commitId: string) => {
      const entry = store.log.find((row) => row.commitId === commitId);
      const before = entry?.before as { ciphertext: Uint8Array; iv: Uint8Array } | undefined;
      if (!before) return null;
      const { decryptJSON } = await import("../encryption");
      return decryptJSON(roomKey, before.ciphertext, before.iv);
    }),
  };
});

import {CollabBot} from "../bot/CollabBot";
import {buildMcpServer, type McpContext} from "../mcp";

const makeBot = (): CollabBot => {
  const bot = new CollabBot({ uid: "u1", boardId: "board1", role: "editor" });
  const internals = bot as unknown as {
    roomKey: string;
    socket: unknown;
    elements: Map<string, ExcalidrawElement>;
  };
  internals.roomKey = store.roomKey || (store.roomKey = randomBytes(16).toString("base64url"));
  internals.socket = { connected: true, id: "sock", emit: () => undefined };
  // A "restart": the bot's memory is exactly what the store has.
  internals.elements = new Map(
    [...store.elements.values()].map((element) => [
      (element as ExcalidrawElement).id,
      element as ExcalidrawElement,
    ]),
  );
  return bot;
};

const connect = async (bot: CollabBot, profile?: BoardProfile) => {
  const saved: BoardProfile[] = [];
  const ctx: McpContext = {
    resolveBot: async () => bot,
    loadBoardProfile: async () => profile ?? null,
    saveBoardProfile: async (_scope, next) => {
      saved.push(next);
      profile = next;
      return next;
    },
    listBoards: async () => [],
    createBoard: async () => ({}),
    setBoardDescription: vi.fn(),
    renameBoard: vi.fn(),
    listFolders: async () => [],
    createFolder: vi.fn(),
    moveBoardToFolder: vi.fn(),
  };
  const server = buildMcpServer(ctx);
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = (await client.callTool({ name, arguments: { boardId: "board1", ...args } })) as {
      isError?: boolean;
      content: Array<{ type: string; text?: string }>;
    };
    const text = result.content.find((part) => part.type === "text")?.text ?? "{}";
    const body = JSON.parse(text);
    if (result.isError) {
      throw Object.assign(new Error(body.error?.message ?? text), { body });
    }
    return body;
  };
  return { client, call, saved };
};

const stored = (id: string): ExcalidrawElement | undefined => {
  const element = store.elements.get(id) as ExcalidrawElement | undefined;
  return element && !element.isDeleted ? element : undefined;
};

beforeEach(() => {
  store.elements = new Map();
  store.history = [];
  store.log = [];
});

describe("I01: delete → recreate with the same id → restart", () => {
  it("keeps the element in storage and after a reload", async () => {
    const { call } = await connect(makeBot());
    await call("batch_create", {
      elements: [
        { type: "rectangle", id: "a", x: 0, y: 0, width: 100, height: 60 },
        { type: "rectangle", id: "b", x: 300, y: 0, width: 100, height: 60 },
        { type: "arrow", id: "db_11", fromId: "a", toId: "b" },
      ],
    });
    const deleted = await call("delete_elements", { ids: ["db_11"] });
    expect(deleted.changed.deleted).toEqual(["db_11"]);
    const recreated = await call("batch_create", {
      elements: [{ type: "arrow", id: "db_11", fromId: "a", toId: "b" }],
    });
    expect(recreated.changed.revived).toEqual([expect.objectContaining({ id: "db_11" })]);
    expect(recreated.persisted).toEqual({ ok: true });
    expect(recreated.sceneVersion).toBeGreaterThan(recreated.prevSceneVersion);
    expect(stored("db_11")).toBeDefined();

    // Restart: a fresh bot loads the store and still has it.
    const { call: callAfter } = await connect(makeBot());
    const read = await callAfter("query_elements", { target: { ids: ["db_11"] } });
    expect(read.total).toBe(1);
    const check = await callAfter("validate_scene", { codes: ["not_persisted"], summaryOnly: true });
    expect(check.summary.errors).toBe(0);
  });

  it("lifts a creation above a stored tombstone the bot never saw", async () => {
    const bot = makeBot();
    const { call } = await connect(bot);
    await call("batch_create", { elements: [{ type: "rectangle", id: "k1", width: 50, height: 50 }] });
    // Someone else deletes it and the bot misses the broadcast.
    const current = store.elements.get("k1") as ExcalidrawElement;
    store.elements.set("k1", { ...current, isDeleted: true, version: current.version + 7 });
    const internals = bot as unknown as { elements: Map<string, ExcalidrawElement> };
    internals.elements.set("k1", { ...current, isDeleted: true, version: current.version + 1 });
    const again = await call("batch_create", {
      elements: [{ type: "rectangle", id: "k1", width: 50, height: 50 }],
      return: "full",
    });
    expect(stored("k1")).toBeDefined();
    const liftedTo = stored("k1")!.version;
    expect(liftedTo).toBeGreaterThan(current.version + 7);
    // The response says so, with the version to use from now on.
    expect(again.persisted).toEqual({ ok: true, lifted: [{ id: "k1", version: liftedTo }] });
    expect(again.elements.find((element: ExcalidrawElement) => element.id === "k1").version).toBe(liftedTo);
    const edited = await call("update_elements", { elements: [{ id: "k1", x: 40 }], options: { expect: { k1: liftedTo } } });
    expect(edited.changed.updated).toContain("k1");
  });

  it("concurrent writes on one bot do not undo a revival", async () => {
    const bot = makeBot();
    const { call } = await connect(bot);
    await call("batch_create", { elements: [{ type: "rectangle", id: "r1", width: 50, height: 50 }] });
    const current = store.elements.get("r1") as ExcalidrawElement;
    store.elements.set("r1", { ...current, isDeleted: true, version: current.version + 9 });
    const internals = bot as unknown as { elements: Map<string, ExcalidrawElement> };
    internals.elements.set("r1", { ...current, isDeleted: true, version: current.version + 1 });
    await Promise.all([
      call("batch_create", { elements: [{ type: "rectangle", id: "other", x: 300, width: 50, height: 50 }] }),
      call("batch_create", { elements: [{ type: "rectangle", id: "r1", width: 50, height: 50 }] }),
      call("batch_create", { elements: [{ type: "rectangle", id: "third", x: 600, width: 50, height: 50 }] }),
    ]);
    expect(stored("r1")).toBeDefined();
    expect(stored("other")).toBeDefined();
    expect(stored("third")).toBeDefined();
    expect(internals.elements.get("r1")!.isDeleted).toBe(false);
  });
});

describe("write envelope over MCP", () => {
  it("reports ignored fields instead of silently dropping them", async () => {
    const { call } = await connect(makeBot());
    await call("batch_create", { elements: [{ type: "rectangle", id: "r", width: 50, height: 50 }] });
    const result = await call("update_elements", { elements: [{ id: "r", colour: "red", x: 10 }] });
    expect(result.ignoredFields).toEqual([expect.objectContaining({ id: "r", field: "colour" })]);
    expect(result.changed.updated).toContain("r");
    await expect(
      call("update_elements", { elements: [{ id: "r", colour: "red" }], options: { strict: "error" } }),
    ).rejects.toMatchObject({ body: { error: { code: "unsupported_field" } } });
  });

  it("dry run does not write", async () => {
    const { call } = await connect(makeBot());
    await call("batch_create", { elements: [{ type: "rectangle", id: "r", x: 0, width: 50, height: 50 }] });
    const dry = await call("update_elements", { elements: [{ id: "r", x: 500 }], options: { dryRun: true } });
    expect(dry.dryRun).toBe(true);
    expect(stored("r")!.x).toBe(0);
  });

  it("moves a frame with its content in one call", async () => {
    const { call } = await connect(makeBot());
    await call("batch_create", {
      elements: [
        { type: "frame", id: "f", x: 0, y: 0, width: 400, height: 300, name: "01 · Flow" },
        { type: "rectangle", id: "n1", x: 20, y: 40, width: 100, height: 60, frameId: "f", label: "Node" },
      ],
    });
    await call("move_elements", { target: { frameName: "01 · Flow" }, dy: 200 });
    expect(stored("n1")!.y).toBe(240);
    expect(stored("n1:label")!.y).toBeGreaterThan(240);
  });

  it("creates and widens a table, and reads it back in reading order", async () => {
    const { call } = await connect(makeBot());
    const first = await call("set_table", {
      tableId: "t_err",
      spec: {
        origin: { x: 0, y: 0 },
        columns: [
          { key: "s", header: "Symptom" },
          { key: "c", header: "Cause" },
        ],
        rows: [{ key: "spin", cells: { s: "Spinner hangs", c: "no binding" } }],
      },
    });
    expect(first.cells.spin.s).toBe("t_err:spin:s");
    expect(stored("t_err:spin:s:label")).toBeDefined();
    const before = stored("t_err:spin:c")!;
    await call("set_table", { tableId: "t_err", spec: { columns: [{ key: "c", width: 440 }] } });
    expect(stored("t_err:spin:c")!.width).toBeGreaterThan(before.width);
    const md = await call("query_elements", { target: { kind: "table-cell" }, format: "md" });
    expect(md.items).toContain("Spinner hangs");
  });

  it("creates a code card, a callout and a badge from batch_create types", async () => {
    const { call } = await connect(makeBot());
    await call("batch_create", {
      elements: [{ type: "rectangle", id: "gw", x: 400, y: 0, width: 200, height: 80, label: "Gateway" }],
    });
    const result = await call("batch_create", {
      elements: [
        { type: "code", id: "cc", x: 0, y: 0, code: "init(\n  ports = 1\n)", title: "Step 2" },
        { type: "callout", id: "note1", anchorId: "gw", text: "Retries capped at 3" },
        { type: "badge", id: "b1", anchorId: "gw", text: "2" },
      ],
    });
    expect(result.ids).toEqual(expect.arrayContaining(["cc", "note1", "b1"]));
    const codeLabel = stored("cc:label") as ExcalidrawElement & { originalText?: string };
    expect(codeLabel.originalText).toContain("  ports = 1");
    const pointer = stored("note1:ptr") as ExcalidrawElement & { endBinding?: { elementId: string } };
    expect(pointer.endBinding?.elementId).toBe("gw");
  });

  it("returns structured errors", async () => {
    const { call } = await connect(makeBot());
    await call("batch_create", { elements: [{ type: "rectangle", id: "x", width: 10, height: 10 }] });
    await expect(
      call("batch_create", { elements: [{ type: "rectangle", id: "x", width: 10, height: 10 }] }),
    ).rejects.toMatchObject({ body: { error: { code: "conflict", retryable: false } } });
  });

  it("restores a deleted element with its label from the tombstone", async () => {
    const { call } = await connect(makeBot());
    await call("batch_create", {
      elements: [{ type: "rectangle", id: "keep", x: 0, y: 0, width: 120, height: 60, label: "Keep me" }],
    });
    await call("delete_elements", { ids: ["keep"] });
    expect(stored("keep")).toBeUndefined();
    const restored = await call("restore", { ids: ["keep"] });
    expect(restored.restored).toEqual(expect.arrayContaining(["keep"]));
    expect(stored("keep")).toBeDefined();
    expect(stored("keep:label")).toBeDefined();
  });

  it("repair_scene is a dry run by default", async () => {
    const { call } = await connect(makeBot());
    await call("batch_create", { elements: [{ type: "rectangle", id: "p", width: 10, height: 10 }] });
    const dry = await call("repair_scene", { codes: ["not_persisted"], target: { ids: ["p"] } });
    expect(dry.dryRun).toBe(true);
    expect(dry.applied).toEqual([{ code: "not_persisted", id: "p" }]);
  });
});

describe("integrity over MCP", () => {
  it("validate reports a phantom (live in memory, tombstone in storage) and repair_scene fixes it", async () => {
    const bot = makeBot();
    const { call } = await connect(bot);
    await call("batch_create", { elements: [{ type: "rectangle", id: "ph", width: 50, height: 50 }] });
    // Simulate the old bug: the store holds a newer tombstone the bot never saw.
    const current = store.elements.get("ph") as ExcalidrawElement;
    store.elements.set("ph", { ...current, isDeleted: true, version: current.version + 3 });
    const report = await call("validate_scene", { codes: ["not_persisted"] });
    expect(report.findings.map((finding: { code: string }) => finding.code)).toEqual(["not_persisted"]);
    expect(report.findings[0].suggestion.tool).toBe("repair_scene");
    const fixed = await call("repair_scene", { codes: ["not_persisted"], target: { ids: ["ph"] }, options: { dryRun: false } });
    expect(fixed.applied).toEqual([{ code: "not_persisted", id: "ph" }]);
    expect(stored("ph")).toBeDefined();
    const clean = await call("validate_scene", { codes: ["not_persisted"], summaryOnly: true });
    expect(clean.summary.errors).toBe(0);
  });

  it("repairs a stale back-reference with the lint's planner", async () => {
    const bot = makeBot();
    const { call } = await connect(bot);
    await call("batch_create", {
      elements: [
        { type: "rectangle", id: "a", x: 0, y: 0, width: 100, height: 60 },
        { type: "rectangle", id: "b", x: 300, y: 0, width: 100, height: 60 },
      ],
    });
    const internals = bot as unknown as { elements: Map<string, ExcalidrawElement> };
    const a = internals.elements.get("a")!;
    internals.elements.set("a", { ...a, boundElements: [{ id: "ghost", type: "arrow" }], version: a.version + 1 });
    const found = await call("validate_scene", { profile: "integrity", checkPersisted: false });
    const codes = found.findings.map((finding: { code: string }) => finding.code);
    expect(codes).toContain("binding_backref_stale");
    const dry = await call("repair_scene", { codes: ["binding_backref_stale"] });
    expect(dry.dryRun).toBe(true);
    expect(dry.applied).toEqual([{ code: "binding_backref_stale", id: "a" }]);
    await call("repair_scene", { codes: ["binding_backref_stale"], options: { dryRun: false } });
    const after = await call("validate_scene", { profile: "integrity", checkPersisted: false, summaryOnly: true });
    expect(after.summary.errors).toBe(0);
  });
});

describe("the change journal (I13)", () => {
  it("logs every commit and reverts one from its own snapshot", async () => {
    const { call } = await connect(makeBot());
    await call("batch_create", {
      elements: [{ type: "rectangle", id: "n1", x: 0, y: 0, width: 200, height: 80, label: "Ports" }],
    });
    const edit = await call("update_elements", {
      elements: [{ id: "n1", label: "Ports you implement", x: 400 }],
      options: { note: "renamed for the series" },
    });
    await call("batch_create", { elements: [{ type: "rectangle", id: "n2", x: 0, y: 200, width: 100, height: 50 }] });

    const log = await call("board_log", { ids: ["n1"] });
    const entry = log.entries.find((row: { commitId: string }) => row.commitId === edit.commitId);
    expect(entry).toMatchObject({ op: "update", restorable: true, note: "renamed for the series" });
    expect(entry.ids).toContain("n1");

    const reverted = await call("restore", { ids: [], from: edit.commitId, mode: "revert" });
    expect(reverted.restored).toContain("n1");
    expect(stored("n1")!.x).toBe(0);
    const text = await call("query_elements", { target: { ids: ["n1"] } });
    expect(text.items[0].label).toBe("Ports");
    // n2 was created by a later commit and must be untouched.
    expect(stored("n2")).toBeDefined();
  });

  it("revert removes what that commit created", async () => {
    const { call } = await connect(makeBot());
    const created = await call("batch_create", {
      elements: [{ type: "rectangle", id: "tmp", width: 50, height: 50 }],
    });
    expect(stored("tmp")).toBeDefined();
    await call("restore", { ids: [], from: created.commitId, mode: "revert" });
    expect(stored("tmp")).toBeUndefined();
  });
});

describe("copy, stacks and atomic op batches", () => {
  it("copies a frame with its children and re-binds the copied arrows", async () => {
    const { call } = await connect(makeBot());
    await call("batch_create", {
      elements: [
        { type: "frame", id: "f", x: 0, y: 0, width: 400, height: 200, name: "01 · Flow" },
        { type: "rectangle", id: "a", x: 20, y: 40, width: 100, height: 60, frameId: "f", label: "A" },
        { type: "rectangle", id: "b", x: 250, y: 40, width: 100, height: 60, frameId: "f" },
        { type: "arrow", id: "ab", fromId: "a", toId: "b", frameId: "f" },
      ],
    });
    const copied = await call("copy_elements", { target: { ids: ["f"] } });
    expect(copied.idMap.a).toBe("a-copy");
    const copy = stored("a-copy")!;
    expect(copy.y).toBeGreaterThan(stored("a")!.y);
    expect(stored("a-copy:label")).toBeDefined();
    expect(asLinear(stored("ab-copy")!).startBinding?.elementId).toBe("a-copy");
    expect(stored("ab-copy")!.frameId).toBe("f-copy");
    // The originals are untouched.
    expect(stored("a")!.y).toBe(40);
  });

  it("a stack keeps its gaps when a member grows", async () => {
    const { call } = await connect(makeBot());
    await call("batch_create", {
      elements: [
        { type: "rectangle", id: "r1", x: 0, y: 0, width: 200, height: 60, label: "One" },
        { type: "rectangle", id: "r2", x: 0, y: 80, width: 200, height: 60, label: "Two" },
        { type: "rectangle", id: "r3", x: 0, y: 160, width: 200, height: 60, label: "Three" },
      ],
    });
    const stack = await call("create_stack", { ids: ["r1", "r2", "r3"] });
    expect(stack.members).toEqual(["r1", "r2", "r3"]);
    await call("update_elements", { elements: [{ id: "r1", height: 120 }] });
    expect(stored("r2")!.y).toBe(140);
    expect(stored("r3")!.y).toBe(220);
    // Taken out of the stack, r2 stays where it is and r3 follows r1 directly.
    await call("update_elements", { elements: [{ id: "r2", stack: null }] });
    await call("update_elements", { elements: [{ id: "r1", height: 60 }] });
    expect(stored("r2")!.y).toBe(140);
    expect(stored("r3")!.y).toBe(80);
  });

  it("apply_ops runs a delete and a re-create as one commit", async () => {
    const { call } = await connect(makeBot());
    await call("batch_create", { elements: [{ type: "text", id: "h_l2", x: 0, y: 0, text: "Layer 2" }] });
    const result = await call("apply_ops", {
      ops: [
        { op: "delete", ids: ["h_l2"] },
        { op: "create", elements: [{ type: "rectangle", id: "h_l2", x: 0, y: 0, width: 160, height: 60, label: "Layer 2", role: "process" }] },
        { op: "move", target: { ids: ["h_l2"] }, dy: 40 },
      ],
    });
    expect(result.applied.map((entry: { op: string }) => entry.op)).toEqual(["delete", "create", "move"]);
    expect(store.history).toHaveLength(2);
    expect(stored("h_l2")!.type).toBe("rectangle");
    expect(stored("h_l2")!.y).toBe(40);
    expect(stored("h_l2:label")).toBeDefined();
  });
});

describe("the board profile (I29b)", () => {
  const profile: BoardProfile = {
    typeScale: { body: 22, colHeader: 26, caption: 12 },
    spacing: { cellPadding: 16 },
    nowrap: ["Gateway API"],
    roles: { accent: { tag: "[YOU]", meaning: "our team owns it" } },
  };

  it("sizes a table from the profile instead of the built-in defaults", async () => {
    const { call } = await connect(makeBot(), profile);
    await call("set_table", {
      tableId: "t1",
      spec: {
        origin: { x: 0, y: 0 },
        columns: [{ key: "a", header: "A" }],
        rows: [{ key: "r1", cells: { a: "one" } }],
      },
    });
    const cell = await call("query_elements", { target: { type: "text" }, fields: ["id", "fontSize"] });
    const sizes = Object.fromEntries(
      (cell.items as Array<{ id: string; fontSize?: number }>).map((item) => [item.id, item.fontSize]),
    );
    // The header follows colHeader, the body cell follows body.
    expect(sizes["t1:_h:a:label"]).toBe(26);
    expect(sizes["t1:r1:a:label"]).toBe(22);
  });

  it("lints font sizes and role tags against the profile", async () => {
    const { call } = await connect(makeBot(), profile);
    await call("batch_create", {
      elements: [
        { type: "rectangle", id: "odd", x: 0, y: 0, width: 200, height: 80, label: "off scale", labelFontSize: 19 },
      ],
    });
    // The profile rules live in visual-qa: without a profile there is no
    // contract to check against, so they stay out of the default pass.
    const report = await call("validate_scene", { profile: "visual-qa", target: { ids: ["odd", "odd:label"] } });
    const codes = (report.findings as Array<{ code: string }>).map((finding) => finding.code);
    expect(codes).toContain("style_font_size_off_profile");
    expect(report.summary.coverage).toContain("semantic_conflict");
  });

  it("builds a legend from the profile's own vocabulary", async () => {
    const { call } = await connect(makeBot(), {
      ...profile,
      strokeStyles: { dashed: "[planned]" },
    });
    const legend = await call("set_legend", {
      legendId: "lg",
      origin: { x: 0, y: 400 },
      fromProfile: true,
    });
    expect(legend.ids.length).toBeGreaterThan(0);
    const texts = [...store.elements.values()]
      .map((element) => (element as ExcalidrawElement & { originalText?: string }).originalText)
      .filter(Boolean);
    expect(texts).toContain("[YOU] — our team owns it");
    expect(texts).toContain("[planned]");
  });

  it("says so instead of drawing an empty legend when there is no profile", async () => {
    const { call } = await connect(makeBot());
    await expect(call("set_legend", { legendId: "lg", origin: { x: 0, y: 0 }, fromProfile: true })).rejects.toThrow(
      /no profile roles/,
    );
  });

  it("reads and writes the profile over set_board_profile", async () => {
    const { call, saved } = await connect(makeBot());
    const read = await call("set_board_profile", { scope: { boardId: "board1" } });
    expect(read.profile).toBeDefined();
    await call("set_board_profile", { scope: { boardId: "board1" }, typeScale: { body: 18 } });
    expect(saved.at(-1)?.typeScale?.body).toBe(18);
  });
});
