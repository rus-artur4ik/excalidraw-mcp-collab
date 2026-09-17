import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {InMemoryTransport} from "@modelcontextprotocol/sdk/inMemory.js";
import {describe, expect, it, vi} from "vitest";

import {BoardEditDeniedError} from "../boards";
import {BotAccessDeniedError, ReadOnlyError} from "../bot/CollabBot";
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

const isError = (result: unknown): boolean =>
  (result as { isError?: boolean }).isError === true;

describe("set_board_description tool", () => {
  it("is advertised with a required boardId and description", async () => {
    const { client } = await connect({});
    const tool = (await client.listTools()).tools.find(
      (candidate) => candidate.name === "set_board_description",
    );
    expect(tool?.inputSchema.required).toEqual(["boardId", "description"]);
  });

  it("forwards the arguments and returns the stored description", async () => {
    const setBoardDescription = vi.fn(async () => ({
      boardId: "abc",
      title: "Retro",
      description: "What went well",
    }));
    const { client } = await connect({ setBoardDescription });

    const result = await client.callTool({
      name: "set_board_description",
      arguments: { boardId: "abc", description: "What went well" },
    });

    expect(setBoardDescription).toHaveBeenCalledWith({
      boardId: "abc",
      description: "What went well",
    });
    expect(JSON.parse(firstText(result))).toEqual({
      boardId: "abc",
      title: "Retro",
      description: "What went well",
    });
  });

  it("relays a settings denial so the agent can tell the user who can change it", async () => {
    const { client } = await connect({
      setBoardDescription: vi.fn(async () => {
        throw new BoardEditDeniedError(
          "only the board's owner (or a team admin, for a team board) can change its description",
        );
      }),
    });
    const result = await client.callTool({
      name: "set_board_description",
      arguments: { boardId: "abc", description: "x" },
    });
    expect(isError(result)).toBe(true);
    expect(firstText(result)).toContain("owner");
  });

  it("reports missing access and read-only access like the drawing tools", async () => {
    const denied = await connect({
      setBoardDescription: vi.fn(async () => {
        throw new BotAccessDeniedError("abc");
      }),
    });
    const noAccess = await denied.client.callTool({
      name: "set_board_description",
      arguments: { boardId: "abc", description: "x" },
    });
    expect(isError(noAccess)).toBe(true);
    expect(firstText(noAccess)).toContain("access denied to board abc");

    const readOnly = await connect({
      setBoardDescription: vi.fn(async () => {
        throw new ReadOnlyError();
      }),
    });
    const viewer = await readOnly.client.callTool({
      name: "set_board_description",
      arguments: { boardId: "abc", description: "x" },
    });
    expect(isError(viewer)).toBe(true);
    expect(firstText(viewer)).toContain("read-only");
  });

  it("rejects a call without a description before it reaches the backend", async () => {
    const setBoardDescription = vi.fn();
    const { client } = await connect({ setBoardDescription });
    const result = await client.callTool({
      name: "set_board_description",
      arguments: { boardId: "abc" },
    });
    expect(isError(result)).toBe(true);
    expect(setBoardDescription).not.toHaveBeenCalled();
  });
});
