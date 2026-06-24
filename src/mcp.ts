import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v3";

import {
  BotAccessDeniedError,
  ReadOnlyError,
  type CollabBot,
} from "./bot/CollabBot";
import { logError, logInfo, logWarn } from "./logger";

import type { AccessibleBoard } from "./boards";
import type { ExcalidrawElement } from "./types";

const boardIdShape = {
  boardId: z
    .string()
    .describe("Target board id. Use list_boards to discover accessible boards."),
};

const createShape = {
  ...boardIdShape,
  type: z
    .string()
    .describe("Excalidraw element type, e.g. rectangle, ellipse, text, line"),
  id: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  angle: z.number().optional(),
  strokeColor: z.string().optional(),
  backgroundColor: z.string().optional(),
  fillStyle: z.string().optional(),
  strokeWidth: z.number().optional(),
  strokeStyle: z.string().optional(),
  roughness: z.number().optional(),
  opacity: z.number().optional(),
  text: z.string().optional(),
  fontSize: z.number().optional(),
  textAlign: z.string().optional(),
};

const updateShape = {
  ...boardIdShape,
  id: z.string(),
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  angle: z.number().optional(),
  strokeColor: z.string().optional(),
  backgroundColor: z.string().optional(),
  fillStyle: z.string().optional(),
  strokeWidth: z.number().optional(),
  strokeStyle: z.string().optional(),
  roughness: z.number().optional(),
  opacity: z.number().optional(),
  text: z.string().optional(),
  fontSize: z.number().optional(),
  textAlign: z.string().optional(),
};

const queryShape = {
  ...boardIdShape,
  type: z.string().optional(),
  ids: z.array(z.string()).optional(),
};

const deleteShape = {
  ...boardIdShape,
  id: z.string(),
};

const textResult = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

const errorResult = (message: string) => ({
  isError: true,
  content: [{ type: "text" as const, text: message }],
});

const runTool = async (name: string, fn: () => Promise<unknown>) => {
  const startedAt = Date.now();
  logInfo("mcp.tool.started", { tool: name });
  try {
    const result = await fn();
    logInfo("mcp.tool.succeeded", {
      tool: name,
      durationMs: Date.now() - startedAt,
    });
    return textResult(result);
  } catch (error) {
    if (error instanceof ReadOnlyError) {
      logWarn("mcp.tool.read_only_denied", { tool: name });
      return errorResult("read-only access on this board");
    }
    if (error instanceof BotAccessDeniedError) {
      logWarn("mcp.tool.access_denied", { tool: name });
      return errorResult(error.message);
    }
    logError("mcp.tool.failed", error, {
      tool: name,
      durationMs: Date.now() - startedAt,
    });
    return errorResult(error instanceof Error ? error.message : String(error));
  }
};

export type McpContext = {
  resolveBot: (boardId: string) => Promise<CollabBot>;
  listBoards: () => Promise<AccessibleBoard[]>;
};

export function buildMcpServer(ctx: McpContext): McpServer {
  const server = new McpServer({
    name: "excalidraw-team",
    version: "1.0.0",
  });

  server.registerTool(
    "list_boards",
    {
      description:
        "List the boards this account can access through the bot, with the bot's access level (read or write) on each.",
      inputSchema: {},
    },
    async () => runTool("list_boards", () => ctx.listBoards()),
  );

  server.registerTool(
    "describe_scene",
    {
      description: "Return the current non-deleted elements of a board as JSON.",
      inputSchema: boardIdShape,
    },
    async (args) =>
      runTool("describe_scene", async () => {
        const bot = await ctx.resolveBot(args.boardId);
        return bot.describeScene();
      }),
  );

  server.registerTool(
    "query_elements",
    {
      description: "Return elements of a board optionally filtered by type and/or ids.",
      inputSchema: queryShape,
    },
    async (args) =>
      runTool("query_elements", async () => {
        const { boardId, ...filter } = args as {
          boardId: string;
          type?: string;
          ids?: string[];
        };
        const bot = await ctx.resolveBot(boardId);
        return bot.queryElements(filter);
      }),
  );

  server.registerTool(
    "create_element",
    {
      description:
        "Create a new Excalidraw element on a board (bot write access required).",
      inputSchema: createShape,
    },
    async (args) =>
      runTool("create_element", async () => {
        const { boardId, ...attrs } = args as {
          boardId: string;
        } & Partial<ExcalidrawElement> & { type: string };
        const bot = await ctx.resolveBot(boardId);
        return bot.createElement(attrs);
      }),
  );

  server.registerTool(
    "update_element",
    {
      description:
        "Update properties of an existing element by id (bot write access required).",
      inputSchema: updateShape,
    },
    async (args) =>
      runTool("update_element", async () => {
        const { boardId, id, ...patch } = args as {
          boardId: string;
          id: string;
        } & Partial<ExcalidrawElement>;
        const bot = await ctx.resolveBot(boardId);
        return bot.updateElement(id, patch);
      }),
  );

  server.registerTool(
    "delete_element",
    {
      description: "Delete an element by id (bot write access required).",
      inputSchema: deleteShape,
    },
    async (args) =>
      runTool("delete_element", async () => {
        const { boardId, id } = args as { boardId: string; id: string };
        const bot = await ctx.resolveBot(boardId);
        await bot.deleteElement(id);
        return { deleted: id };
      }),
  );

  server.registerTool(
    "clear_canvas",
    {
      description: "Delete all elements on a board (bot write access required).",
      inputSchema: boardIdShape,
    },
    async (args) =>
      runTool("clear_canvas", async () => {
        const bot = await ctx.resolveBot(args.boardId);
        return { deletedCount: await bot.clearCanvas() };
      }),
  );

  return server;
}
