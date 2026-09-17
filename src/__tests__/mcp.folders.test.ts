import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {InMemoryTransport} from "@modelcontextprotocol/sdk/inMemory.js";
import {describe, expect, it, vi} from "vitest";

import {FolderPermissionDeniedError} from "../folders";
import {buildMcpServer, type McpContext} from "../mcp";

const connect = async (overrides: Partial<McpContext>) => {
  const ctx: McpContext = {
    resolveBot: vi.fn(),
    listBoards: vi.fn(async () => []),
    createBoard: vi.fn(async () => ({ boardId: "b" })),
    setBoardDescription: vi.fn(async () => ({
      boardId: "b",
      title: "B",
      description: null,
    })),
    listFolders: vi.fn(async () => []),
    createFolder: vi.fn(async () => ({
      folderId: "f",
      name: "F",
      created: true,
    })),
    ...overrides,
  };
  const server = buildMcpServer(ctx);
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, ctx };
};

const firstText = (result: unknown): string => {
  const content = (result as { content: { type: string; text?: string }[] })
    .content;
  return content.find((part) => part.type === "text")?.text ?? "";
};

describe("folder tools", () => {
  it("advertises create_folder with a required name and list_folders with no input", async () => {
    const { client } = await connect({});
    const tools = (await client.listTools()).tools;
    const create = tools.find((tool) => tool.name === "create_folder");
    expect(create?.inputSchema.required).toEqual(["name"]);
    expect(tools.find((tool) => tool.name === "list_folders")).toBeDefined();
  });

  it("creates a folder and returns whether it was new", async () => {
    const createFolder = vi.fn(async () => ({
      folderId: "f1",
      name: "Backend",
      created: false,
    }));
    const { client } = await connect({ createFolder });
    const result = await client.callTool({
      name: "create_folder",
      arguments: { name: "Backend" },
    });
    expect(createFolder).toHaveBeenCalledWith({ name: "Backend" });
    expect(JSON.parse(firstText(result))).toEqual({
      folderId: "f1",
      name: "Backend",
      created: false,
    });
  });

  it("lists folders", async () => {
    const { client } = await connect({
      listFolders: vi.fn(async () => [
        { folderId: "f1", name: "Backend", boardIds: ["b1"] },
      ]),
    });
    const result = await client.callTool({ name: "list_folders", arguments: {} });
    expect(JSON.parse(firstText(result))).toEqual([
      { folderId: "f1", name: "Backend", boardIds: ["b1"] },
    ]);
  });

  it("relays a withheld sub-permission as a tool error", async () => {
    const { client } = await connect({
      createFolder: vi.fn(async () => {
        throw new FolderPermissionDeniedError(
          'its owner can turn on "Create folders" (under "Create boards")',
        );
      }),
    });
    const result = await client.callTool({
      name: "create_folder",
      arguments: { name: "Nope" },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(firstText(result)).toContain("Create folders");
  });

  it("passes folderId through create_board", async () => {
    const createBoard = vi.fn(async () => ({ boardId: "b" }));
    const { client } = await connect({ createBoard });
    await client.callTool({
      name: "create_board",
      arguments: { title: "Retro", folderId: "f1" },
    });
    expect(createBoard).toHaveBeenCalledWith({
      title: "Retro",
      visibility: undefined,
      folderId: "f1",
    });
  });
});
