import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v3";

import { ReadOnlyError, type CollabBot } from "./bot/CollabBot";
import { logError, logInfo, logWarn } from "./logger";

import type { ExcalidrawElement } from "./types";

const createShape = {
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
  type: z.string().optional(),
  ids: z.array(z.string()).optional(),
};

const deleteShape = {
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
      return errorResult("read-only access");
    }
    logError("mcp.tool.failed", error, {
      tool: name,
      durationMs: Date.now() - startedAt,
    });
    return errorResult(error instanceof Error ? error.message : String(error));
  }
};

export function buildMcpServer(bot: CollabBot): McpServer {
  const server = new McpServer({
    name: "excalidraw-access-backend",
    version: "1.0.0",
  });

  server.registerTool(
    "describe_scene",
    {
      description:
        "Return the current non-deleted elements of the collab board as JSON.",
      inputSchema: {},
    },
    async () => runTool("describe_scene", () => bot.describeScene()),
  );

  server.registerTool(
    "query_elements",
    {
      description: "Return elements optionally filtered by type and/or ids.",
      inputSchema: queryShape,
    },
    async (args) =>
      runTool("query_elements", () =>
        bot.queryElements(args as { type?: string; ids?: string[] }),
      ),
  );

  server.registerTool(
    "create_element",
    {
      description:
        "Create a new Excalidraw element on the board (editor role required).",
      inputSchema: createShape,
    },
    async (args) =>
      runTool("create_element", () =>
        bot.createElement(
          args as Partial<ExcalidrawElement> & { type: string },
        ),
      ),
  );

  server.registerTool(
    "update_element",
    {
      description:
        "Update properties of an existing element by id (editor role required).",
      inputSchema: updateShape,
    },
    async (args) => {
      const { id, ...patch } = args as { id: string } & Partial<ExcalidrawElement>;
      return runTool("update_element", () => bot.updateElement(id, patch));
    },
  );

  server.registerTool(
    "delete_element",
    {
      description: "Delete an element by id (editor role required).",
      inputSchema: deleteShape,
    },
    async (args) =>
      runTool("delete_element", async () => {
        const { id } = args as { id: string };
        await bot.deleteElement(id);
        return { deleted: id };
      }),
  );

  server.registerTool(
    "clear_canvas",
    {
      description: "Delete all elements on the board (editor role required).",
      inputSchema: {},
    },
    async () =>
      runTool("clear_canvas", async () => ({
        deletedCount: await bot.clearCanvas(),
      })),
  );

  return server;
}
