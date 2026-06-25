import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v3";

import {BotAccessDeniedError, type CollabBot, ReadOnlyError,} from "./bot/CollabBot";
import {logError, logInfo, logWarn} from "./logger";
import {type ArrangeOptions, BOUND_TEXT_PADDING, measureText, wrapText,} from "./verify";

import type {AccessibleBoard} from "./boards";
import type {ExcalidrawElement} from "./types";

const boardIdShape = {
  boardId: z
    .string()
    .describe("Target board id. Use list_boards to discover accessible boards."),
};

const elementFields = {
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
  fontFamily: z.number().optional(),
  textAlign: z.string().optional(),
  verticalAlign: z.string().optional(),
};

const createShape = {
  ...boardIdShape,
  ...elementFields,
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

const validateShape = {
  ...boardIdShape,
  disabledRules: z.array(z.string()).optional(),
  viewBackgroundColor: z.string().optional(),
};

const measureShape = {
  text: z.string(),
  fontSize: z.number().optional(),
  fontFamily: z.number().optional(),
  maxWidth: z.number().optional(),
};

const boundsShape = {
  ...boardIdShape,
  ids: z.array(z.string()).optional(),
};

const elementAtShape = {
  ...boardIdShape,
  x: z.number(),
  y: z.number(),
};

const sceneDiffShape = {
  ...boardIdShape,
  sinceVersion: z.number().optional(),
};

const renderFields = {
  format: z.enum(["png", "svg"]).optional(),
  padding: z.number().optional(),
  scale: z.number().optional(),
  showGrid: z.boolean().optional(),
  gridSize: z.number().optional(),
  showLabels: z.boolean().optional(),
  viewBackgroundColor: z.string().optional(),
};

const renderShape = {
  ...boardIdShape,
  ...renderFields,
};

const renderRegionShape = {
  ...boardIdShape,
  ...renderFields,
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
};

const renderElementShape = {
  ...boardIdShape,
  ...renderFields,
  ids: z.array(z.string()),
};

const connectShape = {
  ...boardIdShape,
  fromId: z.string(),
  toId: z.string(),
  mode: z.enum(["inside", "orbit", "skip"]).optional(),
  startArrowhead: z.string().nullable().optional(),
  endArrowhead: z.string().nullable().optional(),
};

const batchCreateShape = {
  ...boardIdShape,
  elements: z.array(z.object(elementFields)),
};

const arrangeShape = {
  ...boardIdShape,
  ids: z.array(z.string()),
  mode: z.enum(["grid", "row", "column", "align", "distribute"]),
  columns: z.number().optional(),
  gap: z.number().optional(),
  gapX: z.number().optional(),
  gapY: z.number().optional(),
  align: z.string().optional(),
  edge: z
    .enum(["left", "right", "top", "bottom", "centerX", "centerY"])
    .optional(),
  axis: z.enum(["horizontal", "vertical"]).optional(),
  originX: z.number().optional(),
  originY: z.number().optional(),
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

const toolError = (name: string, error: unknown, startedAt: number) => {
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
};

type ToolContent = {
  isError?: boolean;
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
};

const runRawTool = async (
  name: string,
  fn: () => Promise<ToolContent>,
): Promise<ToolContent> => {
  const startedAt = Date.now();
  logInfo("mcp.tool.started", { tool: name });
  try {
    const result = await fn();
    logInfo("mcp.tool.succeeded", { tool: name, durationMs: Date.now() - startedAt });
    return result;
  } catch (error) {
    return toolError(name, error, startedAt);
  }
};

const imageResult = (png: string, meta: unknown): ToolContent => ({
  content: [
    { type: "image", data: png, mimeType: "image/png" },
    { type: "text", text: JSON.stringify(meta, null, 2) },
  ],
});

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

  server.registerTool(
    "validate_scene",
    {
      description:
        "Run the deterministic self-review lint over a board: overlaps, text overflow, broken/unbound arrow bindings, occlusion, duplicates, alignment, contrast and style issues. Returns findings with element ids and machine-actionable suggestions, plus a connectivity graph.",
      inputSchema: validateShape,
    },
    async (args) =>
      runTool("validate_scene", async () => {
        const { boardId, ...options } = args;
        const bot = await ctx.resolveBot(boardId);
        return bot.validateScene(options);
      }),
  );

  server.registerTool(
    "measure_text",
    {
      description:
        "Measure wrapped text width/height for a font (and the container size needed to fit it) without touching a board. Use before creating text so containers are sized correctly.",
      inputSchema: measureShape,
    },
    async (args) =>
      runTool("measure_text", async () => {
        const fontSize = args.fontSize ?? 20;
        const wrapped =
          typeof args.maxWidth === "number"
            ? wrapText(args.text, fontSize, args.fontFamily, args.maxWidth)
            : args.text;
        const measured = measureText(wrapped, fontSize, args.fontFamily);
        return {
          width: Math.ceil(measured.width),
          height: Math.ceil(measured.height),
          lineCount: measured.lineCount,
          ...(wrapped !== args.text ? { wrappedText: wrapped } : {}),
          recommendedContainer: {
            width: Math.ceil(measured.width) + BOUND_TEXT_PADDING * 2,
            height: Math.ceil(measured.height) + BOUND_TEXT_PADDING * 2,
          },
        };
      }),
  );

  server.registerTool(
    "get_bounds",
    {
      description:
        "Return the rotation-aware bounding box of the whole board, or of a set of element ids.",
      inputSchema: boundsShape,
    },
    async (args) =>
      runTool("get_bounds", async () => {
        const bot = await ctx.resolveBot(args.boardId);
        return bot.getBounds(args.ids);
      }),
  );

  server.registerTool(
    "element_at",
    {
      description:
        "Return the top-most (highest z-order) element under a scene-coordinate point, or null. Use with the render transform to map an image pixel back to an element.",
      inputSchema: elementAtShape,
    },
    async (args) =>
      runTool("element_at", async () => {
        const bot = await ctx.resolveBot(args.boardId);
        return bot.elementAt(args.x, args.y);
      }),
  );

  server.registerTool(
    "scene_diff",
    {
      description:
        "Return elements changed since a given sceneVersion, split by origin (bot vs incoming human edits). Omit sinceVersion to list everything the bot considers current.",
      inputSchema: sceneDiffShape,
    },
    async (args) =>
      runTool("scene_diff", async () => {
        const bot = await ctx.resolveBot(args.boardId);
        return bot.sceneDiff(args.sinceVersion);
      }),
  );

  const buildArrangeOptions = (args: {
    mode: "grid" | "row" | "column" | "align" | "distribute";
    columns?: number;
    gap?: number;
    gapX?: number;
    gapY?: number;
    align?: string;
    edge?: "left" | "right" | "top" | "bottom" | "centerX" | "centerY";
    axis?: "horizontal" | "vertical";
    originX?: number;
    originY?: number;
  }): ArrangeOptions => {
    switch (args.mode) {
      case "grid":
        return {
          mode: "grid",
          columns: args.columns,
          gapX: args.gapX,
          gapY: args.gapY,
          originX: args.originX,
          originY: args.originY,
        };
      case "row":
        return {
          mode: "row",
          gap: args.gap,
          align: (args.align as "top" | "center" | "bottom") ?? "top",
          originX: args.originX,
          originY: args.originY,
        };
      case "column":
        return {
          mode: "column",
          gap: args.gap,
          align: (args.align as "left" | "center" | "right") ?? "left",
          originX: args.originX,
          originY: args.originY,
        };
      case "align":
        return { mode: "align", edge: args.edge ?? "left" };
      case "distribute":
        return { mode: "distribute", axis: args.axis ?? "horizontal" };
    }
  };

  const renderHandler = (
    name: string,
    args: { boardId: string; format?: "png" | "svg" } & Record<string, unknown>,
    extra: { region?: [number, number, number, number]; ids?: string[] },
  ) =>
    runRawTool(name, async () => {
      const bot = await ctx.resolveBot(args.boardId);
      const result = await bot.render({
        format: args.format,
        padding: args.padding as number | undefined,
        scale: args.scale as number | undefined,
        showGrid: args.showGrid as boolean | undefined,
        gridSize: args.gridSize as number | undefined,
        showLabels: args.showLabels as boolean | undefined,
        viewBackgroundColor: args.viewBackgroundColor as string | undefined,
        ...extra,
      });
      const meta = {
        format: result.format,
        transform: result.transform,
        legend: result.legend,
        width: result.width,
        height: result.height,
        sceneVersion: result.sceneVersion,
        ...(result.svg ? { svg: result.svg } : {}),
        ...(result.png ? {} : { note: "PNG rasterizer unavailable; returning SVG." }),
      };
      if (result.format === "png" && result.png) {
        return imageResult(result.png, { ...meta, svg: undefined });
      }
      return textResult(meta);
    });

  server.registerTool(
    "render_scene",
    {
      description:
        "Render the whole board to PNG (when the rasterizer is available) or SVG, with Set-of-Mark id labels, an optional grid, a scene→pixel transform and an element legend. Use the legend + transform to map anything you see back to an element id.",
      inputSchema: renderShape,
    },
    async (args) => renderHandler("render_scene", args, {}),
  );

  server.registerTool(
    "render_region",
    {
      description:
        "Render a scene-coordinate rectangle of the board (x, y, width, height) the same way as render_scene.",
      inputSchema: renderRegionShape,
    },
    async (args) =>
      renderHandler("render_region", args, {
        region: [args.x, args.y, args.x + args.width, args.y + args.height],
      }),
  );

  server.registerTool(
    "render_element",
    {
      description:
        "Focus-render one or more elements by id (cropped to their bounds) the same way as render_scene.",
      inputSchema: renderElementShape,
    },
    async (args) => renderHandler("render_element", args, { ids: args.ids }),
  );

  server.registerTool(
    "connect",
    {
      description:
        "Create an arrow that is properly bound between two shapes (sets FixedPointBinding on both ends and the boundElements back-references) so it stays attached when the shapes move. Bot write access required.",
      inputSchema: connectShape,
    },
    async (args) =>
      runTool("connect", async () => {
        const bot = await ctx.resolveBot(args.boardId);
        return bot.connectElements(args.fromId, args.toId, {
          mode: args.mode,
          startArrowhead: args.startArrowhead,
          endArrowhead: args.endArrowhead,
        });
      }),
  );

  server.registerTool(
    "batch_create",
    {
      description:
        "Create multiple elements in a single commit (one broadcast/persist). Returns the created elements plus inline lint warnings. Bot write access required.",
      inputSchema: batchCreateShape,
    },
    async (args) =>
      runTool("batch_create", async () => {
        const bot = await ctx.resolveBot(args.boardId);
        return bot.createElements(
          args.elements as Array<Partial<ExcalidrawElement> & { type: string }>,
        );
      }),
  );

  server.registerTool(
    "arrange",
    {
      description:
        "Re-layout a set of elements: grid, row, column, align (left/right/top/bottom/centerX/centerY) or distribute (horizontal/vertical). Bot write access required.",
      inputSchema: arrangeShape,
    },
    async (args) =>
      runTool("arrange", async () => {
        const bot = await ctx.resolveBot(args.boardId);
        return bot.arrange(args.ids, buildArrangeOptions(args));
      }),
  );

  server.registerTool(
    "undo_last",
    {
      description:
        "Revert the bot's last mutation on a board (session-scoped). Bot write access required.",
      inputSchema: boardIdShape,
    },
    async (args) =>
      runTool("undo_last", async () => {
        const bot = await ctx.resolveBot(args.boardId);
        return bot.undoLast();
      }),
  );

  return server;
}
