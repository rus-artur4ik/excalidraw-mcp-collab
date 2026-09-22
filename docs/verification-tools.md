# Engine, verification and rendering

How the drawing tools work inside. The agent-facing contract is `read_me`
(`src/guide.ts`); this is for people changing the server.

## Layout of the code

| Path | What |
| --- | --- |
| `src/engine/txn.ts` | `SceneTxn`: a staged view over the bot's element map, plus the `WriteReport` every write fills. |
| `src/engine/write.ts` | `planWrite` (expect check → plan → strict check → snap → lint delta → change summary) and the response `Envelope`. |
| `src/engine/create.ts` | Creation: ids, revive semantics, labels (`<id>:label`), bound arrows, anchors, `fit`, `wrap`, `link`, `styleFrom`. |
| `src/engine/update.ts` | Patches: field whitelist and `ignoredFields`, type changes, label edits, rebinding, `containerId`, `fit`, `fitToChildren`, `expect`. |
| `src/engine/follow.ts` | What follows a changed shape: its label is re-laid out, bound arrow ends are re-aimed. |
| `src/engine/boundText.ts` | Client-parity label box: `computeBoundTextPosition`, `getContainerCoords`, the arrow-label anchor, container growth, opt-in balanced wrap. |
| `src/engine/arrows.ts` | Bound arrow paths: anchors, `straight`/`orthogonal` routes, the client's `updateBoundPoint` for moved shapes. |
| `src/engine/move.ts` | `move_elements`: frames carry children, containers labels, arrows translate or re-aim. |
| `src/engine/selector.ts` | The shared `target` selector. |
| `src/engine/query.ts` | `query_elements` projections and formats (json, rows, md, graph). |
| `src/engine/lifecycle.ts` | Delete (cascade, detach, protected), restore (tombstone / history), core repairs. |
| `src/engine/upsert.ts` | Desired-state apply for composites and diagram re-runs (patch only what differs, keep z-order). |
| `src/engine/reflow.ts`, `frames.ts`, `expected.ts` | Push-below reflow, `layout_frames`, `validate_scene {expected}`. |
| `src/engine/stack.ts`, `copy.ts` | Stacks that keep their gaps across writes, and `copy_elements` planning (id remap, arrows re-bound to the copies). |
| `src/exports.ts` | `export`: the file on disk plus the signed, expiring link (`GET /exports/:token`). |
| `src/profile.ts` | The board/folder style profile: load, merge (board over folder), validate, resolve against `DEFAULT_PROFILE`. |
| `src/compose/*` | Pure planners: `set_table`, `set_legend`, code card, callout, badge. |
| `src/verify/*` | Metrics (`textMetrics.ts` + `fonts.ts`), lint, renderer, ELK layout, palette. |

## The write pipeline

1. `CollabBot.write(options, fn)` checks write access and the socket.
2. `planWrite` builds a `SceneTxn` over the live map, checks `options.expect`
   (element versions), runs `fn`, rejects the write on `strict:"error"` if any
   field would be ignored, applies `snap`, lints the touched ids before and
   after (`lint.new` = findings the write introduced), and snapshots the change
   summary.
3. A dry run returns here. Otherwise the staged elements go into the live map,
   are broadcast, and `persistScene` merges them into Firestore in a
   transaction. Ids the write (re)created are passed as `reviveIds`, so a
   stored tombstone with a higher version cannot swallow them (that was the
   cause of the lost elements: a re-created id used to get version 1). Stored
   copies that won the merge replace the bot's copies (`persisted.lost` when
   that hit something the write changed); re-versioned creations are
   re-broadcast.
4. A journal entry (`scenes/{roomId}/log/{commitId}`) is written inside the same
   transaction: op, ids, counts, actor, note, and an encrypted copy of the
   affected elements as they were before the commit. `board_log` reads it (with
   the shared history), `restore {from: commitId}` restores from it, and
   `mode:"revert"` also deletes what that commit created. Entries carry
   `expiresAt` for the Firestore TTL policy (30 days).
5. `commitId` in the envelope is the journal entry id; the matching history
   snapshot has the same id under `historyEntryId`.

Commits of one bot run through a queue (`enqueue`), and every id a write
(re)creates is held in `pendingForceWin` until its commit finishes, so a
concurrent write's snapshot cannot push a fresh revival back into a tombstone.

Creation always gives a previously deleted id `tombstone.version + 1` and keeps
its stacking slot, frame and groups unless the item sets them.

## Following shapes

A patch that changes a shape's geometry re-lays out its label with the
client's formula (alignment and font kept; the box grows the way the client
grows it unless the same patch sets the size) and re-aims every bound arrow:
the moved end is recomputed from the stored `fixedPoint` toward the
neighbouring point (both ends for a 2-point arrow), middle points stay. Arrow
labels sit where the client draws them: the middle point for an odd number of
points, otherwise the middle of the middle segment.

## Rendering and metrics

Text is measured with glyph advances (+ GPOS kerning) read from the client's
fonts, vendored in `assets/fonts/` (`build.py` regenerates them from the
frontend's woff2 files). The same files are handed to resvg, so PNG widths
match the browser. Each render reports `fidelity` (texts whose font or glyphs
had to fall back) and `readability` (scale, smallest text in pixels). The
renderer also masks arrow strokes under their labels, keeps whitespace, draws
real arrowhead types, frame names and clipping, and supports `highlight`,
`legend` modes, `tiles` and `sheet` layouts.

## Composites

`src/compose/*` planners are pure: they read the live scene and return the
full desired state (`items`, `removeIds`, `extraPatches`, bounds). The core
applies it with `upsertItems`, which patches only what differs and restacks the
composite in planned order. Tables keep their merged spec in the root
element's `customData.tableSpec`; cell ids are `<tableId>:<row>:<col>`.

## The board profile

`boardProfiles/{board:<id>|folder:<id>}` — its own collection, because
`firestore.rules` validates board and folder documents field by field for
browser writes, so an extra key on them would break the app's own renames.
Only the server (Admin SDK) touches it.

`loadProfile({boardId, folderId})` merges the folder's document under the
board's, field by field; `resolveProfile` fills the gaps from
`DEFAULT_PROFILE`. The MCP layer looks a board's profile up once per server
(`profileOf`, cleared by `set_board_profile`) and hands it to the bot
(`useProfile`), which passes it to the planners (`planTable`, `planLegend`,
`planCodeCard`, `planCallout`), to label wrapping (`nowrap`) and to
`lintScene` as `boardProfile`. A call can override it per write
(`options.boardProfile`). The profile rules are `needsProfile` and live in the
`visual-qa` lint profile, so a board without a contract is never linted
against guessed defaults.

## Lint

`lintScene` / `validate_scene` — see the rule list in `read_me` (section
`lint`) and `src/verify/lint.ts`. Every suggestion is `{tool, args, risk}` with
`args` valid for `SUGGESTION_TOOL_SCHEMAS[tool]` in `src/toolSchemas.ts`, or
`{reason}`. Deterministic integrity fixes run through `repair_scene`
(`src/verify/repair.ts` + `repairCore` in `src/engine/lifecycle.ts`).
