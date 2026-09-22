import {createHash} from "crypto";

import {ROLE_SHAPES, SIZE_LADDER, STYLE_ROLES} from "./verify/styles";
import * as styles from "./verify/styles";

const roleRows = Object.entries(STYLE_ROLES)
  .map(([name, role]) => {
    const shape = ROLE_SHAPES[name] ? ` (default shape: ${ROLE_SHAPES[name]})` : "";
    return `| \`${name}\` | ${role.backgroundColor} | ${role.strokeColor} | ${role.labelColor} |${shape}`;
  })
  .join("\n");

const ladderRows = Object.entries(SIZE_LADDER)
  .map(([name, size]) => `- **${name}**: ${size.width}×${size.height}`)
  .join("\n");

export const DIAGRAM_GUIDE = `# Drawing well on excalidraw-team boards

## Workflow

1. **Design before drawing.** Pick a visual encoding first: progress → bar, composition → segmented bar, delta → diverging bars, metric → big number, structure → nodes + arrows, sequence → timeline, comparison → table. If the result would be "rectangles with bullet lists", redesign — a diagram should argue, not display text.
2. **Graph-shaped content → \`create_diagram\`.** Flowcharts, architectures, pipelines, dependencies: pass nodes + edges + direction and the server computes the layout. Never hand-compute coordinates for graphs. Name it (\`diagramId\`) so you can re-run it to re-layout in place.
3. **Tables, matrices, checklists → \`set_table\`.** Legends → \`set_legend\`. Code → \`batch_create {type:"code"}\`. Do not assemble these from loose rectangles.
4. **Free-form visuals → \`batch_create\`.** Text inside shapes is a \`label\`; arrows are \`fromId\`/\`toId\`.
5. **Check what the write told you.** Every write returns \`lint.new\` — the findings it introduced. Apply each \`suggestion\` (a ready \`{tool, args}\` call). After geometry changes, \`render_region\` the area and look. 1–2 passes is normal. Never finish with an error in \`lint\` or a \`persisted.ok:false\`.

## Style rules

- **Colors come from roles — do not invent hex values.** Set \`role\` and the palette is applied (and remembered on the element):

| role | background | stroke | text |
|------|------------|--------|------|
${roleRows}

- **Surfaces** (table headers, zebra rows, code cards) come from the palette too — set_table and code cards use them for you.
- **Dashed strokes mean "planned / not yet".** Clusters and groups are solid.
- **Fonts:** at most 2 families per board section; default is fine. Code uses fontFamily 3.
- **Text budget:** titles ≤ 6 words, captions ≤ 10 words, zero paragraphs on canvas.
- **Size ladder** (bigger = more important):
${ladderRows}
- **Density caps:** ≤ 20 nodes per diagram reads well; the server rejects > 60. Split large content into several linked diagrams (\`link: {boardId, frameId}\` makes clickable links between them).
- Emoji render as tofu in PNG exports — use plain glyphs (✓ ★ × ·) instead.

## Canonical example

\`\`\`json
create_diagram {
  "boardId": "...",
  "diagramId": "auth",
  "direction": "DOWN",
  "origin": { "x": 0, "y": 0 },
  "nodes": [
    { "id": "start", "label": "Request received", "role": "terminal" },
    { "id": "check", "label": "Authenticated?", "role": "decision" },
    { "id": "handle", "label": "Handle request", "role": "process" },
    { "id": "reject", "label": "401 Unauthorized", "role": "error" }
  ],
  "edges": [
    { "from": "start", "to": "check" },
    { "from": "check", "to": "handle", "label": "yes" },
    { "from": "check", "to": "reject", "label": "no" }
  ]
}
\`\`\`

Element ids come back as \`auth:start\`, \`auth:check\`, … Then look at \`lint.new\`, \`render_region\` the returned \`bounds\`, fix, done.

## When NOT to draw

- More than ~30 nodes of tightly-coupled detail — split by subsystem first.
- You cannot name the visual encoding — go back to step 1.

## Where the result lives

Always on a shared board (list_boards). Never deliver a diagram as a local .excalidraw/PNG file.
`;

export const PALETTE_JSON = JSON.stringify({
  roles: STYLE_ROLES,
  roleShapes: ROLE_SHAPES,
  sizeLadder: SIZE_LADDER,
  ...((styles as Record<string, unknown>).SURFACES ? { surfaces: (styles as Record<string, unknown>).SURFACES } : {}),
});

const SECTION_TEXT = {
  tools: `## Which tool

Read-only tools (safe to call anytime, no read_me needed): list_boards, list_folders, get_bot_info, query_elements, validate_scene, measure_text, board_log, render, read_me.

| You want | Call |
|---|---|
| somewhere to draw | \`list_boards\` — only if nothing fits, \`create_board\` (\`get_bot_info\` shows permission + quota first) |
| keep boards together / describe / rename | \`list_folders\`/\`create_folder\`, \`move_board_to_folder\`, \`set_board_description\`, \`rename_board\` |
| flowchart / architecture / pipeline / dependency map | \`create_diagram\` (re-run with the same \`diagramId\` to re-layout) |
| table, matrix, checklist, glossary | \`set_table\` (re-run with the same \`tableId\` to change it) |
| legend | \`set_legend\` |
| code snippet | \`batch_create {type:"code"}\` |
| a note pointing at something / a numbered step marker | \`batch_create {type:"callout"}\` / \`{type:"badge"}\` |
| free-form shapes, annotations | \`batch_create\` |
| change anything that exists (text, size, color, font, type, arrow ends) | \`update_elements\` |
| move a block / make room | \`move_elements\` (\`target.after\` = everything below an element) |
| lay frames out as a board grid | \`layout_frames\` |
| duplicate a block, or copy it to another board | \`copy_elements\` |
| keep a column's gaps through later edits | \`create_stack\` |
| several changes that must land together | \`apply_ops\` |
| a picture for documentation outside the board | \`export\` (link with an expiry, no bytes in the chat) |
| read a board | \`query_elements\` (target + format:"md" for content review) |
| find / rename text across boards | \`query_elements {scope:{folderId}, target:{textContains}}\` / \`replace_text\` |
| look at the result | \`render\` (whole board, a rectangle, or \`target:{frameName}\`) |
| check the result | read \`lint.new\` of your write; \`validate_scene\` for a full pass |
| fix what the lint found | the finding's \`suggestion\` — a ready tool call; \`repair_scene\` for integrity codes |
| undo a deletion / find out what happened | \`board_log\`, then \`restore {ids}\` or \`restore {from: commitId, mode:"revert"}\` |
| pin the style contract of a board or a whole series | \`set_board_profile\` (read it back by passing only \`scope\`) |
| the style guide | \`read_me {sections:["style"]}\` |

### Tools that were removed (and what replaced them)

| Gone | Now |
|---|---|
| \`describe_scene\` | \`query_elements\` with no target |
| \`get_bounds\` | \`query_elements {aggregate:"bounds"}\` |
| \`element_at\` | \`query_elements {target:{at:{x,y}}}\` — the last item is the top-most |
| \`render_scene\`, \`render_region\`, \`render_element\` | one \`render\` (whole board / rectangle / \`target\` / \`ids\`) |
| \`delete_region\` | \`delete_elements {target:{region}}\` |
| \`bring_to_front\`, \`send_to_back\` | \`reorder {ids, position:"front"\|"back"}\` |
| \`connect\` | \`batch_create\` with an arrow: \`{type:"arrow", fromId, toId}\` |
| \`scene_diff\` | \`board_log\` (it also reports \`owned\` and \`conflicts\`) |
| \`get_diagram_guide\` | \`read_me {sections:["style"]}\` |`,

  envelope: `## Every write returns the same envelope

\`\`\`
{ ...tool-specific result (ids, labels, nodes, cells...),
  sceneVersion, prevSceneVersion, commitId,
  changed: {created, updated, deleted, revived:[{id, previousVersion}]},
  labels: {containerId: labelId},
  persisted: {ok:true, lifted?:[{id, version}]} | {ok:false, lost:[{id, storedVersion, localVersion}]},
  ignoredFields: [{id, field, reason, hint}],   // what was NOT applied
  missing, skipped (expect mismatch), alreadyApplied,
  relaidOut, rerouted, collateral: [{id, reason}], fit, warnings,
  lint: {new:[findings], resolved, persisting:{code:count}, errors, warnings} }
\`\`\`

Empty fields are omitted. **\`ignoredFields\` is never silent**: a field the server cannot apply is listed with a hint (e.g. \`boundElements\` → bind with fromId/toId). \`persisted.ok:false\` means the store holds a newer copy — re-read and re-apply. \`persisted.lifted\` lists re-created ids the server had to save under a higher version than planned (above an old tombstone); use that version in \`expect\`.

Options on every write (\`options\`): \`dryRun\` (plan + lint, commit nothing), \`strict:"error"\` (reject the whole write if any field would be ignored), \`lint:"new"|"touched"|"errors"|"summary"|"off"\`, \`expect:{id: version}\` (optimistic lock → code conflict), \`snap\` (round the touched geometry to a grid), \`verify:{render:{}}\` (also return a PNG of the changed area), \`note\`. \`return:"full"\` echoes the changed elements. \`batch_create\`/\`update_elements\` also take \`styleFrom:<id>\` (copy another element's style), \`wrap:"balanced"\` and \`nowrap:[regex]\` (the server writes the line breaks into the text).

Errors are JSON: \`{error:{code, message, retryable, retryAfterSec?, resetAt?, details:{field?, ids?, hint?}}}\` with code not_found | forbidden | rate_limited | conflict | invalid_args | too_large | unsupported_field | internal.`,

  labels: `## Text lives inside shapes

- \`batch_create [{type:"rectangle", id:"c1", label:"Ready"}]\` creates the box and its bound label with id \`c1:label\`. Old boards may have labels with random ids; \`<containerId>:label\` still addresses them.
- Next to a \`label\`, \`fontSize\`/\`fontFamily\`/\`textAlign\`/\`verticalAlign\`/\`labelColor\` style the label (\`labelFontSize\`/\`labelFontFamily\` override). The same fields work in \`update_elements\` on the container.
- Alignment is the browser's: \`textAlign:"left"\` + \`verticalAlign:"top"\` pins the label 5 px from the top-left edge (a group title, a table cell, a code block). A diamond/ellipse inscribes its label: usable width is \`w/2-10\` / \`w/√2-10\` — \`measure_text {containerType}\` accounts for it.
- Change a label: \`update_elements [{id:"c1", label:"New"}]\` — only the text changes, alignment and font stay. \`fit:"height"|"width"|"both"\` grows the box to the text.
- A box that gets too small for its label grows (height) the way the browser would, unless you set the height in the same patch.
- Arrows take \`label\` too; it sits on the arrow's middle segment (middle point for an odd number of points) exactly where the browser draws it, and is wrapped by words.
- A free text can become a label: \`update_elements [{id:"t", containerId:"arrow1"}]\`.
- A standalone text over a shape is a defect: it does not move or wrap with the shape.`,

  arrows: `## Arrows

- \`fromId\`/\`toId\` bind both ends. When a bound shape moves or resizes (update_elements, move_elements, arrange) its arrows' ends are recomputed from the stored binding points; bends in the middle stay.
- Steer without losing the binding: \`waypoints:[[x,y],…]\` (absolute), \`route:"orthogonal"\` (elbow), \`route:"straight"\` (the server picks binding points so the arrow is exactly horizontal/vertical, or warns which dy/dx would make it possible).
- \`startAnchor\`/\`endAnchor: {side:"top"|"right"|"bottom"|"left", at:0..1}\` fixes where the arrow leaves/enters; arrows sharing a side without \`at\` are spread along it.
- Rebinding is an update: \`update_elements [{id:"a1", toId:"newTarget"}]\` moves the back-references and keeps style and label.
- Hand-written \`points\` between two shapes is a defect (no binding).
- Orthogonal routes are stored as plain polylines (not the browser's elbow arrows), so dragging a node in the browser re-aims the end segment only.`,

  editing: `## Editing and identity

- Edit in place with update_elements — never delete and re-create an element to change it. The type can change too: rectangle↔ellipse↔diamond, text↔rectangle/ellipse/diamond (the text becomes/comes from the label), arrow↔line.
- \`dx\`/\`dy\` in a patch, or \`move_elements\`, move an element with its label, frame children and arrows.
- \`reflow:{push:"below", growFrame:true}\` on update_elements shifts what lies directly below an element that grew (same frame, same column; groups move whole), keeping the gaps.
- Give elements readable ids. Re-using a deleted id revives it with a version above its tombstone (\`changed.revived\`); a live id is refused unless \`onExisting:"replace"\`.
- \`expect\` on a patch (\`{id, width:620, expect:{width:600}}\`) skips it when the element no longer has the expected values; a patch already in effect is reported as \`alreadyApplied\`.
- \`protected:true\` elements are skipped by delete_elements unless \`force\`.
- \`create_stack {ids}\` remembers a column (or row): later writes that grow a member push the rest by the same gap and grow the frame. \`update_elements {id, stack:{id, insertAt}}\` adds a member, \`stack:null\` removes one.
- Deleted elements keep a tombstone for 24 h: \`restore {ids}\` brings them back with exact geometry, labels and bindings.
- Every commit is journalled for 30 days: \`board_log\` shows what each one changed, by whom and with what note, and keeps the elements as they were *before* it. \`restore {ids, from: commitId}\` brings those copies back; \`restore {from: commitId, mode:"revert"}\` undoes the whole commit (what it changed goes back, what it created is deleted). \`board_log {ids}\` answers "when did this disappear, and who did it".`,

  frames: `## Frames

- \`create_frame {id, name, childIds, padding, titleGap}\` sizes the frame to its children; the frame sits at the bottom of the z-order, children and their labels get its frameId.
- Grow it later: \`update_elements [{id:"f1", fitToChildren:{padding:32}}]\` or \`frame_add_children {refit:true}\`.
- \`batch_create\` items with \`frameId\` + \`relative:true\` take x/y relative to the frame's corner.
- Moving a frame (move_elements) moves everything with its frameId.
- \`target.frameName\` / \`target.frameIds\` select a frame's content in query, render, move and delete.`,

  tables: `## Tables

\`set_table {tableId, spec}\` creates a table in one call and changes it with further calls on the same tableId (only the columns/rows you pass change; \`prune\`/\`removeRows\` remove).

\`\`\`
set_table {boardId, tableId:"t_err", spec:{origin:{x:0,y:2760}, numbered:"1.",
  columns:[{key:"s", header:"Symptom"}, {key:"c", header:"Cause"}],
  rows:[{key:"spin", cells:{s:"Spinner forever", c:"no binding"}}]}}
set_table {boardId, tableId:"t_err", spec:{columns:[{key:"c", width:440}]}}   // widen one column
\`\`\`

Cell ids are \`<tableId>:<row>:<col>\` (header row \`_h\`). Column width "auto" fits the widest text; rows take the height of their tallest cell; text sits top-left with \`cellPadding\`. Content below the table is pushed down when it grows (\`options.reflow\`). Read a table back with \`query_elements {target:{kind:"table-cell"}, format:"md"}\`.`,

  reading: `## Reading boards

\`query_elements {target, fields, labels, format, order, aggregate, maxChars, cursor, source}\` always returns \`{total, count, items, nextCursor?, sceneVersion}\`.

- \`target\` (shared by query, validate, render, move, delete, update): ids, frameIds, frameName, groupId, region {x,y,width,height,mode}, at {x,y} (what a click would hit), type, role, kind, slot, textContains, textRegex, hasLink, after {anchorId, axis, scope}.
- Default items are compact summaries with the label inline (\`labels:"separate"\` lists label texts on their own).
- \`format:"md"\` + \`order:"reading"\` prints the board by frame for checking content against a spec; \`format:"graph"\` returns {nodes, edges} like create_diagram's input.
- \`aggregate:"bounds"\` → the bounding box (find free space: the board's bounds).
- \`source:"stored"\` reads what is persisted rather than the bot's live copy.
- Renders carry no legend unless you ask (\`legend:"compact"\`).`,

  lint: `## Lint and suggestions

- Writes lint what they touched and return only NEW findings (\`lint.new\`); \`validate_scene\` runs a full pass with \`profile\`: "default", "visual-qa" (stricter typography/geometry, info level) or "integrity" (bindings, frames, persistence). \`summary.coverage\` lists the rules that ran.
- Every \`suggestion\` is \`{tool, args, risk}\` — call \`tool\` with \`args\` + boardId — or \`{reason}\` when no safe automatic fix exists. Integrity codes point at \`repair_scene\` (dry run by default).
- \`kind\` tells the lint what an element is: container/lane/group-frame (nesting is not overlap), legend/annotation/code/table-cell (not graph nodes), divider (no arrow rules). set_table, set_legend, create_diagram groups and code cards set it for you.
- \`validate_scene {expected:{ids, elements:[{id, label}], edges:[{from,to,label}], frames}}\` checks a board against a spec (expected_missing / expected_mismatch / expected_edge_missing / expected_frame_missing).
- Silence one deliberate exception with \`lintIgnore\` on the element: \`["overlap"]\`, or \`[{code:"overlap", with:["other"]}]\` for one pair only. On a frame or group member it covers the frame/group. \`disabledRules\` on validate_scene is board-wide — avoid it.
- \`not_persisted\` (error) means the bot shows an element the store does not have; \`repair_scene {codes:["not_persisted"]}\` writes it again.`,

  profile: `## The board profile (the style contract)

- \`set_board_profile {scope:{boardId}|{folderId}, typeScale, spacing, roles, strokeStyles, nowrap}\` stores what this board — or every board in a folder — means by its styles. A board's own profile wins field by field over the folder's; passing only \`scope\` reads back \`{profile, resolved, source}\` without changing anything.
- \`typeScale\` {title, frameTitle, colHeader, body, caption, code} is the list of font sizes the series uses. \`set_table\`, \`set_legend\` and code cards take their defaults from it, and \`spacing\` {unit, cellPadding, frameInset, blockGap} sets their padding and gutters, so a table you create on board 7 matches the one on board 1 without repeating the numbers.
- \`roles\` {accent:{tag:"[YOU]", meaning:"our team owns it"}} and \`strokeStyles\` {dashed:"[planned]"} give the palette a vocabulary. \`set_legend {fromProfile:true}\` draws the legend straight from them, so the legend cannot drift from what the colors mean.
- \`nowrap\` are regexes that must never be split across lines; labels created afterwards keep those matches whole.
- With a profile in place \`validate_scene {profile:"visual-qa"}\` adds the contract checks: style_font_size_off_profile, type_scale_violation, hierarchy_inverted (a title smaller than a caption in the same frame), semantic_conflict (text tagged [planned] on a solid stroke), role_color_mismatch. Without one they are skipped rather than guessed at — \`summary.coverage\` says which ran.`,

  persistence: `## What is stored

- Reads and renders show the bot's live copy of the board. Every write reports \`persisted\`: whether the store accepted it (\`ok:false\` lists ids where a newer stored copy won — the live copy is replaced by it, so reads stay truthful).
- validate_scene compares with the store and reports \`not_persisted\`; \`query_elements {source:"stored"}\` reads the store directly.
- For 12 s after the bot writes an element, a deletion of it arriving from another session is treated as a stale echo and undone (at most 3 times). After that a person's deletion stands — the bot never re-creates it by itself; \`restore\` it if that was a mistake.
- \`board_log\` reads the persisted journal (30 days) and the shared history, so it survives restarts; it also reports \`owned\` (ids this bot created) and \`conflicts\` (ids a person changed under it).`,
} as const;

export type ReadMeSection = keyof typeof SECTION_TEXT | "style";

export const README_SECTIONS = [
  "tools",
  "envelope",
  "labels",
  "arrows",
  "editing",
  "frames",
  "tables",
  "reading",
  "lint",
  "profile",
  "persistence",
  "style",
] as const;

const HEADER = `# excalidraw-team: the contract

Mechanical contract of this server. Style advice is section "style" (same as get_diagram_guide).`;

export const readMe = (
  sections?: readonly ReadMeSection[],
): { version: string; text: string } => {
  const wanted = sections?.length ? sections : README_SECTIONS.filter((name) => name !== "style");
  const parts = wanted.map((name) => (name === "style" ? DIAGRAM_GUIDE : SECTION_TEXT[name]));
  const text = [HEADER, ...parts].join("\n\n");
  const version = createHash("sha1").update(text).digest("hex").slice(0, 10);
  return { version, text };
};
