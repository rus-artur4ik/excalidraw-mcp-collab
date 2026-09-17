import {ROLE_SHAPES, SIZE_LADDER, STYLE_ROLES} from "./verify/styles";

const roleRows = Object.entries(STYLE_ROLES)
  .map(([name, role]) => {
    const shape = ROLE_SHAPES[name] ? ` (default shape: ${ROLE_SHAPES[name]})` : "";
    return `| \`${name}\` | ${role.backgroundColor} | ${role.strokeColor} |${shape}`;
  })
  .join("\n");

const ladderRows = Object.entries(SIZE_LADDER)
  .map(([name, size]) => `- **${name}**: ${size.width}×${size.height}`)
  .join("\n");

export const DIAGRAM_GUIDE = `# Drawing well on excalidraw-team boards

## Workflow (always)

1. **Design before drawing.** Pick a visual encoding first: progress → bar, composition → segmented bar, delta → diverging bars, metric → big number, structure → nodes + arrows, sequence → timeline. If the result would be "rectangles with bullet lists", redesign — a diagram should argue, not display text.
2. **Graph-shaped content → \`create_diagram\`.** Flowcharts, architectures, pipelines, dependencies: pass nodes + edges + direction and the server computes the layout (ELK layered). Never hand-compute coordinates for graphs.
3. **Free-form visuals → \`batch_create\`.** Always use \`label\` (bound text inside shapes) instead of standalone text over shapes, and \`fromId\`/\`toId\` for arrows instead of manual points. Use \`measure_text\` before sizing a container by hand.
4. **Self-review loop (mandatory).** After every write: \`render_region\` the changed area → look at the image → \`validate_scene\` scoped to the changed ids → apply each finding's \`suggestion\` (they carry ready-to-use numbers: dx/dy, width/height, strokeColor, patch) → re-render. Repeat until clean; 2–3 passes is normal. Never finish with unresolved errors.

## Style rules

- **Colors come from roles — do not invent hex values.** Set \`role\` on elements and the palette is applied for you:

| role | background | stroke |
|------|------------|--------|
${roleRows}

- **Fonts:** at most 2 font families per board section; default is fine.
- **Text budget:** titles ≤ 6 words, captions ≤ 10 words, zero paragraphs on canvas.
- **Size ladder** (pick from it instead of arbitrary sizes; bigger = more important):
${ladderRows}
- **Density caps:** ≤ 20 nodes per diagram reads well; the server rejects > 60. Split large content into several linked diagrams instead of cramming.
- Emoji render as tofu in PNG exports — use plain glyphs (✓ ★ × ·) instead.

## Canonical example

\`\`\`json
create_diagram {
  "boardId": "...",
  "direction": "DOWN",
  "origin": { "x": 0, "y": 0 },
  "nodes": [
    { "id": "start", "label": "Request received", "role": "terminal" },
    { "id": "auth", "label": "Authenticated?", "role": "decision" },
    { "id": "handle", "label": "Handle request", "role": "process" },
    { "id": "reject", "label": "401 Unauthorized", "role": "error" }
  ],
  "edges": [
    { "from": "start", "to": "auth" },
    { "from": "auth", "to": "handle", "label": "yes" },
    { "from": "auth", "to": "reject", "label": "no" }
  ]
}
\`\`\`

Then: \`render_region\` the returned \`bounds\`, check the image, \`validate_scene\` with the returned ids, fix, re-render.

## When NOT to draw

- The content is a table or a list — write it as text instead.
- More than ~30 nodes of tightly-coupled detail — split by subsystem first.
- You cannot name the visual encoding — go back to step 1.

## Where the result lives

Always on a shared board (list_boards). Never deliver a diagram as a local .excalidraw/PNG file — local artifacts live outside the board, the team can't see or edit them.
`;

export const PALETTE_JSON = JSON.stringify(
  { roles: STYLE_ROLES, roleShapes: ROLE_SHAPES, sizeLadder: SIZE_LADDER },
  null,
  2,
);

export const SERVER_README = `# excalidraw-team: data model, contracts and gotchas

Style and layout advice lives in \`get_diagram_guide\`. This is the mechanical contract.

## Which tool

| You want | Call |
|---|---|
| somewhere to draw | \`list_boards\` — and only if nothing fits, \`create_board\` |
| keep related new boards together | \`list_folders\` / \`create_folder\`, then \`create_board {folderId}\` |
| flowchart / architecture / pipeline / dependency map | \`create_diagram\` (server lays it out) |
| free-form shapes, legends, annotations | \`batch_create\` |
| one arrow between two existing shapes | \`connect\` |
| change anything that already exists | \`update_elements\` |
| look at the result | \`render_region\` / \`render_scene\` |
| prove the result | \`validate_scene\` |

## Boards are the owner's, not yours

\`list_boards\` is the source of truth: reuse an existing board whenever one fits — one board per topic, not one per diagram. \`create_board\` makes a new empty board owned by the account this bot acts for, grants this bot write access, and returns a \`boardId\` the drawing tools accept right away. It works only if the owner turned on this bot's "Create boards" permission; if the call comes back denied, relay that to the user instead of retrying. New boards are \`private\` unless you pass \`visibility\`.

Folders are the owner's personal grouping of boards on their home page — they never change who can open a board. With the "Create folders" sub-permission (the owner can only turn it on together with "Create boards") you can \`list_folders\`, \`create_folder {name}\` and pass \`folderId\` to \`create_board\`. \`create_folder\` is idempotent by name: reuse what comes back instead of inventing variants, and do not create a folder for a single board.

## Text lives inside shapes, never on top of them

- \`batch_create [{type:"rectangle", label:"Ready"}]\` creates the box **and** a bound text element.
- A standalone \`text\` element positioned over a shape is a defect: it does not move, wrap or delete with the shape.
- Next to a \`label\`, **\`fontSize\`/\`fontFamily\`/\`textAlign\`/\`verticalAlign\` describe the label**, not the box (a box has no text of its own). \`labelFontSize\`/\`labelFontFamily\` override them explicitly.
- \`batch_create\` and \`create_diagram\` return a \`labels\` map (\`{containerId: textElementId}\`) — no follow-up \`query_elements\` needed to patch a label.
- To edit a label later: \`update_elements [{id: containerId, label:"New"}]\`. You never need the text id.
- Arrows take \`label\` too; the text binds to the arrow and rides along.

## A diamond is not its bounding box

A label is **inscribed**, so the usable area is smaller than the shape:

| shape | usable width | usable height |
|---|---|---|
| rectangle | \`w - 10\` | \`h - 10\` |
| ellipse | \`w/√2 - 10\` | \`h/√2 - 10\` |
| diamond | \`w/2 - 10\` | \`h/2 - 10\` |

Pass \`containerType\` to \`measure_text\` and its \`recommendedContainer\` accounts for this. A \`text_overflow\` finding names the axis that actually failed (WIDE vs TALL) and its \`suggestion.alternative\` carries the largest \`fontSize\` that fits the current box.

## Arrows: bind, then route

- \`fromId\`/\`toId\` bind both ends (FixedPointBinding + \`boundElements\` back-references). Bound arrows follow their shapes.
- Hand-written \`points\` between two shapes is a defect: no binding, and the arrow detaches on the first move.
- To avoid an obstacle **without losing the binding**, keep \`fromId\`/\`toId\` and add either:
  - \`waypoints: [[x,y], ...]\` — absolute scene coordinates the path must pass through, or
  - \`route: "orthogonal"\` — server-computed elbow path.
  Both work on \`batch_create\`, \`connect\` and \`update_elements\`.
- \`arrow_crosses_element\` fires when a path cuts through a shape; its \`suggestion.waypoints\` is a ready-to-apply detour.

## Deleting is safe

\`delete_elements\` / \`delete_region\` cascade to bound text, strip \`boundElements\` back-references from survivors and null out bindings that pointed at the deleted element. The response reports both \`deleted\` and \`detached\` ids. No \`binding_backref_missing\` is left behind.

## Silencing a rule you meant to break

- Per element: \`lintIgnore: ["arrow_unbound_endpoint"]\` on create or update. It is stored in \`customData\` and survives reload.
- \`lintIgnore: ["isolated"]\` also drops the element from \`validate_scene\`'s \`graph.isolated\` (use it for legend boxes).
- \`disabledRules\` on \`validate_scene\` is board-wide — prefer the per-element opt-out so real defects still surface.

## Colors

Set \`role\` instead of hex. \`low_contrast\` suggests the nearest passing shade **of the same hue**, so a green label stays green — apply \`suggestion.strokeColor\` verbatim.

## Rule codes

\`text_overflow\`, \`overlap\`, \`occlusion\`, \`duplicate\`, \`alignment_near_miss\`, \`low_contrast\`, \`arrow_crosses_element\`, \`arrow_unbound_endpoint\`, \`arrow_dangling_binding\`, \`arrow_zero_length\`, \`binding_backref_missing\`, \`binding_invalid\`, \`bound_text_below_container\`, \`degenerate_size\`, \`empty_text\`, \`invalid_enum\`, \`out_of_range\`, \`invisible_opacity\`, \`off_canvas_outlier\`, \`style_many_fonts\`, \`style_many_stroke_colors\`.

## The loop

write → \`render_region\` the changed area → look → \`validate_scene\` scoped to the changed ids → apply each \`suggestion\` → re-render. Writes already return inline \`warnings\`; act on them before rendering. Never finish with unresolved errors.
`;
