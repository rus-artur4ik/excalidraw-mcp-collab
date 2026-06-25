# Verification & self-review MCP tools

Tools that let an AI agent inspect, measure, validate, render and safely mutate a
collab board so it can review its own drawing. All logic lives in `src/verify/`
as pure functions over the in-memory element model; `CollabBot` exposes them and
`mcp.ts` registers the tools.

## Tools

| Tool | Access | Purpose |
| --- | --- | --- |
| `validate_scene` | read | Deterministic lint over the whole board; returns machine-actionable findings with element ids + suggested fixes. |
| `measure_text` | read | Wrapped text width/height for a font, plus the container size needed to fit it. |
| `get_bounds` | read | Rotation-aware bounding box of the whole board or a set of ids. |
| `element_at` | read | Top-most element under a scene point (z-order aware hit-test). |
| `scene_diff` | read | Elements changed since a given `sceneVersion`, split by origin (bot vs incoming human edits). |
| `render_scene` | read | SVG (always) + PNG (when `@resvg/resvg-js` is present) of the board, with Set-of-Mark id labels, an optional grid, a coordinate transform and an element legend. |
| `render_region` | read | Same, clipped to a scene rectangle. |
| `render_element` | read | Same, cropped to one or more elements (focus render). |
| `connect` | write | Create a properly bound arrow between two shapes (`FixedPointBinding` + back-references). |
| `batch_create` | write | Create N elements in a single broadcast/persist/history commit. |
| `arrange` | write | Re-layout a set of elements (grid / row / column / align / distribute). |
| `undo_last` | write | Revert the bot's last mutation (session-scoped, version-safe). |

`create_element` / `update_element` / `batch_create` / `connect` additionally
return inline `warnings` (a focused lint pass on the affected element) so the
agent gets self-review feedback without a separate call.

Every write tool also returns `sceneVersion` and a `readback` confirmation
(re-read of the element from the authoritative in-memory map after commit), which
surfaces dropped or concurrently-superseded writes.

## Grounding: how the agent maps a visual problem to an element id

`render_scene` returns three things together:

1. **image** — SVG/PNG the model looks at, with a **Set-of-Mark** badge drawn on
   each element (`①`, `②`, … or `A1`).
2. **transform** — `{ scale, offsetX, offsetY, width, height }` so any pixel maps
   back to scene coordinates: `sceneX = pixelX/scale - offsetX`.
3. **legend** — `[{ label, id, type, bbox, textPreview }]` mapping each badge to
   its element id.

So the agent never localizes from raw pixels: a visual issue → badge → legend →
id. Most geometric issues never need the image at all because `validate_scene`
already returns the offending ids.

## Render fidelity

The SVG emitter is a **schematic** renderer (clean vector rectangles/ellipses/
diamonds/arrows/text), not the hand-drawn rough.js look of the live editor. It is
geometrically faithful (positions, sizes, text wrapping with measured widths,
colors, z-order), which is what self-review needs — overlaps, overflow,
misalignment and occlusion are all visible. Embeddables/iframes render as
placeholder boxes. Text width uses a pure-JS advance-width table (≈5–10% error vs
the browser); height is exact. If `@resvg/resvg-js` is not installed, PNG is
omitted and the SVG string is still returned.

PNG rasterization needs fonts in the runtime image — the Dockerfile installs
`fontconfig` + `font-dejavu` and resvg falls back to `DejaVu Sans`. Render scale
is clamped to `[0.1, 4]` and total output capped at 4 megapixels so a large board
or a huge `scale` cannot block the event loop. Color values are XML-escaped, so
hostile/malformed colors cannot corrupt the SVG.

## Deterministic lint rules (`validate_scene`)

Each finding: `{ code, severity, elementIds, message, suggestion? }`.
`severity ∈ {error, warning, info}`. `suggestion` is machine-actionable, e.g.
`{ action: "resize", id, width, height }`, `{ action: "move", id, dx, dy }`,
`{ action: "connect", fromId, toId }`, `{ action: "delete", id }`.

### Structural (error)
| code | trigger |
| --- | --- |
| `degenerate_size` | rectangle/ellipse/diamond/image/frame/text with `width<=0` or `height<=0`. |
| `empty_text` | text element whose `text` is empty/whitespace. |
| `arrow_dangling_binding` | `startBinding`/`endBinding.elementId` not present (or deleted) — dropped on load. |
| `binding_backref_missing` | arrow bound to S but `S.boundElements` lacks `{id:arrow,type:"arrow"}`, or S lists an arrow that has no matching binding — breaks move-tracking. |
| `binding_invalid` | binding present but missing `mode` or `fixedPoint` — dropped by `restore.ts`. |

### Visual defects (warning)
| code | trigger | threshold |
| --- | --- | --- |
| `overlap` | two eligible shapes' rotated AABBs overlap | `intersection / min(areaA,areaB) > 0.15`; excludes container↔bound-text, frame↔child, same-group pairs, lines/arrows. |
| `text_overflow` | bound text exceeds container's bound-text max box, or non-autoResize standalone text exceeds its box | wrapped measured size vs `getBoundTextMaxWidth/Height`. |
| `occlusion` | opaque solid element fully covers a lower-z element with content | `E.index > O.index`, `opacity>=90`, AABB-contains. |
| `off_canvas_outlier` | element entirely outside the cluster of all others | gap `> max(4000, 2×clusterDiagonal)`, only with `>=3` elements. |
| `duplicate` | same-type near-identical twin | `|Δx|,|Δy|<=1.5`, `|Δw|,|Δh|<=1.5`, same colors + text. |
| `arrow_unbound_endpoint` | unbound arrow endpoint within binding range of a shape | warning `<=6px` (gap), info `<=15px` (`maxBindingDistance`). |
| `arrow_zero_length` | arrow whose points are coincident / 0×0 bbox. | |
| `invisible_opacity` | `opacity<=0`. | |
| `out_of_range` | `opacity∉[0,100]`, `roughness∉{0,1,2}`, `strokeWidth<=0`, `fontSize<=0`. | |
| `invalid_enum` | unknown `fillStyle`/`strokeStyle`/`fontFamily`/arrowhead. | |
| `low_contrast` | text vs its background contrast below WCAG | `<4.5` normal, `<3.0` for `fontSize>=24`; standalone text assumes white canvas. |

### Style / layout hints (info)
| code | trigger |
| --- | --- |
| `alignment_near_miss` | an edge/center coordinate differs by `0 < d <= 4px` (probably meant to align). |
| `style_many_fonts` | more than 2 distinct font families among text. |
| `style_many_stroke_colors` | more than 6 distinct stroke colors. |

`validate_scene` returns `{ sceneVersion, summary:{errors,warnings,infos}, findings, graph }`
where `graph` is an informational connectivity summary `{ nodes, edges, isolated }`
built from shapes + bound arrows (useful for flowchart review). Rule categories
and thresholds can be toggled via tool params.

## Versioning / consistency notes
- `sceneVersion` = sum of element `version`s (`scene.ts:getSceneVersion`); it is
  monotonic because versions only increase, so `scene_diff(since)` thresholds on
  the per-write `sceneVersionAfter` recorded in a capped write-log.
- `undo_last` restores prior element state with `version = current+1` so the
  revert propagates through other clients' `reconcileIncoming` (`version >` check).
- Session-scoped (in-memory): undo stack and write-log live with the bot and are
  lost on `dispose`.
