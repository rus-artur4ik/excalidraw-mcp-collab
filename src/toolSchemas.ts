import * as z from "zod/v3";

import {ELEMENT_KINDS} from "./customData";

// Input schemas shared by the MCP tool registrations and by the lint's
// contract tests: every lint `suggestion` is `{tool, args}` where `args` must
// parse against the schema of that tool (minus `boardId`).

export const pointSchema = z.tuple([z.number(), z.number()]);

export const regionSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  mode: z
    .enum(["intersect", "contain"])
    .optional()
    .describe("intersect (default): anything touching the rect; contain: only fully enclosed elements."),
});

export const targetSchema = z
  .object({
    ids: z.array(z.string()).optional().describe("Element ids. `<containerId>:label` addresses a container's bound label."),
    frameIds: z.array(z.string()).optional().describe("Every element inside these frames (by frameId), plus the frames themselves."),
    frameName: z.string().optional().describe("Frame(s) whose name equals this (case-insensitive), with their contents."),
    groupId: z.string().optional(),
    region: regionSchema.optional(),
    type: z.string().optional(),
    role: z.string().optional().describe("Semantic role stored on the element (see get_diagram_guide)."),
    kind: z.enum(ELEMENT_KINDS).optional(),
    slot: z.string().optional(),
    textContains: z.string().optional().describe("Case-insensitive substring of the element's text or its label's text."),
    textRegex: z.string().optional().describe("JavaScript regex (flags i) against the element's text or its label's text."),
    hasLink: z.boolean().optional(),
    at: z
      .object({ x: z.number(), y: z.number() })
      .optional()
      .describe("Elements whose shape covers this scene point, bottom→top: the last one is what a click would hit."),
    after: z
      .object({
        anchorId: z.string(),
        axis: z.enum(["x", "y"]),
        scope: z.enum(["frame", "board"]).optional(),
      })
      .optional()
      .describe("Everything whose top (axis y) or left (axis x) edge lies beyond the anchor's bottom/right edge — within the anchor's frame (default) or the whole board."),
  })
  .describe("Element selector; all given conditions must hold (AND).");

export type Target = z.infer<typeof targetSchema>;

export const anchorSchema = z.object({
  side: z.enum(["top", "right", "bottom", "left", "center"]),
  at: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Position along the side, 0 = start (left/top) … 1 = end; default 0.5, or spread evenly when several arrows share the side."),
});

export const routeSchema = z
  .enum(["direct", "straight", "orthogonal"])
  .describe("direct (default): a straight line between the binding points; straight: the server picks anchor positions so the arrow is exactly horizontal/vertical; orthogonal: server-computed elbow path.");

export const fitSchema = z
  .enum(["none", "width", "height", "both"])
  .describe("Grow the container to fit its label: height keeps the width and adds lines, width widens to the longest line, both does both.");

export const lintIgnoreSchema = z.array(
  z.union([
    z.string(),
    z.object({ code: z.string(), with: z.array(z.string()).optional() }),
  ]),
);

// Every field update_elements understands. Anything else is reported in
// `ignoredFields` instead of being written onto the element.
export const UPDATE_PATCH_FIELDS = [
  // geometry
  "x",
  "y",
  "width",
  "height",
  "angle",
  "dx",
  "dy",
  // style
  "strokeColor",
  "backgroundColor",
  "fillStyle",
  "strokeWidth",
  "strokeStyle",
  "roughness",
  "opacity",
  "roundness",
  "role",
  "tone",
  "surface",
  // text (standalone text elements, or a container's label)
  "text",
  "fontSize",
  "fontFamily",
  "textAlign",
  "verticalAlign",
  "lineHeight",
  "autoResize",
  "label",
  "labelColor",
  "labelFontSize",
  "labelFontFamily",
  "fit",
  "wrap",
  "nowrap",
  "containerId",
  // structure
  "type",
  "index",
  "frameId",
  "groupIds",
  "name",
  "link",
  "locked",
  "customData",
  "kind",
  "slot",
  "lintIgnore",
  "protected",
  "fitToChildren",
  // arrows and lines
  "points",
  "fromId",
  "toId",
  "startBinding",
  "endBinding",
  "startAnchor",
  "endAnchor",
  "bindMode",
  "waypoints",
  "route",
  "startArrowhead",
  "endArrowhead",
  // images
  "fileId",
  "scale",
  // preconditions
  "expect",
  // copy style from another element
  "styleFrom",
  // stack membership
  "stack",
] as const;

export type UpdatePatchField = (typeof UPDATE_PATCH_FIELDS)[number];

export const updatePatchSchema = z
  .object({
    id: z.string(),
    x: z.number().optional(),
    y: z.number().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    angle: z.number().optional(),
    dx: z.number().optional().describe("Move by this offset; carries the label, frame children and bound arrows like move_elements."),
    dy: z.number().optional(),
    strokeColor: z.string().optional(),
    backgroundColor: z.string().optional(),
    fillStyle: z.string().optional(),
    strokeWidth: z.number().optional(),
    strokeStyle: z.string().optional(),
    roughness: z.number().optional(),
    opacity: z.number().optional(),
    roundness: z.unknown().optional(),
    role: z.string().optional(),
    tone: z.enum(["solid", "subtle"]).optional(),
    surface: z.string().optional(),
    text: z.string().optional(),
    fontSize: z.number().optional(),
    fontFamily: z.number().optional(),
    textAlign: z.enum(["left", "center", "right"]).optional(),
    verticalAlign: z.enum(["top", "middle", "bottom"]).optional(),
    lineHeight: z.number().optional(),
    autoResize: z.boolean().optional(),
    label: z.string().optional(),
    labelColor: z.string().optional(),
    labelFontSize: z.number().optional(),
    labelFontFamily: z.number().optional(),
    fit: fitSchema.optional(),
    wrap: z.enum(["words", "balanced", "none"]).optional(),
    nowrap: z.array(z.string()).optional(),
    containerId: z.string().nullable().optional(),
    type: z.string().optional(),
    index: z.string().optional(),
    frameId: z.string().nullable().optional(),
    groupIds: z.array(z.string()).optional(),
    name: z.string().nullable().optional(),
    link: z.union([z.string(), z.object({ boardId: z.string(), frameId: z.string().optional() })]).nullable().optional(),
    locked: z.boolean().optional(),
    customData: z.record(z.unknown()).optional(),
    kind: z.enum(ELEMENT_KINDS).nullable().optional(),
    slot: z.string().nullable().optional(),
    lintIgnore: lintIgnoreSchema.optional(),
    protected: z.boolean().optional(),
    fitToChildren: z
      .object({
        padding: z.number().optional(),
        titleGap: z.number().optional(),
        grow: z.enum(["right", "down", "both"]).optional(),
        shrink: z.boolean().optional(),
      })
      .optional(),
    points: z.array(pointSchema).optional(),
    fromId: z.string().optional(),
    toId: z.string().optional(),
    startBinding: z.unknown().optional(),
    endBinding: z.unknown().optional(),
    startAnchor: anchorSchema.optional(),
    endAnchor: anchorSchema.optional(),
    bindMode: z.enum(["inside", "orbit", "skip"]).optional(),
    waypoints: z.array(pointSchema).optional(),
    route: routeSchema.optional(),
    startArrowhead: z.string().nullable().optional(),
    endArrowhead: z.string().nullable().optional(),
    fileId: z.string().optional(),
    scale: pointSchema.optional(),
    expect: z.record(z.unknown()).optional(),
    styleFrom: z.string().optional(),
    stack: z
      .union([z.object({ id: z.string(), insertAt: z.number().optional() }), z.null()])
      .optional()
      .describe("Put the element into a stack (from create_stack) at this position, or null to take it out."),
  })
  .strict();

export const updateElementsArgsSchema = z.object({
  elements: z.array(updatePatchSchema),
});

export const moveElementsArgsSchema = z.object({
  target: targetSchema,
  dx: z.number().optional(),
  dy: z.number().optional(),
  carry: z
    .object({
      frameChildren: z.boolean().optional(),
      boundText: z.boolean().optional(),
      boundArrows: z.enum(["translate", "reroute", "keep"]).optional(),
    })
    .optional(),
});

export const deleteElementsArgsSchema = z.object({
  ids: z.array(z.string()).optional(),
  groupId: z.string().optional(),
  target: targetSchema.optional(),
});

export const reorderArgsSchema = z.object({
  ids: z.array(z.string()),
  position: z.enum(["above", "below", "front", "back"]).optional(),
  anchorId: z.string().optional(),
});

export const repairSceneArgsSchema = z.object({
  codes: z.array(z.string()),
  target: targetSchema.optional(),
});

export const restoreArgsSchema = z.object({
  ids: z.array(z.string()),
  from: z.string().optional(),
});

export const frameAddChildrenArgsSchema = z.object({
  frameId: z.string(),
  childIds: z.array(z.string()),
  refit: z.boolean().optional(),
  padding: z.number().optional(),
});

export const SUGGESTION_TOOL_SCHEMAS = {
  update_elements: updateElementsArgsSchema,
  move_elements: moveElementsArgsSchema,
  delete_elements: deleteElementsArgsSchema,
  reorder: reorderArgsSchema,
  repair_scene: repairSceneArgsSchema,
  restore: restoreArgsSchema,
  frame_add_children: frameAddChildrenArgsSchema,
} as const;

export type SuggestionTool = keyof typeof SUGGESTION_TOOL_SCHEMAS;

// Machine-executable fix attached to a lint finding: `args` is the tool's
// input without `boardId`. When no safe fix exists the finding carries
// `{ reason }` instead — never an empty "review".
export type Suggestion =
  | {
      tool: SuggestionTool;
      args: Record<string, unknown>;
      risk: "safe" | "review";
      note?: string;
    }
  | { reason: string };
