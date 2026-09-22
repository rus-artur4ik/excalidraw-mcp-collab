import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v3";

import {BotAccessDeniedError, type CollabBot, ReadOnlyError, type WriteCallOptions,} from "./bot/CollabBot";
import {BOARD_DESCRIPTION_MAX_LENGTH, BoardEditDeniedError} from "./boards";
import {BoardCreationDeniedError} from "./bots";
import {type CreatedFolder, FolderPermissionDeniedError, type FolderSummary} from "./folders";
import {logError, logInfo, logWarn} from "./logger";
import {type ArrangeOptions, containerSizeForText, measureText, ROLE_NAMES, wrapText,} from "./verify";
import {ELEMENT_KINDS} from "./customData";
import {
  anchorSchema,
  fitSchema,
  lintIgnoreSchema,
  pointSchema,
  regionSchema,
  routeSchema,
  type Target,
  targetSchema,
  updatePatchSchema,
} from "./toolSchemas";
import {ToolError} from "./engine/errors";
import {storeExport} from "./exports";
import {type BoardProfile, type ProfileScope, resolveProfile} from "./profile";
import {planCopy} from "./engine/copy";
import {getElementBounds} from "./verify/geometry";
import type {CreateItem} from "./engine/create";
import type {Patch} from "./engine/update";
import {runQuery} from "./engine/query";
import {hasConditions, resolveTarget} from "./engine/selector";
import type {ExcalidrawElement} from "./types";
import {DIAGRAM_GUIDE, PALETTE_JSON, README_SECTIONS, readMe} from "./guide";

import type {AccessibleBoard, BoardDescriptionResult, BoardRenameResult} from "./boards";

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
  dryRun: z
    .boolean()
    .optional()
    .describe("Only check whether the call would pass (permission, quota, folder) without creating anything."),
};

const setBoardDescriptionShape = {
  ...boardIdShape,
  description: boardDescriptionField.describe(
    `New description for the board, shown under its name in the app's board list (never on the board itself). Up to ${BOARD_DESCRIPTION_MAX_LENGTH} characters; line breaks collapse into spaces and longer text is cut. Pass an empty string to remove the description.`,
  ),
};

const renameBoardShape = {
  ...boardIdShape,
  title: z
    .string()
    .describe(
      "New board name as it appears in the app's board list and header, up to 120 characters. Keep it short and human-readable; line breaks collapse into spaces.",
    ),
};

const moveBoardToFolderShape = {
  ...boardIdShape,
  folderId: z
    .string()
    .nullable()
    .describe(
      "Target folder on the owner's home page (an id from list_folders or create_folder). Pass null to take the board out of its folder. A board sits in at most one folder, so it leaves its previous one.",
    ),
};

const createFolderShape = {
  name: z
    .string()
    .describe(
      "Folder name as it appears on the owner's home page, up to 60 characters. Short topic names work best (e.g. \"Backend\", \"Q4 planning\").",
    ),
};

// ---- shared write options (N03) -------------------------------------------

const writeOptionsSchema = z
  .object({
    dryRun: z
      .boolean()
      .optional()
      .describe("Run the whole pipeline (layout, lint, fit) and return what WOULD change, without committing."),
    strict: z
      .enum(["warn", "error"])
      .optional()
      .describe('"error": reject the whole write if any field would be ignored (default "warn": apply the rest and list them in ignoredFields).'),
    lint: z
      .enum(["new", "touched", "errors", "summary", "off"])
      .optional()
      .describe('Inline lint in the response. "new" (default): only findings this write introduced, plus counts of resolved/persisting ones; "touched": every finding on the touched elements; "errors": new errors only; "summary": counts only; "off".'),
    expect: z
      .record(z.number())
      .optional()
      .describe("Optimistic lock: {elementId: version}. If any element changed since you read it, nothing is written and the call fails with code conflict."),
    note: z.string().optional().describe("Free-text note for the board history (why this change)."),
    snap: z.number().optional().describe("Round x/y/width/height of every shape this write touches to this grid step (e.g. 8)."),
    verify: z
      .object({
        render: z
          .object({ padding: z.number().optional(), scale: z.number().optional() })
          .optional()
          .describe("Also return a PNG of the changed area (costs tokens; off by default)."),
      })
      .optional(),
  })
  .optional();

const returnFieldShape = {
  return: z
    .enum(["ids", "full"])
    .optional()
    .describe('"ids" (default): the envelope lists changed ids; "full" also echoes the changed elements.'),
};

const writeCallOptions = (args: {
  options?: z.infer<typeof writeOptionsSchema>;
  return?: "ids" | "full";
}): WriteCallOptions => ({
  ...(args.options ?? {}),
  returnElements: args.return === "full",
});

// ---- elements ---------------------------------------------------------------

const elementFields = {
  type: z
    .string()
    .describe("Excalidraw element type: rectangle, ellipse, diamond, text, line, arrow, frame, image."),
  id: z
    .string()
    .optional()
    .describe("Your id for the element (readable ids like \"f1_cache\" are encouraged). A deleted id is revived (never pass an id that is still live unless onExisting is \"replace\")."),
  role: z
    .string()
    .optional()
    .describe(
      "Semantic style role (process, decision, terminal, error, external, accent, note, neutral): fills backgroundColor/strokeColor/labelColor from the board palette and is remembered on the element. Explicit colors win. On a text element it sets the text color.",
    ),
  tone: z.enum(["solid", "subtle"]).optional().describe("With role: subtle = light fill with the role's stroke (for backgrounds, highlights)."),
  surface: z
    .enum(["base", "subtle", "strong", "header", "code"])
    .optional()
    .describe("Quiet palette background instead of a role (table headers, zebra rows, code, panels)."),
  styleFrom: z.string().optional().describe("Copy every style field you do not set (colors, stroke, fill, role, label font/alignment) from this element."),
  kind: z
    .enum(ELEMENT_KINDS)
    .optional()
    .describe("What the element is for, so the lint treats it right: container/lane/group-frame (nesting is not overlap), legend/annotation/code (not graph nodes), divider (a separator line, no arrow rules), table/table-cell."),
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  relative: z
    .boolean()
    .optional()
    .describe("With frameId: x/y are measured from the frame's top-left corner."),
  angle: z.number().optional(),
  strokeColor: z.string().optional(),
  backgroundColor: z.string().optional(),
  fillStyle: z.string().optional(),
  strokeWidth: z.number().optional(),
  strokeStyle: z.string().optional(),
  roughness: z.number().optional(),
  opacity: z.number().optional(),
  roundness: z.object({ type: z.number(), value: z.number().optional() }).nullable().optional(),
  text: z.string().optional().describe("Content of a text element. For text inside a shape use `label` on the shape instead."),
  fontSize: z
    .number()
    .optional()
    .describe("Font size. Alongside `label` it styles the LABEL (a container has no text of its own)."),
  fontFamily: z
    .number()
    .optional()
    .describe("Font family id (5 Excalifont default, 6 Nunito, 3 Cascadia monospace). Alongside `label` it styles the LABEL."),
  textAlign: z
    .enum(["left", "center", "right"])
    .optional()
    .describe("Horizontal alignment; on a container with `label`, left/right pin the label 5 px from that edge (the client's padding)."),
  verticalAlign: z
    .enum(["top", "middle", "bottom"])
    .optional()
    .describe("Vertical alignment of a label inside its container; top/bottom pin it 5 px from that edge."),
  points: z
    .array(pointSchema)
    .optional()
    .describe(
      "line/arrow vertices relative to x,y. Omit and a line/arrow is auto-built from width/height. Never use `points` to draw an arrow between two shapes — use fromId/toId (+ `waypoints`/`route`).",
    ),
  waypoints: z
    .array(pointSchema)
    .optional()
    .describe("Absolute scene points a fromId/toId arrow must pass through; bindings are kept."),
  route: routeSchema.optional(),
  startAnchor: anchorSchema.optional().describe("Where the arrow leaves its source: {side, at}. Sets the binding point; the first segment leaves perpendicular to that side."),
  endAnchor: anchorSchema.optional().describe("Where the arrow enters its target: {side, at}."),
  lintIgnore: lintIgnoreSchema
    .optional()
    .describe('Rule codes validate_scene must not report for THIS element: ["arrow_unbound_endpoint"], or {code, with:[ids]} to silence only findings that also involve those ids. "isolated" drops it from graph.isolated. On a frame or group member it covers the whole frame/group.'),
  slot: z.string().optional().describe("Stable role of this element across a series of boards (e.g. \"header.tags\"), addressable with target.slot."),
  protected: z.boolean().optional().describe("delete_elements skips protected elements unless called with force."),
  containerId: z
    .string()
    .optional()
    .describe("Bind this text to a container shape or arrow as its label (the container must not have one yet)."),
  label: z
    .string()
    .optional()
    .describe(
      "On rectangle/ellipse/diamond/arrow: create the bound label in the same call (its id is `<id>:label`). `fontSize`/`fontFamily`/`textAlign`/`verticalAlign`/`labelColor` on the same item style this label.",
    ),
  labelColor: z.string().optional().describe("Text color of the label."),
  labelFontSize: z.number().optional().describe("Font size of the label; overrides `fontSize`."),
  labelFontFamily: z.number().optional().describe("Font family of the label; overrides `fontFamily`."),
  fit: fitSchema.optional(),
  wrap: z
    .enum(["words", "balanced", "none"])
    .optional()
    .describe('Label wrapping: words (default, like the app); balanced evens out 2–3 line labels (no lone last word) and writes the breaks into the text; none widens the box instead.'),
  nowrap: z
    .array(z.string())
    .optional()
    .describe('Regexes whose matches must not be split across lines, e.g. ["auto-\\w+ · \\d+"] (breaks are written into the text).'),
  frameId: z
    .string()
    .nullable()
    .optional()
    .describe("Put the element into this existing frame (it moves and clips with it)."),
  fromId: z
    .string()
    .optional()
    .describe("On an arrow: bind its start to this element id (created already bound; it follows the shape)."),
  toId: z.string().optional().describe("On an arrow: bind its end to this element id."),
  bindMode: z.enum(["inside", "orbit", "skip"]).optional().describe("Binding mode for a fromId/toId arrow (default orbit)."),
  startArrowhead: z.string().nullable().optional(),
  endArrowhead: z.string().nullable().optional(),
  link: z
    .union([z.string(), z.object({ boardId: z.string(), frameId: z.string().optional() })])
    .nullable()
    .optional()
    .describe("Clickable link: a URL, or {boardId, frameId?} to link another board (or a frame on it)."),
  fileId: z
    .string()
    .optional()
    .describe("On an image element: id returned by upload_file."),
  groupIds: z.array(z.string()).optional(),
  name: z.string().optional().describe("Frame name."),
  // composite types
  code: z.string().optional().describe('type:"code": the code, verbatim (indentation kept; monospace, top-left aligned, sized so no line wraps).'),
  title: z.string().optional().describe('type:"code": caption above the card.'),
  source: z.string().optional().describe('type:"code": muted source reference under the card, e.g. "SampleChatKit.kt:108".'),
  anchorId: z.string().optional().describe('type:"callout"|"badge": the element it points at / sits on.'),
  side: z.enum(["auto", "top", "right", "bottom", "left"]).optional().describe('type:"callout": where to place the note (default auto: the nearest free side).'),
  maxDistance: z.number().optional().describe('type:"callout": largest gap to the anchor (default 120).'),
  corner: z.enum(["top-left", "top-right", "bottom-left", "bottom-right"]).optional().describe('type:"badge": which corner of the anchor (default top-left).'),
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

const queryShape = {
  boardId: z.string().optional().describe("Board to read (or use scope for several boards)."),
  scope: z
    .object({ boardIds: z.array(z.string()).optional(), folderId: z.string().optional() })
    .optional()
    .describe("Read several boards at once (a folder needs the \"Create folders\" permission); the result is {boards:[{boardId, total, items…}]}. Use it to find text across a series."),
  target: targetSchema.optional(),
  fields: z
    .array(z.string())
    .optional()
    .describe('Return only these fields per element (id always included). Extra computed fields: "label", "role", "kind", "bbox", "from", "to", "childCount", "order". ["*"] returns raw elements. Default: a compact summary (id, type, x, y, w, h, text/label, frameId, role, kind, from/to).'),
  labels: z
    .enum(["inline", "separate"])
    .optional()
    .describe('"inline" (default): a container carries its label text and the label is not listed separately.'),
  format: z
    .enum(["json", "rows", "md", "graph"])
    .optional()
    .describe('"json" (default); "rows": one "id type x y w h \\"text\\"" string per element; "md": the board by frame in reading order ("id [type/role]: text", arrows as "id (from → to): label") — best for checking content against a spec; "graph": {nodes, edges} in create_diagram form.'),
  order: z.enum(["z", "reading"]).optional().describe('"z" (default, bottom→top) or "reading" (frames, then rows top→bottom, left→right).'),
  aggregate: z.enum(["bounds"]).optional().describe('"bounds": only the common bounding box of the matched elements.'),
  maxChars: z.number().optional().describe("Cut the page at about this many characters (default 20000); the rest comes via nextCursor."),
  cursor: z.string().optional().describe("nextCursor from the previous page."),
  source: z
    .enum(["memory", "stored"])
    .optional()
    .describe('"stored" reads the persisted scene instead of the bot\'s live copy — for auditing that a change survived.'),
  // legacy filters
  type: z.string().optional().describe("Same as target.type."),
  ids: z.array(z.string()).optional().describe("Same as target.ids."),
  groupId: z.string().optional().describe("Same as target.groupId."),
  limit: z.number().optional().describe("Return at most this many elements in this page."),
  offset: z.number().optional().describe("Skip this many elements first (older form of cursor)."),
};

const reorderShape = {
  ...boardIdShape,
  ids: z
    .array(z.string())
    .describe("Element ids to re-stack. A container's bound-text label moves with it."),
  position: z
    .enum(["above", "below", "front", "back"])
    .optional()
    .describe("above (default) / below the anchor, or front / back of the whole board (no anchor needed)."),
  anchorId: z
    .string()
    .optional()
    .describe("Reference element for above/below (must not be one of `ids`)."),
  options: writeOptionsSchema,
};

const frameAddChildrenShape = {
  ...boardIdShape,
  frameId: z.string(),
  childIds: z
    .array(z.string())
    .describe("Elements to move into the frame; their bound-text labels follow."),
  refit: z.boolean().optional().describe("Grow the frame to enclose its children (never shrinks)."),
  padding: z.number().optional().describe("Padding for refit (default 24)."),
  options: writeOptionsSchema,
};

const updateElementsShape = {
  boardId: z.string().optional().describe("Board to change (or scope + target + patch for several boards)."),
  scope: z
    .object({ boardIds: z.array(z.string()).optional(), folderId: z.string().optional() })
    .optional()
    .describe("Apply `patch` to the `target` elements on several boards (e.g. one legend row identified by target.slot across a series); every board is its own commit."),
  ...returnFieldShape,
  elements: z
    .array(updatePatchSchema.passthrough())
    .optional()
    .describe("Patches: { id, ...fields to change }. `<containerId>:label` addresses a container's label."),
  target: targetSchema
    .optional()
    .describe("With `patch`: apply the same patch to every element matching the selector."),
  patch: z
    .record(z.unknown())
    .optional()
    .describe("Patch applied to every element matched by `target` (bulk update)."),
  reflow: z
    .object({
      push: z.enum(["below", "right", "none"]).optional(),
      growFrame: z.boolean().optional(),
    })
    .optional()
    .describe("When a patched element grows (label, fit), shift what lies directly below (or right of) it — same frame, overlapping its column (row) — by the growth, keeping gaps; groups move whole; the frame grows to fit."),
  options: writeOptionsSchema,
};

const moveElementsShape = {
  ...boardIdShape,
  target: targetSchema,
  dx: z.number().optional(),
  dy: z.number().optional(),
  carry: z
    .object({
      frameChildren: z.boolean().optional().describe("A frame brings everything whose frameId is it (default true)."),
      boundText: z.boolean().optional().describe("Containers bring their labels (default true)."),
      boundArrows: z
        .enum(["translate", "reroute", "keep"])
        .optional()
        .describe("Arrows with both ends in the moved set travel whole with their bends (translate, default); arrows with one end outside are re-aimed at the moved shape either way; keep leaves them untouched."),
    })
    .optional(),
  options: writeOptionsSchema,
};

const deleteElementsShape = {
  ...boardIdShape,
  ids: z.array(z.string()).optional(),
  groupId: z.string().optional().describe("Delete every element carrying this groupId."),
  target: targetSchema.optional(),
  force: z.boolean().optional().describe("Also delete elements marked protected (say why in options.note)."),
  options: writeOptionsSchema,
};

const groupShape = {
  ...boardIdShape,
  ids: z.array(z.string()),
  options: writeOptionsSchema,
};

const ungroupShape = {
  ...boardIdShape,
  ids: z.array(z.string()).optional(),
  groupId: z.string().optional(),
  options: writeOptionsSchema,
};

const createFrameShape = {
  ...boardIdShape,
  id: z.string().optional().describe("Readable id for the frame (e.g. \"f04\")."),
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  name: z.string().optional(),
  childIds: z
    .array(z.string())
    .optional()
    .describe("Elements to put inside; without x/y/width/height the frame is sized to fit them plus `padding`."),
  padding: z.number().optional().describe("Space around the children when sized to fit (default 24)."),
  titleGap: z.number().optional().describe("Extra space above the children for a title row."),
  kind: z.enum(ELEMENT_KINDS).optional(),
  options: writeOptionsSchema,
};

const validateShape = {
  ...boardIdShape,
  target: targetSchema.optional().describe("Only report findings involving these elements."),
  ids: z.array(z.string()).optional().describe("Same as target.ids."),
  region: z
    .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
    .optional()
    .describe("Only report findings involving elements in this scene rectangle."),
  profile: z
    .enum(["default", "visual-qa", "integrity"])
    .optional()
    .describe('Named rule set: "default"; "visual-qa" adds stricter typography/geometry checks; "integrity" checks data consistency (bindings, frames, persistence).'),
  minPadding: z.number().optional().describe("text_overflow reports kind \"tight\" when a label has less free space than this (default 8)."),
  codes: z.array(z.string()).optional().describe("Only report these rule codes."),
  minSeverity: z.enum(["error", "warning", "info"]).optional(),
  summaryOnly: z.boolean().optional().describe("Only counts, coverage and graph."),
  disabledRules: z.array(z.string()).optional(),
  viewBackgroundColor: z.string().optional(),
  checkPersisted: z
    .boolean()
    .optional()
    .describe("Compare with the persisted scene and report not_persisted (default true)."),
  expected: z
    .object({
      ids: z.array(z.string()).optional().describe("Ids that must be on the board."),
      elements: z
        .array(z.object({ id: z.string(), type: z.string().optional(), label: z.string().optional(), text: z.string().optional() }))
        .optional()
        .describe("Elements with the type and text (label) they must have."),
      edges: z.array(z.object({ from: z.string(), to: z.string(), label: z.string().optional() })).optional(),
      frames: z.array(z.string()).optional().describe("Frame names that must exist."),
      textMatch: z.enum(["exact", "normalized"]).optional().describe("normalized (default): case, spaces and line breaks do not matter."),
    })
    .optional()
    .describe("Check the board against a spec: reports expected_missing / expected_mismatch / expected_edge_missing / expected_frame_missing."),
};

const measureItemShape = z.object({
  key: z.string().optional(),
  text: z.string(),
  fontSize: z.number().optional(),
  fontFamily: z.number().optional(),
  maxWidth: z.number().optional(),
  containerType: z.enum(["rectangle", "diamond", "ellipse"]).optional(),
});

const measureShape = {
  text: z.string().optional().describe("Single text to measure (or use items for a batch)."),
  fontSize: z.number().optional(),
  fontFamily: z.number().optional(),
  maxWidth: z.number().optional(),
  containerType: z
    .enum(["rectangle", "diamond", "ellipse"])
    .optional()
    .describe("Shape the text will live in; a diamond/ellipse needs a much bigger box — recommendedContainer accounts for that."),
  items: z
    .array(measureItemShape)
    .optional()
    .describe("Measure many texts in one call; each item may override fontSize/fontFamily/maxWidth/containerType."),
};

const renderFields = {
  format: z.enum(["png", "svg"]).optional(),
  padding: z.number().optional(),
  scale: z.number().optional(),
  showGrid: z.boolean().optional(),
  gridSize: z.number().optional(),
  showLabels: z.boolean().optional().describe("Numbered Set-of-Mark badges on the image (default false)."),
  legend: z
    .enum(["none", "ids", "compact", "frames", "full"])
    .optional()
    .describe('Text legend next to the image: "none" (default), "ids", "compact" ("id type x y w h text" lines), "frames", "full" (per-element entries with z-order).'),
  highlight: z.array(z.string()).optional().describe("Outline these element ids on the image."),
  maxPixelWidth: z.number().optional().describe("Without an explicit scale the image fits this width (default 1600, never above 2×)."),
  showFrameNames: z.boolean().optional().describe("Frame names above frames, as in the app (default true)."),
  layout: z
    .enum(["single", "tiles", "sheet"])
    .optional()
    .describe('"tiles": split a big area into readable tiles (one image each); "sheet" (render_element with several ids): one image with a labeled crop per id.'),
  viewBackgroundColor: z.string().optional(),
};

const renderShape = {
  ...boardIdShape,
  ...renderFields,
  target: targetSchema
    .optional()
    .describe('What to show, e.g. {frameName:"04 · Errors"} or {ids:[…]}; omit target, ids and the rectangle for the whole board.'),
  ids: z.array(z.string()).optional().describe("Render just these elements (with their labels), cropped to them."),
  groupId: z.string().optional().describe("Render every element of this group."),
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
};

const batchCreateShape = {
  ...boardIdShape,
  ...returnFieldShape,
  elements: z
    .array(z.object(elementFields).passthrough())
    .describe("Items to create; unknown fields are reported in ignoredFields, not written."),
  onExisting: z
    .enum(["revive", "error", "replace"])
    .optional()
    .describe('What an explicit id that already exists means. "revive" (default): a deleted id comes back (with a version above its tombstone); a live id is an error. "error": any existing id is an error. "replace": a live id is updated in place to match the item.'),
  options: writeOptionsSchema,
};

const diagramNodeShape = z.object({
  id: z.string().describe("Node id — also the element id (with idPrefix/diagramId prefix)."),
  label: z.string(),
  role: z
    .enum(ROLE_NAMES)
    .optional()
    .describe("Semantic style role; sets colors and default shape (decision→diamond, terminal→ellipse). Default process."),
  shape: z.enum(["rectangle", "ellipse", "diamond"]).optional(),
  width: z.number().optional().describe("Fixed size; omit to auto-size from the label."),
  height: z.number().optional(),
  group: z.string().optional().describe("Id of a `groups` entry to cluster this node into."),
  layer: z.number().optional().describe("Force the node into a layer band: nodes with a higher layer come after lower ones along the direction."),
  order: z.number().optional().describe("Position within its layer (lower first)."),
});

const diagramEdgeShape = z.object({
  id: z.string().optional().describe("Edge id — the arrow's element id (default \"<from>-><to>\")."),
  from: z.string(),
  to: z.string(),
  label: z.string().optional().describe("Bound to the arrow; ELK reserves room for it."),
  strokeStyle: z.enum(["solid", "dashed", "dotted"]).optional(),
  startArrowhead: z.string().nullable().optional(),
  endArrowhead: z.string().nullable().optional(),
});

const createDiagramShape = {
  ...boardIdShape,
  ...returnFieldShape,
  diagramId: z
    .string()
    .optional()
    .describe("Name the diagram. Ids become \"<diagramId>:<id>\", and calling again with the same diagramId re-lays it out in place (same ids; removed nodes are deleted)."),
  idPrefix: z.string().optional().describe("Prefix for element ids (default: \"<diagramId>:\" or none)."),
  nodes: z.array(diagramNodeShape),
  edges: z.array(diagramEdgeShape),
  groups: z
    .array(
      z.object({
        id: z.string(),
        label: z.string().optional(),
        strokeStyle: z.enum(["solid", "dashed", "dotted"]).optional().describe("Default solid (dashed means \"planned\" on these boards)."),
      }),
    )
    .optional()
    .describe("Named clusters drawn as containers (kind group-frame) around their member nodes; the title sits top-left inside."),
  direction: z.enum(["DOWN", "RIGHT", "UP", "LEFT"]).optional().describe("Main flow direction (default DOWN)."),
  spacing: z.number().optional().describe("Base gap between nodes (default 48); same as layout.nodeSpacing."),
  layout: z
    .object({
      nodeSpacing: z.number().optional(),
      layerSpacing: z.number().optional(),
      groupPadding: z.number().optional(),
    })
    .optional()
    .describe("Spacing, applied inside groups too."),
  constraints: z
    .array(
      z.union([
        z.object({ sameRank: z.array(z.string()) }),
        z.object({ before: z.tuple([z.string(), z.string()]) }),
      ]),
    )
    .optional()
    .describe("sameRank: put these nodes in one layer band; before: [a, b] keeps a before b within a layer."),
  origin: z
    .object({ x: z.number(), y: z.number() })
    .optional()
    .describe("Scene position of the diagram's top-left corner; pick a free area (query_elements aggregate bounds)."),
  frameId: z.string().optional().describe("Create the diagram inside this frame."),
  fontSize: z.number().optional(),
  roughness: z.number().optional(),
  options: writeOptionsSchema,
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
  edge: z.enum(["left", "right", "top", "bottom", "centerX", "centerY"]).optional(),
  axis: z.enum(["horizontal", "vertical"]).optional(),
  originX: z.number().optional(),
  originY: z.number().optional(),
  options: writeOptionsSchema,
};

const restoreShape = {
  ...boardIdShape,
  ids: z.array(z.string()).describe("Ids to bring back; empty with `from` means every id that commit touched."),
  from: z
    .string()
    .optional()
    .describe('"tombstone" (default): the deleted copy kept for 24 h; or a commitId from board_log — the journal keeps the elements exactly as they were before that commit for 30 days.'),
  mode: z
    .enum(["restore", "revert"])
    .optional()
    .describe('"restore" (default) brings the elements back; "revert" undoes that whole commit — what it changed goes back and what it created is deleted.'),
  options: writeOptionsSchema,
};

const repairShape = {
  ...boardIdShape,
  codes: z
    .array(z.string())
    .describe("Rule codes to fix deterministically, e.g. binding_backref_stale, bound_text_below_container, frame_membership_mismatch, arrow_label_far, not_persisted."),
  target: targetSchema.optional(),
  options: writeOptionsSchema.describe("dryRun defaults to TRUE here: look at `applied`, then call again with options.dryRun:false."),
};

const boardLogShape = {
  ...boardIdShape,
  ids: z.array(z.string()).optional().describe("Only commits that touched these ids."),
  ops: z
    .array(z.enum(["create", "update", "delete", "revive", "mixed", "reload"]))
    .optional()
    .describe("Only these kinds of commit."),
  since: z.number().optional().describe("Only commits after this epoch-ms timestamp."),
  sinceVersion: z.number().optional().describe("Only commits that left the scene above this sceneVersion."),
  includeGeometry: z
    .boolean()
    .optional()
    .describe("Include a short before-state (id, type, box, version) of the elements each commit touched."),
  limit: z.number().optional().describe("Newest entries to return (default 20, max 100)."),
};

const readMeShape = {
  sections: z
    .array(z.enum(README_SECTIONS))
    .optional()
    .describe("Only these sections. Omit for the whole contract."),
  knownVersion: z.string().optional().describe("Version you already have; if unchanged the reply is just {version, unchanged:true}."),
};

const replaceTextShape = {
  scope: z
    .object({ boardIds: z.array(z.string()).optional(), folderId: z.string().optional() })
    .describe("Boards to search (a folder needs the \"Create folders\" permission)."),
  map: z
    .array(z.object({ from: z.string(), to: z.string(), regex: z.boolean().optional() }))
    .describe("Replacements, applied in order to every text, label and frame name."),
  options: z
    .object({
      dryRun: z.boolean().optional().describe("Default TRUE: report what would change."),
      reflow: updateElementsShape.reflow,
      note: z.string().optional(),
    })
    .optional(),
};

const tableColumnShape = z.object({
  key: z.string(),
  header: z.string().optional(),
  width: z.union([z.literal("auto"), z.number()]).optional().describe('"auto" (default): the widest text + padding.'),
  minWidth: z.number().optional(),
  maxWidth: z.number().optional().describe("Text wraps at this width."),
  align: z.enum(["left", "center", "right"]).optional(),
  role: z.enum(["text", "code", "mark", "number"]).optional().describe("code → monospace; mark (✓ ×) → centered; number → right-aligned."),
});

const tableCellShape = z.union([z.string(), z.object({ text: z.string(), role: z.string().optional() })]);

const setTableShape = {
  ...boardIdShape,
  tableId: z.string().describe("Your id for the table; cells get ids <tableId>:<rowKey>:<colKey>. Call again with the same id to change the table."),
  spec: z
    .object({
      origin: z.object({ x: z.number(), y: z.number() }).optional().describe("Top-left corner (required for a new table unless frameId is given)."),
      frameId: z.string().optional(),
      columns: z.array(tableColumnShape).optional(),
      rows: z
        .array(
          z.object({
            key: z.string(),
            cells: z.record(tableCellShape).optional().describe("colKey → text (or {text, role})."),
            role: z.string().optional().describe("Text role or palette role for the whole row."),
            after: z.string().optional().describe('Insert/move after this row key ("_h" = first).'),
          }),
        )
        .optional(),
      rowOrder: z.array(z.string()).optional(),
      rowGroups: z.array(z.object({ label: z.string(), rows: z.array(z.string()) })).optional().describe("Section bands with a label before their rows."),
      headerRow: z.boolean().optional(),
      numbered: z.union([z.enum(["1.", "A"]), z.literal(false)]).optional().describe("Leading number column."),
      fontSize: z.number().optional(),
      fontFamily: z.number().optional(),
      cellPadding: z.object({ x: z.number().optional(), y: z.number().optional() }).optional(),
      rowMinHeight: z.number().optional(),
      verticalAlign: z.enum(["top", "middle", "bottom"]).optional(),
      tableStyle: z
        .object({
          header: z.object({ surface: z.enum(["base", "subtle", "strong", "header", "code"]).optional() }).optional(),
          zebra: z
            .union([z.literal(false), z.object({ every: z.number().optional(), surface: z.enum(["base", "subtle", "strong", "header", "code"]).optional() })])
            .optional(),
          border: z.enum(["outer", "none"]).optional(),
          rowRules: z.enum(["hairline", "none"]).optional(),
          columnRules: z.boolean().optional(),
        })
        .optional(),
      prune: z.boolean().optional().describe("Remove rows/columns not passed in this call (only for the lists you pass)."),
      removeRows: z.array(z.string()).optional(),
    })
    .describe("Only what you pass changes: a repeated call merges by column/row key."),
  reflow: updateElementsShape.reflow.describe("When the table grows, push what lies below it (default: below, within its frame, growing the frame)."),
  options: writeOptionsSchema,
};

const setLegendShape = {
  ...boardIdShape,
  legendId: z.string(),
  origin: z.object({ x: z.number(), y: z.number() }).optional().describe("Required for a new legend."),
  frameId: z.string().optional(),
  items: z
    .array(
      z.object({
        role: z.string().optional(),
        tone: z.enum(["solid", "subtle"]).optional(),
        strokeStyle: z.enum(["solid", "dashed", "dotted"]).optional().describe("Without `arrow`: a line sample in this style."),
        arrow: z.boolean().optional().describe("An arrow sample."),
        label: z.string(),
      }),
    )
    .optional()
    .describe("Required unless fromProfile is set."),
  fromProfile: z
    .boolean()
    .optional()
    .describe("Build the items from the board profile's roles and stroke styles (set_board_profile), so the legend says what the board actually means. Items you pass are appended after them."),
  layout: z.enum(["row", "grid"]).optional(),
  columns: z.number().optional(),
  fontSize: z.number().optional(),
  options: writeOptionsSchema,
};

const exportShape = {
  ...boardIdShape,
  target: targetSchema.optional().describe("What to export, e.g. {frameName:\"04 · Errors\"}; omit for the whole board."),
  ids: z.array(z.string()).optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  format: z.enum(["png", "svg"]).optional(),
  scale: z.number().optional(),
  padding: z.number().optional(),
  maxPixelWidth: z.number().optional(),
  viewBackgroundColor: z.string().optional(),
  ttlSeconds: z.number().optional().describe("How long the link works (default 24 h, at most 7 days)."),
};

const copyElementsShape = {
  ...boardIdShape,
  target: targetSchema.describe("What to copy on this board; a frame brings its children, a container its label."),
  toBoardId: z.string().optional().describe("Copy onto another board this bot can write to (default: the same board)."),
  dx: z.number().optional(),
  dy: z.number().optional().describe("Offset for the copies; on the same board without an offset they land below the originals."),
  idMap: z
    .enum(["suffix", "keep"])
    .optional()
    .describe('"suffix" (default) gives the copies new ids; "keep" reuses the source ids — only on another board, where they are free.'),
  suffix: z.string().optional().describe('Id suffix for "suffix" mode (default "-copy").'),
  frameId: z.string().nullable().optional().describe("Put every copy in this frame of the destination board."),
  options: writeOptionsSchema,
};

const createStackShape = {
  ...boardIdShape,
  ids: z.array(z.string()).describe("Elements of the stack, in any order (they are sorted by position)."),
  direction: z.enum(["down", "right"]).optional(),
  gap: z.number().optional().describe("Space between members; default: the spacing they already have."),
  align: z.enum(["start", "center", "end"]).optional(),
  stackId: z.string().optional(),
  options: writeOptionsSchema,
};

const applyOpsShape = {
  ...boardIdShape,
  ...returnFieldShape,
  ops: z
    .array(
      z.object({
        op: z.enum(["create", "update", "delete", "move", "restore"]),
        elements: z.array(z.record(z.unknown())).optional().describe("create: batch_create items; update: patches."),
        onExisting: z.enum(["revive", "error", "replace"]).optional(),
        ids: z.array(z.string()).optional(),
        target: targetSchema.optional(),
        force: z.boolean().optional(),
        dx: z.number().optional(),
        dy: z.number().optional(),
        carry: moveElementsShape.carry,
        from: z.string().optional().describe("restore: \"tombstone\" (default) or a commitId from board_log."),
      }),
    )
    .describe("Executed in order, in one transaction and one commit."),
  options: writeOptionsSchema,
};

const profileScopeShape = z
  .object({ boardId: z.string().optional(), folderId: z.string().optional() })
  .describe("Which boards the profile covers: one board, or a folder (the whole series). A board without its own profile inherits its folder's.");

const setBoardProfileShape = {
  scope: profileScopeShape,
  roles: z
    .record(z.object({ tag: z.string().optional(), meaning: z.string().optional() }))
    .optional()
    .describe('What each palette role means on these boards, e.g. {accent:{tag:"[YOU]"}, process:{tag:"[SDK]"}} — the lint then catches an element tagged as one role but coloured as another.'),
  strokeStyles: z
    .record(z.string())
    .optional()
    .describe('What a stroke style means, e.g. {dashed:"[planned]"}.'),
  typeScale: z
    .object({
      title: z.number().optional(),
      frameTitle: z.number().optional(),
      colHeader: z.number().optional(),
      body: z.number().optional(),
      caption: z.number().optional(),
      code: z.number().optional(),
    })
    .optional()
    .describe("The only font sizes this series uses; tables, legends and code cards take their defaults from here."),
  spacing: z
    .object({
      unit: z.number().optional(),
      cellPadding: z.number().optional(),
      frameInset: z.number().optional(),
      blockGap: z.number().optional(),
    })
    .optional(),
  nowrap: z
    .array(z.string())
    .optional()
    .describe('Regexes whose matches must never be split across lines on these boards, e.g. ["auto-\\w+ · \\d+"].'),
};

// A legend straight from the board's own vocabulary: one chip per role the
// profile names, then one line sample per stroke style it names.
type LegendItem = { role?: string; strokeStyle?: "solid" | "dashed" | "dotted"; label: string };

const legendCaption = (tag: string | undefined, meaning: string | undefined): string =>
  [tag?.trim(), meaning?.trim()].filter(Boolean).join(" — ");

const legendItemsFromProfile = (profile: BoardProfile | null): LegendItem[] => {
  if (!profile) {
    return [];
  }
  const items: LegendItem[] = [];
  for (const [role, entry] of Object.entries(profile.roles ?? {})) {
    const label = legendCaption(entry?.tag, entry?.meaning);
    if (label) {
      items.push({ role, label });
    }
  }
  for (const [style, meaning] of Object.entries(profile.strokeStyles ?? {})) {
    if (meaning?.trim() && (style === "solid" || style === "dashed" || style === "dotted")) {
      items.push({ strokeStyle: style, label: meaning.trim() });
    }
  }
  return items;
};

// ---- helpers ---------------------------------------------------------------

const textResult = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});

const errorResult = (error: Record<string, unknown>) => ({
  isError: true,
  content: [{ type: "text" as const, text: JSON.stringify({ error }) }],
});

const structured = (
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  code,
  message,
  retryable: code === "rate_limited" || code === "conflict",
  ...extra,
});

const retryAfterFrom = (message: string): Record<string, unknown> => {
  const minutes = /try again in (\d+) min/.exec(message);
  if (!minutes) return {};
  const seconds = Number(minutes[1]) * 60;
  return { retryAfterSec: seconds, resetAt: new Date(Date.now() + seconds * 1000).toISOString() };
};

const toolError = (name: string, error: unknown, startedAt: number) => {
  if (error instanceof ToolError) {
    logWarn("mcp.tool.rejected", { tool: name, code: error.code });
    return errorResult(error.toJSON());
  }
  if (error instanceof ReadOnlyError) {
    logWarn("mcp.tool.read_only_denied", { tool: name });
    return errorResult(structured("forbidden", "read-only access on this board", { details: { hint: "the bot can only read this board; ask the owner for write access" } }));
  }
  if (error instanceof BotAccessDeniedError) {
    logWarn("mcp.tool.access_denied", { tool: name });
    return errorResult(structured("forbidden", error.message));
  }
  // A withheld permission is the owner's decision, not a fault: report it to
  // the agent verbatim so it can tell the user how to grant it.
  if (error instanceof BoardCreationDeniedError || error instanceof FolderPermissionDeniedError) {
    const limited = /limit of \d+/.test(error.message);
    const missing = /does not exist/.test(error.message);
    logWarn(
      error instanceof BoardCreationDeniedError ? "mcp.tool.board_creation_denied" : "mcp.tool.folder_permission_denied",
      { tool: name },
    );
    return errorResult(
      structured(limited ? "rate_limited" : missing ? "not_found" : "forbidden", error.message, limited ? retryAfterFrom(error.message) : {}),
    );
  }
  if (error instanceof BoardEditDeniedError) {
    logWarn("mcp.tool.board_edit_denied", { tool: name });
    return errorResult(structured("forbidden", error.message));
  }
  logError("mcp.tool.failed", error, {
    tool: name,
    durationMs: Date.now() - startedAt,
  });
  const message = error instanceof Error ? error.message : String(error);
  // Planner/validation errors thrown as plain Errors are the caller's input.
  const invalid = /not found|unknown|duplicate|needs|cannot|must|invalid|split it/i.test(message);
  return errorResult(structured(invalid ? "invalid_args" : "internal", message));
};

const runTool = async (name: string, fn: () => Promise<unknown>) => {
  const startedAt = Date.now();
  logInfo("mcp.tool.started", { tool: name });
  try {
    const result = await fn();
    logInfo("mcp.tool.succeeded", { tool: name, durationMs: Date.now() - startedAt });
    return textResult(result);
  } catch (error) {
    return toolError(name, error, startedAt);
  }
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

// A write's response: the flattened envelope, plus a PNG of the changed area
// when the caller asked for options.verify.render.
const respondWrite = async <T extends { result: unknown; changed?: Record<string, unknown> }>(
  bot: CollabBot,
  options: { verify?: { render?: { padding?: number; scale?: number } } } | undefined,
  envelope: T,
): Promise<ToolContent> => {
  const body = envelopeOut(envelope);
  const render = options?.verify?.render;
  const changed = envelope.changed as { created?: string[]; updated?: string[]; revived?: Array<{ id: string }> } | undefined;
  const ids = [
    ...(changed?.created ?? []),
    ...(changed?.updated ?? []),
    ...(changed?.revived ?? []).map((entry) => entry.id),
  ];
  if (!render || !ids.length || (envelope as { dryRun?: boolean }).dryRun) {
    return textResult(body);
  }
  const bounds = await bot.getBounds(ids);
  const image = await bot.render({
    region: bounds.bounds,
    padding: render.padding ?? 40,
    scale: render.scale,
    showLabels: false,
  });
  if (image.format === "png" && image.png) {
    return {
      content: [
        { type: "image" as const, data: image.png, mimeType: "image/png" },
        { type: "text" as const, text: JSON.stringify({ ...body, verify: { region: bounds.bounds } }) },
      ],
    };
  }
  return textResult(body);
};

// Envelope of a write, flattened for the agent: `result` fields first.
const envelopeOut = <T extends { result: unknown }>(envelope: T): Record<string, unknown> => {
  const { result, ...rest } = envelope;
  return { ...(result && typeof result === "object" ? (result as Record<string, unknown>) : {}), ...rest };
};

const READ = { readOnlyHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;
const IDEMPOTENT_WRITE = { ...WRITE, idempotentHint: true } as const;

const SERVER_INSTRUCTIONS = `Excalidraw drawing tools for shared team boards.

When asked for a diagram or visualization, draw it HERE on a shared board — never produce local .excalidraw/PNG files (the team can't see or edit them).

Before your FIRST WRITE of a session, call read_me (the contract; read_me({sections:[...]}) for parts, knownVersion to skip a re-read). Read-only work (query, validate, render) does not need it.

Creating content:
- Graph-shaped diagrams: create_diagram (nodes + edges; the server lays it out). Re-run with the same diagramId to re-layout in place.
- Tables and matrices: set_table. Legends: set_legend. Code: batch_create {type:"code"}.
- Free-form: batch_create with \`label\` for text inside shapes and \`fromId\`/\`toId\` for arrows; add \`waypoints\`, \`route\` or \`startAnchor\`/\`endAnchor\` to steer an arrow without losing its binding.
- Colors: set \`role\` instead of hex.
- A series of boards: set_board_profile once (type scale, spacing, what each role means) and tables, legends and code cards follow it everywhere; validate_scene {profile:"visual-qa"} then checks against it.

Editing: update_elements changes anything in place (geometry, label, font, role, type, arrow endpoints). Labels and bound arrows follow their shape automatically. move_elements moves blocks with their contents. Never delete and re-create an element to change it.

If a tool you expected is missing (describe_scene, get_bounds, element_at, render_scene/render_region/render_element, delete_region, bring_to_front/send_to_back, connect, scene_diff, get_diagram_guide), it was folded into query_elements, render, delete_elements, reorder, batch_create, board_log and read_me — the "Which tool" section of read_me has the table.

Every write returns one envelope: changed ids, persisted (did it reach storage), ignoredFields (what was NOT applied), and lint.new (findings this write introduced). Fix lint.new using each finding's suggestion — it is a ready tool call {tool, args}. After a geometry change, render the area (legend off by default); after a text-only edit, lint.new is enough.

Keep diagrams ≤20 nodes. Titles ≤6 words, no paragraphs on canvas. Emoji become tofu in PNG renders; use plain glyphs (✓ ★ × ·).`;

export type CreateBoardInput = {
  title: string;
  description?: string;
  visibility?: "private" | "team" | "link";
  folderId?: string;
  dryRun?: boolean;
};

export type BotInfo = {
  botId: string | null;
  permissions: { createBoards: boolean; createFolders: boolean };
  boards?: Array<{ boardId: string; access: "read" | "write" }>;
  quotas: Record<string, { limit: number; used: number; resetAt: string | null }>;
};

export type McpContext = {
  resolveBot: (boardId: string) => Promise<CollabBot>;
  listBoards: (input?: { folderId?: string; query?: string; details?: boolean }) => Promise<AccessibleBoard[]>;
  createBoard: (input: CreateBoardInput) => Promise<unknown>;
  setBoardDescription: (input: {
    boardId: string;
    description: string;
  }) => Promise<BoardDescriptionResult>;
  renameBoard: (input: {
    boardId: string;
    title: string;
  }) => Promise<BoardRenameResult>;
  listFolders: () => Promise<FolderSummary[]>;
  createFolder: (input: { name: string }) => Promise<CreatedFolder>;
  moveBoardToFolder: (input: {
    boardId: string;
    folderId: string | null;
  }) => Promise<MovedBoard>;
  getBotInfo?: () => Promise<BotInfo>;
  // Board ids of a folder the bot can reach (for cross-board scopes).
  folderBoardIds?: (folderId: string) => Promise<string[]>;
  // Stored scene of a board the bot may read, without joining its room.
  readBoardSnapshot?: (boardId: string) => Promise<ExcalidrawElement[]>;
  // The board's style profile (its own, else its folder's).
  loadBoardProfile?: (boardId: string) => Promise<BoardProfile | null>;
  saveBoardProfile?: (scope: ProfileScope, profile: BoardProfile) => Promise<BoardProfile>;
};

export type MovedBoard = {
  boardId: string;
  title: string;
  /** Where the board is filed now; null when it is in no folder. */
  folder: { folderId: string; name: string } | null;
};

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
      return { mode: "grid", columns: args.columns, gapX: args.gapX, gapY: args.gapY, originX: args.originX, originY: args.originY };
    case "row":
      return { mode: "row", gap: args.gap, align: (args.align as "top" | "center" | "bottom") ?? "top", originX: args.originX, originY: args.originY };
    case "column":
      return { mode: "column", gap: args.gap, align: (args.align as "left" | "center" | "right") ?? "left", originX: args.originX, originY: args.originY };
    case "align":
      return { mode: "align", edge: args.edge ?? "left" };
    case "distribute":
      return { mode: "distribute", axis: args.axis ?? "horizontal" };
  }
};

// Same-board copies land this far below the originals when no offset is given.
const COPY_GAP = 40;

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function buildMcpServer(ctx: McpContext): McpServer {
  // One lookup per board per request: every write and validate wants it.
  const profiles = new Map<string, Promise<BoardProfile | null>>();
  const profileOf = (boardId: string): Promise<BoardProfile | null> => {
    if (!ctx.loadBoardProfile) {
      return Promise.resolve(null);
    }
    const cached = profiles.get(boardId);
    if (cached) {
      return cached;
    }
    const pending = ctx.loadBoardProfile(boardId).catch((error) => {
      logWarn("mcp.profile.load_failed", {
        boardId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
    profiles.set(boardId, pending);
    return pending;
  };

  // Every bot handed to a tool carries the board's profile, so writes and lint
  // see it without each handler passing it along.
  const botFor = async (boardId: string): Promise<CollabBot> => {
    const bot = await ctx.resolveBot(boardId);
    bot.useProfile(await profileOf(boardId));
    return bot;
  };

  const server = new McpServer(
    {
      name: "excalidraw-team",
      version: "2.0.0",
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
      description: "Style roles (colors + default shapes), surfaces and the size ladder, as JSON.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: PALETTE_JSON }],
    }),
  );

  server.registerResource(
    "server-readme",
    "guide://excalidraw-team/README.md",
    {
      title: "Data model, contracts and gotchas",
      description: "The whole read_me as one document.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: readMe().text }],
    }),
  );

  server.registerTool(
    "read_me",
    {
      description:
        `Before your first WRITE of a session: the contract of this server — which tool for which job, the write envelope, how labels/arrows follow shapes, lint codes and suggestions. Sections: ${README_SECTIONS.join(", ")} (style = the drawing guide). Pass knownVersion to skip an unchanged re-read. Read-only work does not need it.`,
      inputSchema: readMeShape,
      annotations: READ,
    },
    async (args) => {
      const doc = readMe(args.sections);
      if (args.knownVersion && args.knownVersion === doc.version) {
        return textResult({ version: doc.version, unchanged: true });
      }
      return { content: [{ type: "text" as const, text: `<!-- version ${doc.version} -->\n${doc.text}` }] };
    },
  );

  server.registerTool(
    "get_bot_info",
    {
      description:
        "What this bot may do before it tries: permissions (create boards / folders), the boards it is bound to with their access, and quotas with how much is used and when they reset.",
      inputSchema: {},
      annotations: READ,
    },
    async () =>
      runTool("get_bot_info", async () => {
        if (!ctx.getBotInfo) {
          throw new ToolError("internal", "bot info is not available on this server");
        }
        return ctx.getBotInfo();
      }),
  );

  server.registerTool(
    "list_boards",
    {
      description:
        "List the boards this account can access through the bot as { boardId, title, description?, botAccess, url?, folder? }. `details:true` adds elementCount, frameNames, updatedAt and updatedBy (reads every board — use with a folderId or query). Start here: draw on an existing board whenever one fits, and only reach for create_board when the work genuinely needs a new one.",
      inputSchema: {
        folderId: z.string().optional().describe("Only boards in this folder of the owner (needs the \"Create folders\" permission)."),
        query: z.string().optional().describe("Case-insensitive substring of title or description."),
        details: z.boolean().optional(),
      },
      annotations: READ,
    },
    async (args) => runTool("list_boards", () => ctx.listBoards(args)),
  );

  server.registerTool(
    "create_board",
    {
      description:
        "Create a new empty board, owned by the account this bot acts for, and grant this bot write access to it in the same step — the returned boardId is immediately usable by the drawing tools. Requires the per-bot \"Create boards\" permission; without it the call fails with an explanation to relay, not something to retry (get_bot_info shows permissions and quota first; `dryRun:true` checks without creating). Check list_boards first and reuse a suitable board — one board per topic, not one per diagram. Give it a description saying what the board is for. Returns { boardId, title, description?, visibility, botAccess, url, folder? }.",
      inputSchema: createBoardShape,
      annotations: WRITE,
    },
    async (args) =>
      runTool("create_board", () =>
        ctx.createBoard({
          title: args.title,
          description: args.description,
          visibility: args.visibility,
          folderId: args.folderId,
          ...(args.dryRun ? { dryRun: true } : {}),
        }),
      ),
  );

  server.registerTool(
    "set_board_description",
    {
      description:
        "Set or replace the short description of an existing board — the note under its name in the app's board list (it is not drawn on the board). Pass an empty string to remove it. Needs write access to the board, and the account this bot acts for must be allowed to change the board's settings (its owner, or a team admin for a team board); otherwise the call fails with an explanation to relay, not something to retry. Returns { boardId, title, description } with the text as stored (null when removed).",
      inputSchema: setBoardDescriptionShape,
      annotations: IDEMPOTENT_WRITE,
    },
    async (args) =>
      runTool("set_board_description", () =>
        ctx.setBoardDescription({ boardId: args.boardId, description: args.description }),
      ),
  );

  server.registerTool(
    "rename_board",
    {
      description:
        "Rename an existing board — the name shown in the app's board list and header (nothing on the canvas changes; links on other boards keep their old text, which the board_link_stale lint rule points out). Needs write access and the right to change the board's settings; a denial is an explanation to relay. Returns { boardId, title, previousTitle }.",
      inputSchema: renameBoardShape,
      annotations: IDEMPOTENT_WRITE,
    },
    async (args) =>
      runTool("rename_board", () => ctx.renameBoard({ boardId: args.boardId, title: args.title })),
  );

  server.registerTool(
    "list_folders",
    {
      description:
        "List the folders on the owning account's home page as { folderId, name, boardIds } — boardIds only names boards this bot can reach. Folders never change access. Requires the per-bot \"Create folders\" permission.",
      inputSchema: {},
      annotations: READ,
    },
    async () => runTool("list_folders", () => ctx.listFolders()),
  );

  server.registerTool(
    "create_folder",
    {
      description:
        "Create a folder on the owning account's home page so related boards can be kept together; pass the returned folderId to create_board. Idempotent by name (case-insensitive): an existing folder comes back with created:false. Requires the per-bot \"Create folders\" permission. Returns { folderId, name, created }.",
      inputSchema: createFolderShape,
      annotations: IDEMPOTENT_WRITE,
    },
    async (args) => runTool("create_folder", () => ctx.createFolder({ name: args.name })),
  );

  server.registerTool(
    "move_board_to_folder",
    {
      description:
        "File an existing board into one of the owner's home-page folders, or pass folderId null to take it out. A board sits in at most one folder. Needs the per-bot \"Create folders\" permission. Returns { boardId, title, folder }.",
      inputSchema: moveBoardToFolderShape,
      annotations: IDEMPOTENT_WRITE,
    },
    async (args) =>
      runTool("move_board_to_folder", () =>
        ctx.moveBoardToFolder({ boardId: args.boardId, folderId: args.folderId }),
      ),
  );

  // ---- reads ----------------------------------------------------------------

  server.registerTool(
    "query_elements",
    {
      description:
        "Read elements of a board — or of several boards with `scope` (find text across a series). Select with `target` (ids, frameIds, frameName, groupId, region, type, role, kind, slot, textContains, textRegex, hasLink, after). Default output is compact: one summary per element with its label inline; `fields` projects, `format` gives rows / markdown in reading order / a node+edge graph, `aggregate:\"bounds\"` just the bounding box. Always returns {total, count, items, nextCursor?, sceneVersion}; a big result is cut at maxChars with a cursor, never an overflow. An inaccessible board is an error (code forbidden), never an empty list. Read-only.",
      inputSchema: queryShape,
      annotations: READ,
    },
    async (args) =>
      runTool("query_elements", async () => {
        const target: Target = {
          ...(args.target ?? {}),
          ...(args.type ? { type: args.type } : {}),
          ...(args.ids ? { ids: args.ids } : {}),
          ...(args.groupId ? { groupId: args.groupId } : {}),
        };
        const query = {
          target,
          fields: args.fields,
          labels: args.labels,
          format: args.format,
          order: args.order,
          aggregate: args.aggregate,
          maxChars: args.maxChars,
          cursor: args.cursor ?? (args.offset ? Buffer.from(String(Math.floor(args.offset))).toString("base64url") : undefined),
          limit: args.limit,
          source: args.source,
        };
        if (args.scope) {
          const boardIds = await scopeBoardIds(ctx, args.scope);
          const boards: Array<Record<string, unknown>> = [];
          for (const boardId of boardIds) {
            try {
              const pageQuery = { ...query, maxChars: Math.min(query.maxChars ?? 8000, 8000) };
              let result;
              if (ctx.readBoardSnapshot) {
                // Read the stored scenes: no room is joined, no presence shown.
                const scene = await ctx.readBoardSnapshot(boardId);
                const selected = hasConditions(target) ? resolveTarget(scene, target) : scene;
                result = runQuery(scene, selected, pageQuery);
              } else {
                result = await (await botFor(boardId)).queryElements(pageQuery);
              }
              if (result.total) boards.push({ boardId, ...result });
            } catch (error) {
              boards.push({ boardId, error: error instanceof Error ? error.message : String(error) });
            }
          }
          return { boards };
        }
        if (!args.boardId) {
          throw new ToolError("invalid_args", "pass boardId (or scope for several boards)", { details: { field: "boardId" } });
        }
        const bot = await botFor(args.boardId);
        return bot.queryElements(query);
      }),
  );

  server.registerTool(
    "validate_scene",
    {
      description:
        "Deterministic lint over a board: text overflow (tight / overflow), text outside its frame, overlaps (nesting excluded), arrows crossing shapes or text, broken bindings and back-references, frames, contrast, alignment within a frame, and — by default — elements that did not reach storage (not_persisted). Pick a `profile` (default, visual-qa, integrity), scope with `target`, trim with codes/minSeverity/summaryOnly. Each finding's `suggestion` is a ready tool call {tool, args} (or {reason} when no safe fix exists). summary.coverage lists the rules that ran. Read-only.",
      inputSchema: validateShape,
      annotations: READ,
    },
    async (args) =>
      runTool("validate_scene", async () => {
        const { boardId, region, ids, target, ...rest } = args;
        const bot = await botFor(boardId);
        const result = await bot.validateScene({
          ...rest,
          target: { ...(target ?? {}), ...(ids ? { ids } : {}) },
          region: region ? [region.x, region.y, region.x + region.width, region.y + region.height] : undefined,
        } as Parameters<CollabBot["validateScene"]>[0]);
        const stale = await staleBoardLinks(ctx, bot, args.codes);
        if (stale.length) {
          if (!args.summaryOnly) result.findings.push(...(stale as typeof result.findings));
          result.summary.warnings += stale.length;
        }
        return result;
      }),
  );

  server.registerTool(
    "measure_text",
    {
      description:
        "Measure text (and the container size that fits it) without touching a board, with the same metric the server lays labels out with. Pass `items` to measure many texts in one call: each result has {key, width, height, lines:[{text, width}], recommendedContainer?}, plus `max` over all items. Read-only.",
      inputSchema: measureShape,
      annotations: READ,
    },
    async (args) =>
      runTool("measure_text", async () => {
        const measureOne = (item: z.infer<typeof measureItemShape>, index: number) => {
          const fontSize = item.fontSize ?? args.fontSize ?? 20;
          const fontFamily = item.fontFamily ?? args.fontFamily;
          const maxWidth = item.maxWidth ?? args.maxWidth;
          const containerType = item.containerType ?? args.containerType;
          const wrapped = typeof maxWidth === "number" ? wrapText(item.text, fontSize, fontFamily, maxWidth) : item.text;
          const measured = measureText(wrapped, fontSize, fontFamily);
          const width = Math.ceil(measured.width);
          const height = Math.ceil(measured.height);
          return {
            key: item.key ?? String(index),
            width,
            height,
            lineCount: measured.lineCount,
            lines: wrapped.split("\n").map((line) => ({ text: line, width: Math.ceil(measureText(line, fontSize, fontFamily).width) })),
            ...(containerType ? { recommendedContainer: containerSizeForText(containerType, width, height) } : {}),
          };
        };
        if (args.items?.length) {
          const results = args.items.map(measureOne);
          return {
            items: results,
            max: {
              width: Math.max(...results.map((result) => result.width)),
              height: Math.max(...results.map((result) => result.height)),
            },
          };
        }
        if (typeof args.text !== "string") {
          throw new ToolError("invalid_args", "pass `text` or `items`");
        }
        const single = measureOne({ text: args.text }, 0);
        const { key: _key, ...rest } = single;
        return {
          ...rest,
          containerType: args.containerType ?? "rectangle",
          recommendedContainer: containerSizeForText(args.containerType ?? "rectangle", single.width, single.height),
        };
      }),
  );

  server.registerTool(
    "board_log",
    {
      description:
        "The board's persisted history (the entries the app's History panel shows: when, who, sceneVersion) plus recently deleted elements (tombstones, kept 24 h). With `ids`, each entry also says what happened to those ids (create/update/delete/revive) — the way to find out when and by whom something disappeared. Use an entry id with restore({from}). Read-only.",
      inputSchema: boardLogShape,
      annotations: READ,
    },
    async (args) =>
      runTool("board_log", async () => {
        const bot = await botFor(args.boardId);
        return bot.boardLog({
          ids: args.ids,
          ops: args.ops,
          since: args.since,
          sinceVersion: args.sinceVersion,
          includeGeometry: args.includeGeometry,
          limit: args.limit,
        });
      }),
  );

  const renderHandler = (
    name: string,
    args: { boardId: string; format?: "png" | "svg" } & Record<string, unknown>,
    extra: { region?: [number, number, number, number]; ids?: string[]; groupId?: string; target?: Target },
  ) =>
    runRawTool(name, async () => {
      const bot = await botFor(args.boardId);
      const result = await bot.render({
        format: args.format,
        padding: args.padding as number | undefined,
        scale: args.scale as number | undefined,
        maxPixelWidth: args.maxPixelWidth as number | undefined,
        showGrid: args.showGrid as boolean | undefined,
        gridSize: args.gridSize as number | undefined,
        showLabels: (args.showLabels as boolean | undefined) ?? false,
        showFrameNames: args.showFrameNames as boolean | undefined,
        viewBackgroundColor: args.viewBackgroundColor as string | undefined,
        legend: (args.legend as "none" | "ids" | "compact" | "frames" | "full" | undefined) ?? "none",
        highlight: args.highlight as string[] | undefined,
        layout: args.layout as "single" | "tiles" | "sheet" | undefined,
        ...extra,
      });
      const meta: Record<string, unknown> = {
        format: result.format,
        transform: result.transform,
        width: result.width,
        height: result.height,
        sceneVersion: result.sceneVersion,
        fidelity: result.fidelity,
        readability: result.readability,
        ...(result.legend !== undefined ? { legend: result.legend } : {}),
        ...(result.sheet ? { sheet: result.sheet } : {}),
      };
      const content: ToolContent["content"] = [];
      if (result.tiles?.length && result.tiles.length > 1) {
        meta.tiles = result.tiles.map((tile, i) => ({ tile: i + 1, region: tile.region, width: tile.width, height: tile.height }));
        for (const tile of result.tiles) {
          if (tile.png) content.push({ type: "image", data: tile.png, mimeType: "image/png" });
        }
      } else if (result.format === "png" && result.png) {
        content.push({ type: "image", data: result.png, mimeType: "image/png" });
      }
      if (!content.length) {
        return textResult({ ...meta, svg: result.svg, note: "PNG rasterizer unavailable; returning SVG." });
      }
      content.push({ type: "text", text: JSON.stringify(meta) });
      return { content };
    });

  server.registerTool(
    "render",
    {
      description:
        "Look at the board: PNG (or SVG) of the whole board, of a scene rectangle (x, y, width, height), of a `target` such as {frameName:\"04 · Errors\"} or {ids:[…]}, drawn with the app's own fonts. `highlight` outlines ids, `legend` adds a text index of what is in the picture (off by default), `layout:\"tiles\"` splits a big area into readable tiles and `layout:\"sheet\"` puts a labelled crop of each id on one sheet. Always returns the scene→pixel transform, `fidelity` (whether text widths in the picture can be trusted) and `readability` (scale, smallest text in pixels). Read-only.",
      inputSchema: renderShape,
      annotations: READ,
    },
    async (args) => {
      if (args.target) {
        return renderHandler("render", args, { target: args.target });
      }
      if (args.ids?.length || args.groupId) {
        return renderHandler("render", args, { ids: args.ids, groupId: args.groupId });
      }
      const rect = [args.x, args.y, args.width, args.height];
      if (rect.some((value) => typeof value === "number")) {
        if (rect.some((value) => typeof value !== "number")) {
          return errorResult(structured("invalid_args", "a rectangle needs x, y, width and height"));
        }
        return renderHandler("render", args, {
          region: [args.x!, args.y!, args.x! + args.width!, args.y! + args.height!],
        });
      }
      return renderHandler("render", args, {});
    },
  );

  server.registerTool(
    "batch_create",
    {
      description:
        "Create elements in one commit. Shapes take `label` (bound text, id `<id>:label`), arrows take `fromId`/`toId` (bound; plus `waypoints`, `route`, `startAnchor`/`endAnchor`), anything takes `frameId` (+ `relative`), `role`, `kind`, `lintIgnore`, `link`. Give readable ids; a deleted id is revived above its tombstone (onExisting). Returns the write envelope: changed ids, labels map, persisted, ignoredFields, lint.new. For graphs prefer create_diagram, for tables set_table. Bot write access required.",
      inputSchema: batchCreateShape,
      annotations: WRITE,
    },
    async (args) =>
      runRawTool("batch_create", async () => {
        const bot = await botFor(args.boardId);
        return respondWrite(bot, args.options, 
          await bot.createElements(args.elements as CreateItem[], {
            ...writeCallOptions(args),
            onExisting: args.onExisting,
          }),
        );
      }),
  );

  server.registerTool(
    "update_elements",
    {
      description:
        "Change existing elements in place, in one commit — never delete and re-create to edit. Patches are { id, ...fields }: geometry (x/y/width/height, or dx/dy to move with contents), style, `role` (recolors from the palette), `label` and label style (labelFontSize/labelFontFamily/labelColor/textAlign/verticalAlign/fontSize), `fit` (grow to the label), `type` (rectangle↔ellipse↔diamond, text↔shape, arrow↔line), arrow `fromId`/`toId`/anchors/`route`/`waypoints` (rebinds for real), `containerId` on a text (binds it as a label), `frameId`, `fitToChildren` on a frame, `expect` (skip unless current values match). A changed box carries its label and re-aims bound arrows. Anything not applied is listed in ignoredFields with a hint — nothing is dropped silently. Bulk form: `target` + `patch`. Bot write access required.",
      inputSchema: updateElementsShape,
      annotations: WRITE,
    },
    async (args) =>
      runRawTool("update_elements", async () => {
        const options = {
          ...writeCallOptions(args),
          reflow: args.reflow,
          target: args.target,
          patch: args.patch,
        };
        if (args.scope) {
          if (!args.target || !args.patch) {
            throw new ToolError("invalid_args", "a scoped update needs target and patch", { details: { field: "patch" } });
          }
          const boards: Array<Record<string, unknown>> = [];
          for (const boardId of await scopeBoardIds(ctx, args.scope)) {
            try {
              const bot = await botFor(boardId);
              boards.push({ boardId, ...envelopeOut(await bot.updateElements([], options)) });
            } catch (error) {
              boards.push({ boardId, error: error instanceof Error ? error.message : String(error) });
            }
          }
          return textResult({ boards });
        }
        if (!args.boardId) {
          throw new ToolError("invalid_args", "pass boardId (or scope with target + patch)", { details: { field: "boardId" } });
        }
        const bot = await botFor(args.boardId);
        return respondWrite(bot, args.options, await bot.updateElements((args.elements ?? []) as Patch[], options));
      }),
  );

  server.registerTool(
    "move_elements",
    {
      description:
        "Move a block by dx/dy as a unit: frames bring their children (by frameId), containers their labels, arrows inside the block travel whole, arrows to the outside are re-aimed. `target.after:{anchorId, axis:\"y\"}` selects everything below an element (\"make room here\"). One call instead of patching every coordinate. Bot write access required.",
      inputSchema: moveElementsShape,
      annotations: WRITE,
    },
    async (args) =>
      runRawTool("move_elements", async () => {
        const bot = await botFor(args.boardId);
        return respondWrite(bot, args.options, 
          await bot.moveElements(args.target, args.dx ?? 0, args.dy ?? 0, args.carry, writeCallOptions(args)),
        );
      }),
  );

  server.registerTool(
    "delete_elements",
    {
      description:
        "Delete elements (ids, groupId or target) in one commit. Labels go with their containers and survivors are detached (no dangling back-references). Protected elements are skipped (skippedProtected) unless force. options.dryRun shows what would go. Deleted elements can be brought back with restore (tombstones last 24 h). To change an element, use update_elements instead — never delete and re-create. Bot write access required.",
      inputSchema: deleteElementsShape,
      annotations: DESTRUCTIVE,
    },
    async (args) =>
      runRawTool("delete_elements", async () => {
        const bot = await botFor(args.boardId);
        return respondWrite(bot, args.options, 
          await bot.deleteElements(
            { ids: args.ids, groupId: args.groupId, target: args.target, force: args.force },
            writeCallOptions(args),
          ),
        );
      }),
  );

  server.registerTool(
    "restore",
    {
      description:
        "Bring elements back: from their tombstone (default; deleted within 24 h, exact geometry, same id, labels and arrow bindings re-attached) or from a history entry id of board_log (reverts live elements to that version too). The version always goes above anything stored, so the result survives reloads. Bot write access required.",
      inputSchema: restoreShape,
      annotations: WRITE,
    },
    async (args) =>
      runRawTool("restore", async () => {
        const bot = await botFor(args.boardId);
        return respondWrite(
          bot,
          args.options,
          await bot.restore(args.ids, args.from, { ...writeCallOptions(args), mode: args.mode }),
        );
      }),
  );

  server.registerTool(
    "repair_scene",
    {
      description:
        "Apply deterministic fixes for lint codes (stale back-references, labels below their container, frame membership, arrow labels off their arrow, elements missing from storage, …). DRY RUN BY DEFAULT: returns `applied` without writing; call again with options.dryRun:false to commit. validate_scene stays read-only; this is the tool its repair suggestions point at. Bot write access required.",
      inputSchema: repairShape,
      annotations: WRITE,
    },
    async (args) =>
      runRawTool("repair_scene", async () => {
        const bot = await botFor(args.boardId);
        return respondWrite(bot, args.options, 
          await bot.repairScene(args.codes, args.target, {
            ...(args.options ?? {}),
            dryRun: args.options?.dryRun ?? true,
          }),
        );
      }),
  );

  server.registerTool(
    "replace_text",
    {
      description:
        "Find and replace text across boards (a folder or a list of boards): texts, labels and frame names, text and originalText together, alignment kept. DRY RUN BY DEFAULT. Returns per board the changes {id, before, after}, labels that now overflow, and how many matches remain. Re-running the same map changes nothing. Bot write access required on the boards it changes.",
      inputSchema: replaceTextShape,
      annotations: WRITE,
    },
    async (args) =>
      runTool("replace_text", async () => {
        const boardIds = await scopeBoardIds(ctx, args.scope);
        const dryRun = args.options?.dryRun ?? true;
        const rules = args.map.map((rule) => ({
          pattern: new RegExp(rule.regex ? rule.from : escapeRegex(rule.from), "g"),
          to: rule.to,
        }));
        const apply = (text: string): string =>
          rules.reduce((value, rule) => value.replace(rule.pattern, rule.to), text);
        const boards: Array<Record<string, unknown>> = [];
        let remaining = 0;
        for (const boardId of boardIds) {
          try {
            const bot = await botFor(boardId);
            const scene = await bot.queryElements({ fields: ["type", "text", "label", "name", "containerId"], maxChars: 10_000_000 });
            const patches: Patch[] = [];
            const changes: Array<{ id: string; before: string; after: string }> = [];
            for (const item of scene.items as Array<Record<string, unknown>>) {
              const id = String(item.id);
              if (item.type === "text" && typeof item.containerId === "string") continue;
              const field = item.type === "frame" ? "name" : item.type === "text" ? "text" : "label";
              const before = item[field === "text" ? "text" : field === "name" ? "name" : "label"];
              if (typeof before !== "string") continue;
              const after = apply(before);
              if (after === before) continue;
              patches.push({ id, [field]: after } as Patch);
              changes.push({ id, before, after });
            }
            if (!patches.length) continue;
            const envelope = await bot.updateElements(patches, {
              dryRun,
              lint: "new",
              reflow: args.options?.reflow,
              note: args.options?.note,
            });
            const overflow = (envelope.lint?.new ?? [])
              .filter((finding) => finding.code === "text_overflow")
              .map((finding) => ({ id: finding.elementIds[finding.elementIds.length - 1], message: finding.message }));
            boards.push({
              boardId,
              ...(envelope.commitId ? { commitId: envelope.commitId } : {}),
              changed: changes,
              ...(overflow.length ? { overflow } : {}),
              ...(envelope.ignoredFields ? { ignoredFields: envelope.ignoredFields } : {}),
            });
            if (!dryRun) {
              const check = await bot.queryElements({ fields: ["text", "label", "name"], maxChars: 10_000_000 });
              for (const item of check.items as Array<Record<string, unknown>>) {
                for (const value of [item.text, item.label, item.name]) {
                  if (typeof value === "string" && apply(value) !== value) remaining++;
                }
              }
            }
          } catch (error) {
            boards.push({ boardId, error: error instanceof Error ? error.message : String(error) });
          }
        }
        return { dryRun, boards, ...(dryRun ? {} : { remaining }) };
      }),
  );

  server.registerTool(
    "set_table",
    {
      description:
        "Create or change a table (matrix, checklist, glossary) declaratively. First call with origin, columns and rows creates it; later calls with the same tableId change only what you pass (widen one column, add a row after another, edit cells) and push the content below when it grows. Column width \"auto\" fits the text, rows take their tallest cell, text sits top-left with cellPadding, header/zebra/rules come from the palette, numbering and row groups are built in. Returns the envelope plus `cells` (rowKey → colKey → element id), `bounds` and `diff`. Bot write access required.",
      inputSchema: setTableShape,
      annotations: IDEMPOTENT_WRITE,
    },
    async (args) =>
      runRawTool("set_table", async () => {
        const bot = await botFor(args.boardId);
        return respondWrite(bot, args.options, 
          await bot.setTable(
            { tableId: args.tableId, spec: args.spec as Parameters<CollabBot["setTable"]>[0]["spec"], frameId: args.spec.frameId },
            { ...writeCallOptions(args), reflow: args.reflow },
          ),
        );
      }),
  );

  server.registerTool(
    "set_legend",
    {
      description:
        "Create or rebuild a legend: a chip (role color) or a line/arrow sample per item with its caption, sized so nothing overflows, as one group (kind legend). Call again with the same legendId to change it. Bot write access required.",
      inputSchema: setLegendShape,
      annotations: IDEMPOTENT_WRITE,
    },
    async (args) =>
      runRawTool("set_legend", async () => {
        const bot = await botFor(args.boardId);
        const { boardId: _boardId, options: _options, fromProfile, ...input } = args;
        const items = [
          ...(fromProfile ? legendItemsFromProfile(await profileOf(args.boardId)) : []),
          ...(input.items ?? []),
        ];
        if (!items.length) {
          throw new ToolError(
            "invalid_args",
            fromProfile
              ? "this board has no profile roles or stroke styles to build a legend from; set one with set_board_profile or pass items"
              : "a legend needs at least one item",
            { details: { field: "items" } },
          );
        }
        return respondWrite(bot, args.options, await bot.setLegend({ ...input, items }, writeCallOptions(args)));
      }),
  );

  server.registerTool(
    "export",
    {
      description:
        "Render a board area to a file and return a link to it: { url, expiresAt, sha256, bytes, format }. The link works for anyone who has it (24 h by default, 7 days at most) and is meant for pasting a picture of the board into documentation — the picture itself is not returned into the conversation. The board keeps being the source of truth; re-export after a change. Bot read access required.",
      inputSchema: exportShape,
      annotations: READ,
    },
    async (args) =>
      runTool("export", async () => {
        const bot = await botFor(args.boardId);
        const rect = [args.x, args.y, args.width, args.height];
        const geometry = args.target
          ? { target: args.target }
          : args.ids?.length
            ? { ids: args.ids }
            : rect.every((value) => typeof value === "number")
              ? { region: [args.x!, args.y!, args.x! + args.width!, args.y! + args.height!] as [number, number, number, number] }
              : {};
        const rendered = await bot.render({
          ...geometry,
          format: args.format,
          scale: args.scale,
          padding: args.padding,
          maxPixelWidth: args.maxPixelWidth,
          viewBackgroundColor: args.viewBackgroundColor,
          legend: "none",
          layout: "single",
          showLabels: false,
        });
        // bot.render falls back to SVG when the rasterizer is missing, so the
        // stored format is whatever actually came back.
        const data =
          rendered.format === "png" && rendered.png
            ? Buffer.from(rendered.png, "base64")
            : Buffer.from(rendered.svg ?? "", "utf8");
        const stored = await storeExport({
          boardId: args.boardId,
          data,
          format: rendered.format,
          ttlSeconds: args.ttlSeconds,
        });
        return {
          url: stored.url,
          expiresAt: stored.expiresAt,
          sha256: stored.sha256,
          bytes: stored.bytes,
          format: rendered.format,
          width: rendered.width,
          height: rendered.height,
          sceneVersion: rendered.sceneVersion,
          fidelity: rendered.fidelity,
          readability: rendered.readability,
        };
      }),
  );

  server.registerTool(
    "copy_elements",
    {
      description:
        "Copy a block — to another board or next to itself. Labels, frame children and arrows between the copied elements come along (an arrow to something outside loses that binding rather than attaching to a stranger). Ids get a suffix by default, so nothing is overwritten. Bot write access required on the destination board.",
      inputSchema: copyElementsShape,
      annotations: WRITE,
    },
    async (args) =>
      runRawTool("copy_elements", async () => {
        const source = await botFor(args.boardId);
        const scene = source.liveSnapshot();
        const selected = resolveTarget(scene, args.target);
        if (!selected.length) {
          throw new ToolError("not_found", "target matched no elements to copy");
        }
        const sameBoard = !args.toBoardId || args.toBoardId === args.boardId;
        if (sameBoard && args.idMap === "keep") {
          throw new ToolError("invalid_args", 'idMap:"keep" only works when copying to another board', {
            details: { field: "idMap" },
          });
        }
        const bounds = selected.reduce(
          (box, element) => {
            const [x1, y1, x2, y2] = getElementBounds(element);
            return [Math.min(box[0], x1), Math.min(box[1], y1), Math.max(box[2], x2), Math.max(box[3], y2)] as [number, number, number, number];
          },
          [Infinity, Infinity, -Infinity, -Infinity] as [number, number, number, number],
        );
        const dx = args.dx ?? 0;
        const dy =
          args.dy ?? (sameBoard && !args.dx ? Math.round(bounds[3] - bounds[1]) + COPY_GAP : 0);
        const { items, idMap } = planCopy(scene, selected, {
          dx,
          dy,
          idMap: args.idMap,
          suffix: args.suffix,
          ...(args.frameId !== undefined ? { frameId: args.frameId } : {}),
        });
        const destination = sameBoard ? source : await botFor(args.toBoardId as string);
        const envelope = await destination.copyInto(items, writeCallOptions(args));
        return respondWrite(destination, args.options, {
          ...envelope,
          result: { ...envelope.result, idMap, boardId: args.toBoardId ?? args.boardId },
        });
      }),
  );

  server.registerTool(
    "create_stack",
    {
      description:
        "Remember a column (or row) of elements as a stack: the gap between them is kept, so a later edit that makes one taller pushes the rest down instead of overlapping them, and the frame grows. Add a member with update_elements {id, stack:{id, insertAt}}, remove one with stack:null. Bot write access required.",
      inputSchema: createStackShape,
      annotations: WRITE,
    },
    async (args) =>
      runRawTool("create_stack", async () => {
        const bot = await botFor(args.boardId);
        return respondWrite(
          bot,
          args.options,
          await bot.createStack(
            {
              ids: args.ids,
              direction: args.direction,
              gap: args.gap,
              align: args.align,
              stackId: args.stackId,
            },
            writeCallOptions(args),
          ),
        );
      }),
  );

  server.registerTool(
    "apply_ops",
    {
      description:
        "Run several operations (create, update, delete, move, restore) in ONE transaction and one commit, in the order given — for a composite change that must not be half-applied, e.g. delete a node and re-create it under a new type, or move a block and re-bind its arrows. Same envelope and options as any write (options.dryRun shows the whole result first). Bot write access required.",
      inputSchema: applyOpsShape,
      annotations: WRITE,
    },
    async (args) =>
      runRawTool("apply_ops", async () => {
        const bot = await botFor(args.boardId);
        return respondWrite(
          bot,
          args.options,
          await bot.applyOps(args.ops as Array<Record<string, unknown>>, writeCallOptions(args)),
        );
      }),
  );

  server.registerTool(
    "set_board_profile",
    {
      description:
        "Read or set the style profile of a board or a whole folder (a series): what each role means, the font scale, spacing and nowrap patterns. Call it with only `scope` to read the current profile; pass any of the other fields to change just those. set_table, set_legend and code cards take their defaults from it, and validate_scene's visual-qa profile then reports sizes off the scale and colour/tag contradictions. A folder profile covers every board in it.",
      inputSchema: setBoardProfileShape,
      annotations: IDEMPOTENT_WRITE,
    },
    async (args) =>
      runTool("set_board_profile", async () => {
        const { scope, ...fields } = args;
        if (!scope.boardId && !scope.folderId) {
          throw new ToolError("invalid_args", "scope needs boardId or folderId", { details: { field: "scope" } });
        }
        const given = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
        if (!Object.keys(given).length) {
          const current = scope.boardId
            ? await (ctx.loadBoardProfile?.(scope.boardId) ?? Promise.resolve(null))
            : null;
          return { scope, profile: current, resolved: resolveProfile(current) };
        }
        if (!ctx.saveBoardProfile) {
          throw new ToolError("internal", "profiles are not available on this server");
        }
        const saved = await ctx.saveBoardProfile(scope, given as BoardProfile);
        if (scope.boardId) profiles.delete(scope.boardId);
        else profiles.clear();
        return { scope, profile: saved, resolved: resolveProfile(saved) };
      }),
  );

  server.registerTool(
    "upload_file",
    {
      description:
        "Upload an image to the board's file storage (encrypted with the room key). Returns `fileId`; place it with batch_create {type:\"image\", fileId, x, y, width, height}. Content-addressed, so re-uploading the same bytes reuses the file. Max 4 MiB; image mime types only. Bot write access required.",
      inputSchema: uploadFileShape,
      annotations: IDEMPOTENT_WRITE,
    },
    async (args) =>
      runTool("upload_file", async () => {
        const bot = await botFor(args.boardId);
        return bot.uploadFile({ data: args.data, mimeType: args.mimeType });
      }),
  );

  server.registerTool(
    "create_diagram",
    {
      description:
        "PREFERRED for graph-shaped diagrams (flowchart, architecture, pipeline, dependency map): pass nodes + edges + direction and the server computes the layout (ELK layered, spacing honored inside groups, room reserved for edge labels), sizes nodes to labels, applies role colors, and creates everything bound in one commit. Node/edge/group ids become element ids. Name it with diagramId and call again to re-layout in place. options.dryRun returns positions and lint without committing. Returns the envelope plus `nodes` (node id → element id), `edges`, `groups` and `bounds`. Bot write access required.",
      inputSchema: createDiagramShape,
      annotations: WRITE,
    },
    async (args) =>
      runRawTool("create_diagram", async () => {
        const bot = await botFor(args.boardId);
        const { boardId: _boardId, return: _return, options: _options, ...input } = args;
        return respondWrite(bot, args.options, await bot.createDiagram(input, writeCallOptions(args)));
      }),
  );

  server.registerTool(
    "arrange",
    {
      description:
        "Re-layout a set of elements: grid, row, column, align (left/right/top/bottom/centerX/centerY) or distribute (horizontal/vertical). Elements move with their labels and bound arrows. Bot write access required.",
      inputSchema: arrangeShape,
      annotations: WRITE,
    },
    async (args) =>
      runRawTool("arrange", async () => {
        const bot = await botFor(args.boardId);
        return respondWrite(bot, args.options, await bot.arrange(args.ids, buildArrangeOptions(args), writeCallOptions(args)));
      }),
  );

  server.registerTool(
    "group_elements",
    {
      description:
        "Group elements under a shared groupId (labels join their containers) so they move, render and delete as one unit. Bot write access required.",
      inputSchema: groupShape,
      annotations: WRITE,
    },
    async (args) =>
      runRawTool("group_elements", async () => {
        const bot = await botFor(args.boardId);
        return respondWrite(bot, args.options, await bot.groupElements(args.ids, writeCallOptions(args)));
      }),
  );

  server.registerTool(
    "ungroup_elements",
    {
      description: "Remove the innermost group from elements (by ids) or dissolve a group (by groupId). Bot write access required.",
      inputSchema: ungroupShape,
      annotations: WRITE,
    },
    async (args) =>
      runRawTool("ungroup_elements", async () => {
        const bot = await botFor(args.boardId);
        return respondWrite(bot, args.options, await bot.ungroupElements({ ids: args.ids, groupId: args.groupId }, writeCallOptions(args)));
      }),
  );

  server.registerTool(
    "create_frame",
    {
      description:
        "Create a frame, with an explicit box or sized to fit `childIds` (+ padding, titleGap). The frame goes to the bottom of the z-order; children (and their labels) get its frameId. Give it a readable `id`. Grow it later with update_elements {id, fitToChildren:{padding}} or frame_add_children {refit:true}. Bot write access required.",
      inputSchema: createFrameShape,
      annotations: WRITE,
    },
    async (args) =>
      runRawTool("create_frame", async () => {
        const bot = await botFor(args.boardId);
        return respondWrite(bot, args.options, 
          await bot.createFrame(
            {
              id: args.id,
              x: args.x,
              y: args.y,
              width: args.width,
              height: args.height,
              name: args.name,
              childIds: args.childIds,
              padding: args.padding,
              titleGap: args.titleGap,
              kind: args.kind,
            },
            writeCallOptions(args),
          ),
        );
      }),
  );

  server.registerTool(
    "layout_frames",
    {
      description:
        "Lay frames out in reading order as a board grid: flow (rows wrapped at maxRowWidth), column or grid, with `gap` between them; each frame moves with its content and remembers its order (customData.order, used by format:\"md\" order:\"reading\"). `fitToContent` first shrinks/grows each frame to its children. Bot write access required.",
      inputSchema: {
        ...boardIdShape,
        order: z.array(z.string()).describe("Frame ids in reading order."),
        mode: z.enum(["flow", "column", "grid"]).optional(),
        maxRowWidth: z.number().optional().describe("flow: wrap to a new row past this width (default 2200)."),
        gap: z.number().optional().describe("Space between frames (default 160)."),
        columns: z.number().optional().describe("grid: number of columns."),
        origin: z.object({ x: z.number(), y: z.number() }).optional().describe("Top-left of the layout (default: the frames' current top-left)."),
        fitToContent: z.boolean().optional(),
        padding: z.number().optional().describe("fitToContent padding (default 24)."),
        options: writeOptionsSchema,
      },
      annotations: IDEMPOTENT_WRITE,
    },
    async (args) =>
      runRawTool("layout_frames", async () => {
        const bot = await botFor(args.boardId);
        const { boardId: _boardId, options: _options, ...input } = args;
        return respondWrite(bot, args.options, await bot.layoutFrames(input, writeCallOptions(args)));
      }),
  );

  server.registerTool(
    "frame_add_children",
    {
      description:
        "Add existing elements to a frame (labels follow their containers); `refit:true` grows the frame to enclose them. Bot write access required.",
      inputSchema: frameAddChildrenShape,
      annotations: WRITE,
    },
    async (args) =>
      runRawTool("frame_add_children", async () => {
        const bot = await botFor(args.boardId);
        return respondWrite(bot, args.options, 
          await bot.frameAddChildren(
            args.frameId,
            args.childIds,
            { refit: args.refit, padding: args.padding },
            writeCallOptions(args),
          ),
        );
      }),
  );

  server.registerTool(
    "reorder",
    {
      description:
        "Change stacking: move ids just above/below an anchor, or to the front/back of the board. Re-indexing only — ids, bindings and frames stay. A container's label travels with it. Bot write access required.",
      inputSchema: reorderShape,
      annotations: WRITE,
    },
    async (args) =>
      runRawTool("reorder", async () => {
        const bot = await botFor(args.boardId);
        const position = args.position ?? "above";
        if ((position === "above" || position === "below") && !args.anchorId) {
          throw new ToolError("invalid_args", `position "${position}" needs anchorId`, { details: { field: "anchorId" } });
        }
        const placement =
          position === "front" || position === "back"
            ? ({ to: position } as const)
            : ({ to: position, anchorId: args.anchorId as string } as const);
        return respondWrite(bot, args.options, await bot.reorder(args.ids, placement, writeCallOptions(args)));
      }),
  );


  return server;
}

const scopeBoardIds = async (
  ctx: McpContext,
  scope: { boardIds?: string[]; folderId?: string },
): Promise<string[]> => {
  const ids = new Set(scope.boardIds ?? []);
  if (scope.folderId) {
    if (!ctx.folderBoardIds) {
      throw new ToolError("invalid_args", "folder scopes are not available; pass boardIds");
    }
    for (const id of await ctx.folderBoardIds(scope.folderId)) {
      ids.add(id);
    }
  }
  if (!ids.size) {
    throw new ToolError("invalid_args", "scope needs boardIds or a folderId with boards", { details: { field: "scope" } });
  }
  return [...ids];
};

const BOARD_LINK = /\/b\/([A-Za-z0-9_-]+)/;

// board_link_stale: an element linking another board whose text no longer
// names that board (renamed since). Needs board titles, so it runs here.
const staleBoardLinks = async (
  ctx: McpContext,
  bot: CollabBot,
  codes?: string[],
): Promise<Array<Record<string, unknown>>> => {
  if (codes?.length && !codes.includes("board_link_stale")) {
    return [];
  }
  const linked = await bot.queryElements({ target: { hasLink: true }, fields: ["link", "label", "text"], maxChars: 1_000_000 });
  const items = (linked.items as Array<Record<string, unknown>>).filter(
    (item) => typeof item.link === "string" && BOARD_LINK.test(item.link as string),
  );
  if (!items.length) {
    return [];
  }
  const titles = new Map((await ctx.listBoards().catch(() => [])).map((board) => [board.boardId, board.title]));
  const findings: Array<Record<string, unknown>> = [];
  for (const item of items) {
    const boardId = BOARD_LINK.exec(item.link as string)?.[1];
    const title = boardId ? titles.get(boardId) : undefined;
    const text = String(item.label ?? item.text ?? "");
    if (!title || !text || text.toLowerCase().includes(title.toLowerCase())) {
      continue;
    }
    findings.push({
      code: "board_link_stale",
      severity: "warning",
      elementIds: [item.id],
      message: `Links to board "${title}" but reads "${text}".`,
      suggestion: {
        tool: "update_elements",
        args: { elements: [item.text !== undefined ? { id: item.id, text: title } : { id: item.id, label: title }] },
        risk: "review",
      },
    });
  }
  return findings;
};
