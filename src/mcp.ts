import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v3";

import {BotAccessDeniedError, type CollabBot, ReadOnlyError,} from "./bot/CollabBot";
import {BOARD_DESCRIPTION_MAX_LENGTH, BoardEditDeniedError} from "./boards";
import {BoardCreationDeniedError} from "./bots";
import {FolderPermissionDeniedError, type CreatedFolder, type FolderSummary} from "./folders";
import {logError, logInfo, logWarn} from "./logger";
import {type ArrangeOptions, containerSizeForText, measureText, ROLE_NAMES, wrapText,} from "./verify";
import {DIAGRAM_GUIDE, PALETTE_JSON, SERVER_README} from "./guide";

import type {AccessibleBoard, BoardDescriptionResult} from "./boards";
import type {ExcalidrawElement} from "./types";

const boardIdShape = {
  boardId: z
    .string()
    .describe("Target board id. Use list_boards to discover accessible boards."),
};

const boardDescriptionField = z
  .string()
  .describe(
    `One or two plain sentences on what the board is for, shown under its name in the app's board list (never on the board itself) and returned by list_boards. Up to ${BOARD_DESCRIPTION_MAX_LENGTH} characters; line breaks collapse into spaces and longer text is cut.`,
  );

const createBoardShape = {
  title: z
    .string()
    .describe("Board name as it appears in the app's board list. Keep it short and human-readable."),
  description: boardDescriptionField.optional(),
  visibility: z
    .enum(["private", "team", "link"])
    .optional()
    .describe(
      "Who can open the board (default private): private = the owner and people they invite; team = everyone on the shared team, and the owning account must be a team member; link = anyone with the link can view, never edit. Pick the narrowest that fits — the owner can widen it later in the board's Access dialog.",
    ),
  folderId: z
    .string()
    .optional()
    .describe(
      "File the new board into this folder of the owner's home page (an id from list_folders or create_folder). Needs the bot's \"Create folders\" permission. Folders only organize the owner's board list; they never change who can open a board.",
    ),
};

const setBoardDescriptionShape = {
  ...boardIdShape,
  description: boardDescriptionField.describe(
    `New description for the board, shown under its name in the app's board list (never on the board itself). Up to ${BOARD_DESCRIPTION_MAX_LENGTH} characters; line breaks collapse into spaces and longer text is cut. Pass an empty string to remove the description.`,
  ),
};

const createFolderShape = {
  name: z
    .string()
    .describe(
      "Folder name as it appears on the owner's home page, up to 60 characters. Short topic names work best (e.g. \"Backend\", \"Q4 planning\").",
    ),
};

const elementFields = {
  type: z
    .string()
    .describe("Excalidraw element type, e.g. rectangle, ellipse, text, line"),
  role: z
    .string()
    .optional()
    .describe(
      "Semantic style role (process, decision, terminal, error, external, accent, note, neutral): fills backgroundColor/strokeColor/labelColor from the board palette so colors stay consistent. Explicit colors win. See get_diagram_guide.",
    ),
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
  fontSize: z
    .number()
    .optional()
    .describe(
      "Font size. Alongside `label` it styles the LABEL (a container has no text of its own), not the shape.",
    ),
  fontFamily: z
    .number()
    .optional()
    .describe("Font family id. Alongside `label` it styles the LABEL."),
  textAlign: z.string().optional(),
  verticalAlign: z.string().optional(),
  points: z
    .array(z.tuple([z.number(), z.number()]))
    .optional()
    .describe(
      "line/arrow vertices relative to x,y. Omit and a line/arrow is auto-built as a 2-point segment from width/height (so it is never zero-length). Never use `points` to draw an arrow between two shapes — use fromId/toId (+ `waypoints`/`route` to detour), or the arrow will not stay attached.",
    ),
  waypoints: z
    .array(z.tuple([z.number(), z.number()]))
    .optional()
    .describe(
      "Absolute scene points a fromId/toId arrow must pass through. Bindings are preserved, so you can route around an obstacle without giving up attachment. Fixes `arrow_crosses_element`.",
    ),
  route: z
    .enum(["direct", "orthogonal"])
    .optional()
    .describe(
      "Path shape for a fromId/toId arrow: direct (default) or orthogonal (server-computed elbow). Bindings are preserved.",
    ),
  lintIgnore: z
    .array(z.string())
    .optional()
    .describe(
      'Rule codes validate_scene must not report for THIS element, e.g. ["arrow_unbound_endpoint"]. Use "isolated" to drop it from graph.isolated (legend boxes). Persisted in customData. Prefer this over the board-wide disabledRules.',
    ),
  containerId: z
    .string()
    .optional()
    .describe(
      "Bind this text to a container shape or arrow: it is centered, auto-sized and moves with the container, and is excluded from overlap warnings.",
    ),
  label: z
    .string()
    .optional()
    .describe(
      "On rectangle/ellipse/diamond/arrow: also create a bound text label inside the shape in the same call. `fontSize`/`fontFamily`/`labelColor` on the same item style this label. The created text id comes back in the response `labels` map.",
    ),
  labelColor: z
    .string()
    .optional()
    .describe("Stroke color for the bound text created via `label`."),
  labelFontSize: z
    .number()
    .optional()
    .describe("Font size for the bound text created via `label`; overrides `fontSize`."),
  labelFontFamily: z
    .number()
    .optional()
    .describe("Font family for the bound text created via `label`; overrides `fontFamily`."),
  frameId: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Put this element inside an existing frame (the frame's id) as it is created, so it moves and clips with the frame.",
    ),
  fromId: z
    .string()
    .optional()
    .describe(
      "On an arrow: bind its start to this shape id. With `toId`, the arrow is created already bound (FixedPointBinding + back-references) so it stays attached when either shape moves — no follow-up connect call. Batch-friendly.",
    ),
  toId: z
    .string()
    .optional()
    .describe("On an arrow: bind its end to this shape id (pairs with `fromId`)."),
  bindMode: z
    .enum(["inside", "orbit", "skip"])
    .optional()
    .describe("Binding mode for a fromId/toId arrow (default orbit)."),
  startArrowhead: z.string().nullable().optional(),
  endArrowhead: z.string().nullable().optional(),
  fileId: z
    .string()
    .optional()
    .describe(
      "On an image element: id returned by upload_file. The element gets status \"saved\" and scale [1,1] automatically.",
    ),
};

const uploadFileShape = {
  ...boardIdShape,
  data: z
    .string()
    .describe("File content: base64 bytes or a full data URL (data:image/png;base64,...)."),
  mimeType: z
    .string()
    .optional()
    .describe("Required when `data` is bare base64; inferred from a data URL otherwise."),
};

const projectionShape = {
  fields: z
    .array(z.string())
    .optional()
    .describe(
      'Return only these fields per element (`id` is always included). Trims a huge scene dump to what you need, e.g. ["type","x","y","index","containerId"].',
    ),
  limit: z
    .number()
    .optional()
    .describe("Return at most this many elements (paginate with offset)."),
  offset: z
    .number()
    .optional()
    .describe("Skip this many elements first. Elements are ordered by z-order (bottom→top)."),
};

const describeSceneShape = {
  ...boardIdShape,
  ...projectionShape,
};

const queryShape = {
  ...boardIdShape,
  ...projectionShape,
  type: z.string().optional(),
  ids: z.array(z.string()).optional(),
  groupId: z.string().optional(),
};

const zOrderShape = {
  ...boardIdShape,
  ids: z
    .array(z.string())
    .describe("Element ids to move. A container's bound-text label moves with it."),
};

const reorderShape = {
  ...zOrderShape,
  anchorId: z
    .string()
    .describe("Reference element to move the ids next to (must not be one of `ids`)."),
  position: z
    .enum(["above", "below"])
    .optional()
    .describe("Place the ids just above (default) or just below the anchor in z-order."),
};

const frameAddChildrenShape = {
  ...boardIdShape,
  frameId: z.string(),
  childIds: z
    .array(z.string())
    .describe("Elements to move into the frame; their bound-text labels follow."),
};

const returnFieldShape = {
  return: z
    .enum(["full", "ids"])
    .optional()
    .describe(
      'Response shape. "ids" returns only created/updated element ids (default \"full\" echoes whole elements, which can be large).',
    ),
};

const updateElementsShape = {
  ...boardIdShape,
  ...returnFieldShape,
  elements: z
    .array(z.object({ id: z.string() }).catchall(z.unknown()))
    .describe("Patches, each an object with `id` plus the fields to change."),
};

const deleteElementsShape = {
  ...boardIdShape,
  ids: z.array(z.string()).optional(),
  groupId: z
    .string()
    .optional()
    .describe("Delete every element carrying this groupId (whole-group delete)."),
};

const deleteRegionShape = {
  ...boardIdShape,
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  mode: z
    .enum(["intersect", "contain"])
    .optional()
    .describe(
      "intersect (default) deletes anything touching the rect; contain deletes only fully-enclosed elements.",
    ),
  type: z.string().optional().describe("Restrict deletion to this element type."),
};

const groupShape = {
  ...boardIdShape,
  ids: z.array(z.string()),
};

const ungroupShape = {
  ...boardIdShape,
  ids: z.array(z.string()).optional(),
  groupId: z.string().optional(),
};

const createFrameShape = {
  ...boardIdShape,
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  name: z.string().optional(),
  childIds: z
    .array(z.string())
    .optional()
    .describe(
      "Elements to put inside the frame; if x/y/width/height are omitted the frame is sized to fit them.",
    ),
};

const regionShape = z
  .object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
  })
  .describe("Scene-coordinate rectangle to scope the lint to.");

const validateShape = {
  ...boardIdShape,
  disabledRules: z.array(z.string()).optional(),
  viewBackgroundColor: z.string().optional(),
  ids: z
    .array(z.string())
    .optional()
    .describe("Only report findings that involve at least one of these elements."),
  region: regionShape.optional(),
  codes: z
    .array(z.string())
    .optional()
    .describe("Only report findings with one of these rule codes."),
  minSeverity: z
    .enum(["error", "warning", "info"])
    .optional()
    .describe("Drop findings below this severity."),
  summaryOnly: z
    .boolean()
    .optional()
    .describe("Return only the counts/summary and graph, omitting the findings list."),
};

const measureShape = {
  text: z.string(),
  fontSize: z.number().optional(),
  fontFamily: z.number().optional(),
  maxWidth: z.number().optional(),
  containerType: z
    .enum(["rectangle", "diamond", "ellipse"])
    .optional()
    .describe(
      "Shape the text will live in (default rectangle). A diamond/ellipse inscribes its label, so it needs a much bigger box for the same text — `recommendedContainer` accounts for that.",
    ),
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
  ids: z.array(z.string()).optional(),
  groupId: z
    .string()
    .optional()
    .describe("Focus-render every element in this group instead of explicit ids."),
};

const connectShape = {
  ...boardIdShape,
  fromId: z.string(),
  toId: z.string(),
  mode: z.enum(["inside", "orbit", "skip"]).optional(),
  startArrowhead: z.string().nullable().optional(),
  endArrowhead: z.string().nullable().optional(),
  waypoints: z
    .array(z.tuple([z.number(), z.number()]))
    .optional()
    .describe(
      "Absolute scene points the arrow must pass through; both bindings are preserved.",
    ),
  route: z
    .enum(["direct", "orthogonal"])
    .optional()
    .describe("direct (default) or orthogonal elbow routing; bindings are preserved."),
};

const batchCreateShape = {
  ...boardIdShape,
  ...returnFieldShape,
  elements: z.array(z.object(elementFields)),
};

const diagramNodeShape = z.object({
  id: z.string().describe("Your reference id for edges; the element gets a fresh id (see `nodes` in the result)."),
  label: z.string(),
  role: z
    .enum(ROLE_NAMES)
    .optional()
    .describe("Semantic style role; sets colors and default shape (decision→diamond, terminal→ellipse). Default process."),
  shape: z.enum(["rectangle", "ellipse", "diamond"]).optional(),
  width: z.number().optional().describe("Fixed size; omit to auto-size from the label."),
  height: z.number().optional(),
  group: z.string().optional().describe("Id of a `groups` entry to cluster this node into."),
});

const diagramEdgeShape = z.object({
  from: z.string(),
  to: z.string(),
  label: z.string().optional(),
  strokeStyle: z.enum(["solid", "dashed", "dotted"]).optional(),
  startArrowhead: z.string().nullable().optional(),
  endArrowhead: z.string().nullable().optional(),
});

const createDiagramShape = {
  ...boardIdShape,
  ...returnFieldShape,
  nodes: z.array(diagramNodeShape),
  edges: z.array(diagramEdgeShape),
  groups: z
    .array(z.object({ id: z.string(), label: z.string().optional() }))
    .optional()
    .describe("Named clusters drawn as dashed containers around their member nodes."),
  direction: z
    .enum(["DOWN", "RIGHT", "UP", "LEFT"])
    .optional()
    .describe("Main flow direction (default DOWN)."),
  spacing: z.number().optional().describe("Base gap between nodes (default 48)."),
  origin: z
    .object({ x: z.number(), y: z.number() })
    .optional()
    .describe("Scene position of the diagram's top-left corner; pick a free area (get_bounds) so it lands next to existing content."),
  fontSize: z.number().optional(),
  roughness: z.number().optional(),
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

const pickFields = (
  element: ExcalidrawElement,
  fields: string[],
): Record<string, unknown> => {
  const projected: Record<string, unknown> = { id: element.id };
  for (const field of fields) {
    if (field in element) {
      projected[field] = element[field];
    }
  }
  return projected;
};

const applyProjection = (
  elements: ExcalidrawElement[],
  opts: { fields?: string[]; limit?: number; offset?: number },
): unknown => {
  const paginated = opts.limit !== undefined || opts.offset !== undefined;
  if (!opts.fields && !paginated) {
    return elements;
  }
  const ordered = [...elements].sort((a, b) => {
    const ai = typeof a.index === "string" ? a.index : "";
    const bi = typeof b.index === "string" ? b.index : "";
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  });
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const end =
    opts.limit !== undefined
      ? offset + Math.max(0, Math.floor(opts.limit))
      : undefined;
  const page = paginated ? ordered.slice(offset, end) : ordered;
  const projected = opts.fields
    ? page.map((element) => pickFields(element, opts.fields as string[]))
    : page;
  return paginated
    ? { total: ordered.length, offset, count: projected.length, elements: projected }
    : projected;
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
    return toolError(name, error, startedAt);
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
  // A withheld permission is the owner's decision, not a fault: report it to
  // the agent verbatim so it can tell the user how to grant it.
  if (error instanceof BoardCreationDeniedError) {
    logWarn("mcp.tool.board_creation_denied", { tool: name });
    return errorResult(error.message);
  }
  if (error instanceof BoardEditDeniedError) {
    logWarn("mcp.tool.board_edit_denied", { tool: name });
    return errorResult(error.message);
  }
  if (error instanceof FolderPermissionDeniedError) {
    logWarn("mcp.tool.folder_permission_denied", { tool: name });
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

const SELF_REVIEW_HINT =
  "Self-review now: render_region the changed area, look at the image, then validate_scene scoped to the changed ids and apply each finding's `suggestion` (they carry ready-to-use numbers). Re-render until clean.";

const withSelfReview = (result: unknown): unknown => {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return result;
  }
  const warnings = (result as { warnings?: unknown[] }).warnings;
  const warningNote =
    Array.isArray(warnings) && warnings.length
      ? ` ${warnings.length} inline warning(s) above already include fix-ready suggestions.`
      : "";
  return { ...result, next: SELF_REVIEW_HINT + warningNote };
};

const SERVER_INSTRUCTIONS = `Excalidraw drawing tools for shared team boards.

When asked for a diagram or visualization, draw it HERE on a shared board — never produce local .excalidraw/PNG files (they live outside the board; the team can't see or edit them).

Before the FIRST write of a session, call read_me (data model, contracts, gotchas). Before the FIRST diagram, also call get_diagram_guide (style roles, palette, workflow, worked example).

Creating content:
- Graph-shaped diagrams (flowcharts, architectures, pipelines, dependency maps): use create_diagram — you pass nodes + edges + direction, the server computes the layout. Do not hand-compute coordinates for graphs.
- Free-form visuals: batch_create with \`label\` for text inside shapes (never a standalone text element over a shape) and \`fromId\`/\`toId\` for arrows (never manual points between shapes). Size containers with measure_text — pass \`containerType\` for diamonds/ellipses.
- To route an arrow around an obstacle, keep \`fromId\`/\`toId\` and add \`waypoints\` or \`route:"orthogonal"\` — dropping to manual \`points\` loses the binding.
- Colors: set \`role\` (process, decision, terminal, error, external, accent, note, neutral) instead of inventing hex values.

After EVERY write: render_region the changed area, look at the image, validate_scene the changed ids, apply each finding's \`suggestion\` (ready-to-use dx/dy, width/height, strokeColor, patch), re-render. 2-3 passes is normal. Never finish with unresolved errors.

Keep diagrams ≤20 nodes — split bigger content. Titles ≤6 words, no paragraphs on canvas. Emoji become tofu in PNG renders; use plain glyphs (✓ ★ × ·).`;

export type CreateBoardInput = {
  title: string;
  description?: string;
  visibility?: "private" | "team" | "link";
  folderId?: string;
};

export type McpContext = {
  resolveBot: (boardId: string) => Promise<CollabBot>;
  listBoards: () => Promise<AccessibleBoard[]>;
  createBoard: (input: CreateBoardInput) => Promise<unknown>;
  setBoardDescription: (input: {
    boardId: string;
    description: string;
  }) => Promise<BoardDescriptionResult>;
  listFolders: () => Promise<FolderSummary[]>;
  createFolder: (input: { name: string }) => Promise<CreatedFolder>;
};

export function buildMcpServer(ctx: McpContext): McpServer {
  const server = new McpServer(
    {
      name: "excalidraw-team",
      version: "1.0.0",
    },
    { instructions: SERVER_INSTRUCTIONS },
  );

  server.registerResource(
    "diagram-guide",
    "guide://excalidraw-team/diagram-guide.md",
    {
      title: "Diagram style & workflow guide",
      description:
        "How to draw well on these boards: workflow, semantic roles, palette, density caps, worked example.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: DIAGRAM_GUIDE }],
    }),
  );

  server.registerResource(
    "diagram-palette",
    "guide://excalidraw-team/palette.json",
    {
      title: "Semantic style palette",
      description: "Style roles (colors + default shapes) and the size ladder, as JSON.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: PALETTE_JSON }],
    }),
  );

  server.registerTool(
    "read_me",
    {
      description:
        "REQUIRED before the first write of a session: the mechanical contract of this server — which tool to reach for, how bound labels and their fonts work, why a diamond needs a bigger box than its text, how to route an arrow around an obstacle without losing its binding, what delete cleans up, how to silence one lint rule on one element, and the full rule-code list. Cheap and static; call once. Style advice lives in get_diagram_guide.",
      inputSchema: {},
    },
    async () => ({
      content: [{ type: "text" as const, text: SERVER_README }],
    }),
  );

  server.registerResource(
    "server-readme",
    "guide://excalidraw-team/README.md",
    {
      title: "Data model, contracts and gotchas",
      description:
        "Tool selection, bound labels, inscribed containers, arrow routing, delete semantics, lint opt-out, rule codes.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: SERVER_README }],
    }),
  );

  server.registerTool(
    "get_diagram_guide",
    {
      description:
        "REQUIRED before drawing the first diagram of a session: returns the board style guide — workflow, semantic color roles, size ladder, density caps and a worked create_diagram example. Cheap and static; call once and follow it.",
      inputSchema: {},
    },
    async () => ({
      content: [{ type: "text" as const, text: DIAGRAM_GUIDE }],
    }),
  );

  server.registerTool(
    "list_boards",
    {
      description:
        "List the boards this account can access through the bot as { boardId, title, description?, botAccess } — botAccess is the bot's access level (read or write); description is the owner's short note on what the board is for, when one is set. Start here: draw on an existing board whenever one fits, and only reach for create_board when the work genuinely needs a new one.",
      inputSchema: {},
    },
    async () => runTool("list_boards", () => ctx.listBoards()),
  );

  server.registerTool(
    "create_board",
    {
      description:
        "Create a new empty board, owned by the account this bot acts for, and grant this bot write access to it in the same step — the returned boardId is immediately usable by the drawing tools. Requires the per-bot \"Create boards\" permission (the owner turns it on in the bot's settings); without it the call fails with an explanation to relay, not something to retry. Check list_boards first and reuse a suitable board — one board per topic, not one per diagram. Give it a description saying what the board is for, so people (and later list_boards calls) can tell boards apart. Pass folderId to file the board into one of the owner's folders. Returns { boardId, title, description?, visibility, botAccess, url, folder? }.",
      inputSchema: createBoardShape,
    },
    async (args) =>
      runTool("create_board", () =>
        ctx.createBoard({
          title: args.title,
          description: args.description,
          visibility: args.visibility,
          folderId: args.folderId,
        }),
      ),
  );

  server.registerTool(
    "set_board_description",
    {
      description:
        "Set or replace the short description of an existing board — the note under its name in the app's board list (it is not drawn on the board). Pass an empty string to remove it. Needs write access to the board, and the account this bot acts for must be allowed to change the board's settings (its owner, or a team admin for a team board); otherwise the call fails with an explanation to relay, not something to retry. Returns { boardId, title, description } with the text as stored (null when removed).",
      inputSchema: setBoardDescriptionShape,
    },
    async (args) =>
      runTool("set_board_description", () =>
        ctx.setBoardDescription({
          boardId: args.boardId,
          description: args.description,
        }),
      ),
  );

  server.registerTool(
    "list_folders",
    {
      description:
        "List the folders on the owning account's home page as { folderId, name, boardIds } — boardIds only names boards this bot can reach. Folders are the owner's personal grouping of boards; they never change access. Requires the per-bot \"Create folders\" permission (a sub-permission of \"Create boards\"); without it the call fails with an explanation to relay.",
      inputSchema: {},
    },
    async () => runTool("list_folders", () => ctx.listFolders()),
  );

  server.registerTool(
    "create_folder",
    {
      description:
        "Create a folder on the owning account's home page so related boards can be kept together; pass the returned folderId to create_board to file a new board into it. Idempotent by name (case-insensitive): if the folder already exists it is returned with created:false, so check the result instead of inventing name variants. Requires the per-bot \"Create folders\" permission, which the owner can only turn on together with \"Create boards\"; a denial is an explanation to relay, not something to retry. Returns { folderId, name, created }.",
      inputSchema: createFolderShape,
    },
    async (args) =>
      runTool("create_folder", () => ctx.createFolder({ name: args.name })),
  );

  server.registerTool(
    "describe_scene",
    {
      description:
        "Return the current non-deleted elements of a board as JSON. Use `fields` to project only the columns you need and `limit`/`offset` to page — a full dump can be 100k+ characters. Paginated results come back z-ordered (bottom→top) as { total, offset, count, elements }.",
      inputSchema: describeSceneShape,
    },
    async (args) =>
      runTool("describe_scene", async () => {
        const bot = await ctx.resolveBot(args.boardId);
        const elements = await bot.describeScene();
        return applyProjection(elements, args);
      }),
  );

  server.registerTool(
    "query_elements",
    {
      description:
        "Return elements of a board optionally filtered by type and/or ids, with the same `fields`/`limit`/`offset` projection as describe_scene.",
      inputSchema: queryShape,
    },
    async (args) =>
      runTool("query_elements", async () => {
        const { boardId, fields, limit, offset, ...filter } = args as {
          boardId: string;
          fields?: string[];
          limit?: number;
          offset?: number;
          type?: string;
          ids?: string[];
          groupId?: string;
        };
        const bot = await ctx.resolveBot(boardId);
        const elements = await bot.queryElements(filter);
        return applyProjection(elements, { fields, limit, offset });
      }),
  );

  server.registerTool(
    "update_elements",
    {
      description:
        "Update many elements in a single commit. Each item is { id, ...fields }. Patch a container (or arrow) with { id, label:\"...\" } to edit (or add) its bound-text label without knowing the text's id — the label is re-laid out inside the box. Patch a bound arrow with { id, waypoints:[[x,y]] } or { id, route:\"orthogonal\" } to reroute it around an obstacle while both bindings survive; its label follows. Set `lintIgnore` to silence rules on one element. An explicit `index` (fractional key) is honored, so this also re-stacks elements. Missing/already-deleted ids are skipped and listed in `missing` rather than aborting the batch — the valid patches still commit atomically. Standalone text auto-resizes to its new content unless an explicit width+height is given. Any label created on the way back comes back in the `labels` map. Use return:\"ids\" to keep the response small. Bot write access required.",
      inputSchema: updateElementsShape,
    },
    async (args) =>
      runTool("update_elements", async () => {
        const bot = await ctx.resolveBot(args.boardId);
        return withSelfReview(
          await bot.updateElements(
            args.elements as Array<{ id: string } & Partial<ExcalidrawElement>>,
            { returnIds: args.return === "ids" },
          ),
        );
      }),
  );

  server.registerTool(
    "delete_elements",
    {
      description:
        "Delete many elements in a single commit, by ids or by groupId (whole group). Bound text is removed with its container, and every survivor is detached: boundElements back-references to the deleted ids are stripped and arrow bindings that pointed at them are nulled, so no binding_backref_missing / arrow_dangling_binding is left behind. Returns `deleted` and `detached` ids. Bot write access required.",
      inputSchema: deleteElementsShape,
    },
    async (args) =>
      runTool("delete_elements", async () => {
        const bot = await ctx.resolveBot(args.boardId);
        return bot.deleteElements({ ids: args.ids, groupId: args.groupId });
      }),
  );

  server.registerTool(
    "delete_region",
    {
      description:
        "Delete every element inside a scene-coordinate rectangle (mode intersect|contain), optionally filtered by type. Survivors are detached from the deleted elements exactly as in delete_elements. Useful for \"erase the old drawing then redraw\". Bot write access required.",
      inputSchema: deleteRegionShape,
    },
    async (args) =>
      runTool("delete_region", async () => {
        const bot = await ctx.resolveBot(args.boardId);
        return bot.deleteRegion(
          [args.x, args.y, args.x + args.width, args.y + args.height],
          { mode: args.mode, type: args.type },
        );
      }),
  );

  server.registerTool(
    "validate_scene",
    {
      description:
        "Run the deterministic self-review lint over a board: overlaps, text overflow, arrows crossing shapes, broken/unbound arrow bindings, occlusion, duplicates, alignment, contrast and style issues. Scope it with ids/region and trim it with codes/minSeverity/summaryOnly to keep the response small on big or shared boards. Returns findings with element ids and machine-actionable suggestions, plus a connectivity graph. To silence a rule for one deliberate exception set `lintIgnore` on that element instead of the board-wide `disabledRules`.",
      inputSchema: validateShape,
    },
    async (args) =>
      runTool("validate_scene", async () => {
        const { boardId, region, ...rest } = args;
        const bot = await ctx.resolveBot(boardId);
        return bot.validateScene({
          ...rest,
          region: region
            ? [region.x, region.y, region.x + region.width, region.y + region.height]
            : undefined,
        });
      }),
  );

  server.registerTool(
    "measure_text",
    {
      description:
        "Measure wrapped text width/height for a font (and the container size needed to fit it) without touching a board. Pass `containerType` so a diamond/ellipse gets a box that actually fits its inscribed label. Use before creating text so containers are sized correctly.",
      inputSchema: measureShape,
    },
    async (args) =>
      runTool("measure_text", async () => {
        const fontSize = args.fontSize ?? 20;
        const containerType = args.containerType ?? "rectangle";
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
          containerType,
          recommendedContainer: containerSizeForText(
            containerType,
            Math.ceil(measured.width),
            Math.ceil(measured.height),
          ),
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
        "Return elements changed since a given sceneVersion, split by stable ownership: `byOrigin.bot` are ids this bot created (it keeps owning them even after a human edits them), `byOrigin.incoming` are everyone else's. Also returns `owned` (all bot-created ids) and `conflicts` — bot-created elements a concurrent human session deleted or overwrote, including whether the bot re-asserted (resurrected) or yielded them. Omit sinceVersion to list everything the bot considers current.",
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
    extra: {
      region?: [number, number, number, number];
      ids?: string[];
      groupId?: string;
    },
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
        legendOrder: result.legendOrder,
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
        "Render the whole board to PNG (when the rasterizer is available) or SVG, with Set-of-Mark id labels, an optional grid, a scene→pixel transform and an element legend. The legend is sorted by z-order (legendOrder: \"z-ascending\", bottom→top) and each entry carries its `z` rank and fractional `index`, so the legend doubles as an occlusion/stacking map. Use the legend + transform to map anything you see back to an element id.",
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
        "Focus-render one or more elements (by id or by groupId), cropped to their bounds, the same way as render_scene.",
      inputSchema: renderElementShape,
    },
    async (args) =>
      renderHandler("render_element", args, {
        ids: args.ids,
        groupId: args.groupId,
      }),
  );

  server.registerTool(
    "connect",
    {
      description:
        "Create an arrow that is properly bound between two shapes (sets FixedPointBinding on both ends and the boundElements back-references) so it stays attached when the shapes move. Use `waypoints` or `route:\"orthogonal\"` to steer it around an obstacle without losing the binding. Bot write access required.",
      inputSchema: connectShape,
    },
    async (args) =>
      runTool("connect", async () => {
        const bot = await ctx.resolveBot(args.boardId);
        return withSelfReview(
          await bot.connectElements(args.fromId, args.toId, {
            mode: args.mode,
            startArrowhead: args.startArrowhead,
            endArrowhead: args.endArrowhead,
            waypoints: args.waypoints,
            route: args.route,
          }),
        );
      }),
  );

  server.registerTool(
    "batch_create",
    {
      description:
        "Create multiple elements in a single commit (one broadcast/persist). For a NEW diagram call get_diagram_guide first, and prefer create_diagram for graph-shaped content (it computes the layout for you). Supports semantic `role` styling, bound text (containerId / label), line/arrow points, `frameId` to drop an element straight into an existing frame, and arrows bound to shapes via `fromId`/`toId` (bound at creation — no per-arrow connect round-trips, and the shapes stay attached when moved). Returns the created elements (or just ids with return:\"ids\"), a `labels` map of containerId → bound-text id, plus inline lint warnings computed at commit time and any `conflicts`. The bot keeps ownership of the created ids and re-asserts them if a concurrent human session deletes them. Bot write access required.",
      inputSchema: batchCreateShape,
    },
    async (args) =>
      runTool("batch_create", async () => {
        const bot = await ctx.resolveBot(args.boardId);
        return withSelfReview(
          await bot.createElements(
            args.elements as Array<Partial<ExcalidrawElement> & { type: string }>,
            { returnIds: args.return === "ids" },
          ),
        );
      }),
  );

  server.registerTool(
    "upload_file",
    {
      description:
        "Upload an image to the board's file storage (encrypted with the room key, same format as browser uploads — every collaborator can load it). Returns `fileId`; place it with batch_create {type:\"image\", fileId, x, y, width, height}. The id is content-addressed (sha1), so re-uploading the same bytes reuses the stored file. Max 4 MiB; image mime types only. Bot write access required.",
      inputSchema: uploadFileShape,
    },
    async (args) =>
      runTool("upload_file", async () => {
        const bot = await ctx.resolveBot(args.boardId);
        return bot.uploadFile({ data: args.data, mimeType: args.mimeType });
      }),
  );

  server.registerTool(
    "create_diagram",
    {
      description:
        "PREFERRED way to draw any graph-shaped diagram (flowchart, architecture, pipeline, dependency map): pass nodes + edges + direction and the server computes the whole layout (ELK layered — no overlaps, clean layers, routed spacing), sizes nodes to their labels, applies semantic role colors and creates everything with bound labels and bound arrows in one commit. Never hand-compute coordinates for graph content. Returns the created elements, a `nodes` map (your node id → element id), a `labels` map (element id → its bound-text id) and the diagram `bounds` for render_region. Call get_diagram_guide first for roles and a worked example. Bot write access required.",
      inputSchema: createDiagramShape,
    },
    async (args) =>
      runTool("create_diagram", async () => {
        const bot = await ctx.resolveBot(args.boardId);
        const { boardId, return: returnMode, ...input } = args;
        return withSelfReview(
          await bot.createDiagram(input, { returnIds: returnMode === "ids" }),
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
        return withSelfReview(await bot.arrange(args.ids, buildArrangeOptions(args)));
      }),
  );

  server.registerTool(
    "group_elements",
    {
      description:
        "Group elements under a shared groupId so they can be moved, rendered (render_element groupId) or deleted (delete_elements groupId) as one unit. Bot write access required.",
      inputSchema: groupShape,
    },
    async (args) =>
      runTool("group_elements", async () => {
        const bot = await ctx.resolveBot(args.boardId);
        return bot.groupElements(args.ids);
      }),
  );

  server.registerTool(
    "ungroup_elements",
    {
      description:
        "Remove the innermost group from elements (by ids) or dissolve a group entirely (by groupId). Bot write access required.",
      inputSchema: ungroupShape,
    },
    async (args) =>
      runTool("ungroup_elements", async () => {
        const bot = await ctx.resolveBot(args.boardId);
        return bot.ungroupElements({ ids: args.ids, groupId: args.groupId });
      }),
  );

  server.registerTool(
    "create_frame",
    {
      description:
        "Create a frame (named container region) either with explicit x/y/width/height or sized to fit childIds. The frame is inserted at the BOTTOM of the z-order so its region never covers existing content, and listed children keep their own stacking (labels stay above their shapes) while getting frameId set so they move with the frame. Use frame_add_children to add more later. Bot write access required.",
      inputSchema: createFrameShape,
    },
    async (args) =>
      runTool("create_frame", async () => {
        const bot = await ctx.resolveBot(args.boardId);
        return bot.createFrame({
          x: args.x,
          y: args.y,
          width: args.width,
          height: args.height,
          name: args.name,
          childIds: args.childIds,
        });
      }),
  );

  server.registerTool(
    "bring_to_front",
    {
      description:
        "Raise elements to the top of the z-order (re-indexing only — ids, frame membership and bindings are preserved). A container's bound-text label is raised with it so it stays visible. Use to fix a label hidden under its shape's fill without delete-and-recreate. Bot write access required.",
      inputSchema: zOrderShape,
    },
    async (args) =>
      runTool("bring_to_front", async () => {
        const bot = await ctx.resolveBot(args.boardId);
        return bot.bringToFront(args.ids);
      }),
  );

  server.registerTool(
    "send_to_back",
    {
      description:
        "Lower elements to the bottom of the z-order (re-indexing only — ids, frame membership and bindings are preserved). A container's bound-text label moves with it. Bot write access required.",
      inputSchema: zOrderShape,
    },
    async (args) =>
      runTool("send_to_back", async () => {
        const bot = await ctx.resolveBot(args.boardId);
        return bot.sendToBack(args.ids);
      }),
  );

  server.registerTool(
    "reorder",
    {
      description:
        "Move elements to sit just above (default) or just below an anchor element in the z-order — re-indexing only, so ids/bindings/frame membership are stable. A container's bound-text label travels with it. Bot write access required.",
      inputSchema: reorderShape,
    },
    async (args) =>
      runTool("reorder", async () => {
        const bot = await ctx.resolveBot(args.boardId);
        return bot.reorder(args.ids, {
          to: args.position ?? "above",
          anchorId: args.anchorId,
        });
      }),
  );

  server.registerTool(
    "frame_add_children",
    {
      description:
        "Add existing elements to an existing frame (sets their frameId; bound-text labels follow their containers). Avoids a separate update_elements call and elements 'forgotten' outside the frame. Bot write access required.",
      inputSchema: frameAddChildrenShape,
    },
    async (args) =>
      runTool("frame_add_children", async () => {
        const bot = await ctx.resolveBot(args.boardId);
        return bot.frameAddChildren(args.frameId, args.childIds);
      }),
  );

  return server;
}
