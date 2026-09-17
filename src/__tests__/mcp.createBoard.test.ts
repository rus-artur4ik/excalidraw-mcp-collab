import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {InMemoryTransport} from "@modelcontextprotocol/sdk/inMemory.js";
import {describe, expect, it, vi} from "vitest";

import {BoardCreationDeniedError} from "../bots";
import {buildMcpServer, type McpContext} from "../mcp";

const connect = async (overrides: Partial<McpContext>) => {
  const ctx: McpContext = {
    resolveBot: vi.fn(),
    listBoards: vi.fn(async () => []),
    createBoard: vi.fn(async () => ({ boardId: "b" })),
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

describe("create_board tool", () => {
  it("is advertised with a required title and an optional visibility", async () => {
    const { client } = await connect({});
    const tool = (await client.listTools()).tools.find(
      (candidate) => candidate.name === "create_board",
    );
    expect(tool).toBeDefined();
    expect(tool?.inputSchema.required).toEqual(["title"]);
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual([
      "title",
      "visibility",
      "folderId",
    ]);
  });

  it("forwards the arguments and returns the created board", async () => {
    const createBoard = vi.fn(async () => ({
      boardId: "abc",
      title: "Retro",
      visibility: "team",
      botAccess: "write",
      url: "https://app.example/b/abc",
    }));
    const { client } = await connect({ createBoard });

    const result = await client.callTool({
      name: "create_board",
      arguments: { title: "Retro", visibility: "team" },
    });

    expect(createBoard).toHaveBeenCalledWith({
      title: "Retro",
      visibility: "team",
      folderId: undefined,
    });
    expect(JSON.parse(firstText(result))).toMatchObject({
      boardId: "abc",
      botAccess: "write",
    });
  });

  it("reports a withheld permission as a tool error the agent can relay", async () => {
    const { client } = await connect({
      createBoard: vi.fn(async () => {
        throw new BoardCreationDeniedError(
          'this bot is not allowed to create boards; its owner can turn on "Create boards" in the bot\'s settings',
        );
      }),
    });

    const result = await client.callTool({
      name: "create_board",
      arguments: { title: "Nope" },
    });

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(firstText(result)).toContain("Create boards");
  });

  it("rejects a call without a title before it reaches the backend", async () => {
    const createBoard = vi.fn();
    const { client } = await connect({ createBoard });
    const result = await client.callTool({
      name: "create_board",
      arguments: {},
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(createBoard).not.toHaveBeenCalled();
  });
});
