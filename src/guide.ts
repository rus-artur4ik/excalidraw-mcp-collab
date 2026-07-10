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
