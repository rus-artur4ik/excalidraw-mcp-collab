import {randomBytes} from "crypto";

import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {InMemoryTransport} from "@modelcontextprotocol/sdk/inMemory.js";
import {beforeEach, describe, expect, it, vi} from "vitest";

import type {ExcalidrawElement} from "../types";

// A fake Firestore scene doc with the real merge semantics, so the tests see
// what a reload would see.
const store = vi.hoisted(() => ({
  elements: new Map<string, unknown>(),
  history: [] as string[],
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
        opts: { reviveIds?: ReadonlySet<string> } = {},
      ) => {
        const mine = actual.getSyncableElements(elements);
        const stored = [...store.elements.values()] as ExcalidrawElement[];
        const merge = mergeForPersist(mine, stored, opts.reviveIds);
        store.elements = new Map(merge.merged.map((element) => [element.id, element]));
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
  internals.roomKey = randomBytes(16).toString("base64url");
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

const connect = async (bot: CollabBot) => {
  const ctx: McpContext = {
    resolveBot: async () => bot,
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
  return { client, call };
};

const stored = (id: string): ExcalidrawElement | undefined => {
  const element = store.elements.get(id) as ExcalidrawElement | undefined;
  return element && !element.isDeleted ? element : undefined;
};

beforeEach(() => {
  store.elements = new Map();
  store.history = [];
});

describe("common writes leave no new lint findings (I17/I37 noise regression)", () => {
  it("diagram, table, code card, legend, callout, frame, rename and move are clean", async () => {
    const { call } = await connect(makeBot());
    const newCodes = (result: { lint?: { new?: Array<{ code: string }> } }) =>
      (result.lint?.new ?? []).map((finding) => finding.code);
    expect(
      newCodes(
        await call("create_diagram", {
          diagramId: "d",
          origin: { x: 0, y: 0 },
          nodes: [
            { id: "app", label: "Приложение", role: "external" },
            { id: "sdk", label: "ChatKit SDK", role: "process", group: "g" },
            { id: "store", label: "Хранилище сообщений", role: "process", group: "g" },
            { id: "ok", label: "Готово?", role: "decision" },
            { id: "err", label: "Ошибка сети", role: "error" },
          ],
          edges: [
            { from: "app", to: "sdk", label: "init()" },
            { from: "sdk", to: "store" },
            { from: "store", to: "ok" },
            { from: "ok", to: "err", label: "нет" },
          ],
          groups: [{ id: "g", label: "SDK" }],
        }),
      ),
    ).toEqual([]);
    expect(
      newCodes(
        await call("set_table", {
          tableId: "t",
          spec: {
            origin: { x: 700, y: 0 },
            numbered: "1.",
            columns: [{ key: "s", header: "Симптом" }, { key: "c", header: "Причина", maxWidth: 260 }],
            rows: [
              { key: "a", cells: { s: "Висит спиннер", c: "нет биндинга между view и store" } },
              { key: "b", cells: { s: "Пустой экран", c: "токен истёк" } },
            ],
          },
        }),
      ),
    ).toEqual([]);
    expect(
      newCodes(
        await call("batch_create", {
          elements: [{ type: "code", id: "cc", x: 700, y: 400, title: "Шаг 2", source: "Sample.kt:108", code: "ChatKit.init(\n    ports = listOf(8080),\n)" }],
        }),
      ),
    ).toEqual([]);
    expect(
      newCodes(
        await call("set_legend", {
          legendId: "lg",
          origin: { x: 0, y: 1200 },
          items: [{ role: "process", label: "SDK" }, { role: "external", label: "Внешнее" }, { strokeStyle: "dashed", label: "План" }, { arrow: true, label: "Вызов" }],
        }),
      ),
    ).toEqual([]);
    expect(newCodes(await call("batch_create", { elements: [{ type: "callout", id: "co", anchorId: "d:err", text: "Повторить 3 раза" }] }))).toEqual([]);
    expect(
      newCodes(
        await call("create_frame", {
          id: "f1",
          name: "01 · Поток",
          childIds: ["d:app", "d:g", "d:sdk", "d:store", "d:ok", "d:err", "d:app->d:sdk", "d:sdk->d:store", "d:store->d:ok", "d:ok->d:err"],
          padding: 32,
        }),
      ),
    ).toEqual([]);
    expect(newCodes(await call("update_elements", { elements: [{ id: "d:store", label: "Локальное хранилище сообщений и вложений" }] }))).toEqual([]);
    expect(newCodes(await call("move_elements", { target: { frameIds: ["f1"] }, dy: 100 }))).toEqual([]);
    const full = await call("validate_scene", { checkPersisted: false, summaryOnly: true });
    expect(full.summary.errors + full.summary.warnings).toBe(0);
  });
});
