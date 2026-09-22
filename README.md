# excalidraw-access-backend

Standalone Node + TypeScript backend for a self-hosted Excalidraw fork with
per-board access control (Firebase project `excalidraw-team`). It provides:

- **MCP remote endpoint** (`ALL /mcp`) that lets an AI agent draw on a real
  collab board *as a specific user*. The agent's writes respect the board's
  read-only policy and are attributed in shared history as `Бот <name>`.
- **MCP connect-token** mint / list / revoke endpoints.
- **Filesystem-backed image file service** that replaces Firebase Storage,
  with the same per-board ACL the room server enforces.

The service never modifies the frontend or the room fork; it matches their wire
formats (encryption, socket protocol, Firestore scene/history doc shapes).

## How it works

### Socket auth = exchanged Firebase ID token

The collab (socket.io) server authenticates clients with a Firebase **ID
token** and runs its own ACL on `join-room`. The Admin SDK can only mint a
**custom token** for a uid, so the bot:

1. `admin.auth().createCustomToken(uid)`
2. exchanges it for an ID token via Identity Toolkit
   (`accounts:signInWithCustomToken?key=${FIREBASE_WEB_API_KEY}`)
3. connects with `auth: { token: idToken }`

The room server therefore resolves the bot **as the user**, so its existing
read/write enforcement applies automatically: a viewer-token bot's
`server-broadcast` frames are dropped by the room server, and this service also
refuses to broadcast/persist when the token role is `viewer`.

### Encryption

`src/encryption.ts` replicates the frontend
(`packages/excalidraw/data/encryption.ts`) exactly using Node Web Crypto
(`globalThis.crypto.subtle`): a 22-char base64url AES-128-GCM key imported via
JWK `{ alg: "A128GCM", k, kty: "oct" }`, 12-byte random IV. Verified
byte-compatible by round-trip.

### Scene + history persistence

`src/scene.ts` ports the Admin-SDK equivalent of `excalidraw-app/data/firebase.ts`:

- `scenes/{roomId}` = `{ sceneVersion, ciphertext, iv }` (encrypted elements).
- shared history index `scenes/{roomId}~history` + per-entry payload
  `scenes/{roomId}~history~{entryId}`, matching `SceneHistory` entry shape and
  `MAX_SCENE_HISTORY_ENTRIES` so the frontend HistorySidebar renders bot
  entries (with `author`).

Byte fields are written as Node `Buffer` (the Admin SDK has no web-only `Bytes`
class); the underlying Firestore `bytesValue` is identical to what the web SDK
`Bytes` produces, so `data.ciphertext.toUint8Array()` on the frontend reads the
same bytes.

## Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/mcp/tokens` | Firebase ID token (Bearer) | Mint a connect token for `{ boardId }`. Returns `{ token, mcpUrl, role, configSnippet }`. Caller must `canRead`; role = `editor` if `canWrite` else `viewer`. |
| `GET` | `/mcp/tokens?boardId=` | Firebase ID token | List caller's tokens. |
| `DELETE` | `/mcp/tokens/:token` | Firebase ID token | Revoke a token the caller owns. |
| `ALL` | `/mcp` | connect token (Bearer or `?token=`) | MCP Streamable HTTP endpoint; lazily attaches a `CollabBot`. |
| `PUT` | `/files/*` | optional Firebase ID token | Store raw opaque bytes. `files/rooms/{roomId}/...` requires `canWrite`; `files/shareLinks/...` open. |
| `GET` | `/files/*` | optional Firebase ID token | Return raw bytes. `files/rooms/{roomId}/...` requires `canRead`; `files/shareLinks/...` open. |

The file bytes are already client-encrypted + compressed; the service stores and
returns them verbatim.

### MCP tools

- `list_boards` — boards the token's account can reach through the bot, with
  the bot's access level on each and the board's `description` when it has one.
  For bots with the folders permission each entry also carries
  `folder: { folderId, name }` when the board sits in one of the owner's
  folders (a failed folder lookup degrades to the plain list).
- `create_board` — new empty board owned by the token's account, bound to the
  calling bot with `write` in the same batch (board doc + `boardKeys` + the
  bot's allow-list entry commit together). Gated by the per-bot
  `canCreateBoards` flag the owner sets in the bot's settings; a `team`-visible
  board additionally requires the owning account to be a member of the shared
  team. Rate-limited to 10 boards per hour per bot (in-memory). An optional
  `folderId` files the new board into one of the owner's folders (needs the
  folders sub-permission below; the folder is resolved before the board is
  written, and a failed filing is reported as `folderWarning` next to the
  created board rather than thrown). An optional `description` is stored with
  the board.
- `set_board_description` — sets (or, with `""`, removes) the short blurb the
  app shows under a board's name in the board list. Allowed only when the bot
  could write to the board (allow-list binding, bot policy, account ACL) **and**
  the token's account may change the board's settings — its owner, or a team
  admin on a team board — mirroring `firestore.rules`. Writes only the board
  doc; no collab connection is opened. Descriptions from both tools are
  normalized to one paragraph of at most 300 characters, the limit
  `firestore.rules` enforces for browser writes.
- `rename_board` — renames a board (`title`, normalized to one line of at most
  120 characters; an empty name is refused). Same permission check as
  `set_board_description`; returns `{ boardId, title, previousTitle }`.
- `list_folders`, `create_folder` — the owner's personal home-page folders
  (`users/{uid}/folders`), which group boards without affecting access. Gated by
  the per-bot `canCreateFolders` flag, a sub-permission that only counts while
  `canCreateBoards` is also on. `create_folder` is idempotent by
  case-insensitive name and returns `{ folderId, name, created }`; capped at 20
  per hour per bot (in-memory) and 100 folders per account. `list_folders` only
  echoes board ids the calling bot is bound to. Folder docs carry exactly the
  keys `firestore.rules` allows (`name`, `boardIds`, `createdAt`, `updatedAt`) —
  an extra field would make the owner's later edits from the browser fail.
- `move_board_to_folder` — files a board the bot can reach (read is enough)
  into one of the owner's folders, or with `folderId: null` takes it out of
  every folder; a board sits in at most one folder, so the move is one batch.
  Needs the same folders permission. Returns `{ boardId, title, folder }`.
- `get_bot_info` — the bot's permissions (create boards / folders), bound
  boards and quotas with usage and reset time, before it tries anything.
- `query_elements` — reads with the shared
  `target` selector (ids, frameIds, frameName, groupId, region, type, role,
  kind, slot, textContains, textRegex, hasLink, after), compact summaries with
  labels inline, `format` rows/md/graph, `aggregate:"bounds"`, a `maxChars` cut
  with `nextCursor`, `source:"stored"` for the persisted copy, and `scope`
  (folder or board list) to search a whole series from stored scenes.
- `batch_create`, `update_elements`, `move_elements`, `delete_elements`,
  `restore`, `repair_scene`, `create_diagram`, `set_table`, `set_legend`,
  `layout_frames`, `create_frame`, `frame_add_children`, `arrange`,
  `group_elements`, `ungroup_elements`, `reorder`, `replace_text` — writes. Each one plans
  in a staged transaction (`src/engine/`), lints what it touched before and
  after, and commits once. They all take `options` (`dryRun`, `strict`,
  `lint`, `expect`, `snap`, `verify`, `note`) and return one envelope:
  `changed {created, updated, deleted, revived}`, `labels`, `persisted`,
  `ignoredFields`, `relaidOut`/`rerouted`/`collateral`, `lint {new, resolved,
  persisting}`. See `read_me` (`src/guide.ts`) for the agent-facing contract.
- `validate_scene`, `measure_text`, `render`, `board_log`, `export` — read-only
  (MCP `readOnlyHint`). `render` covers the whole board, a rectangle, a
  `target` (e.g. a frame by name) or a set of ids, with tiles and sheets for
  large areas; `export` writes the picture to disk and returns a link that
  expires instead of pushing bytes through the conversation.
- `copy_elements`, `create_stack`, `apply_ops` — duplicate a block (also onto
  another board), keep a column's gaps through later edits, and run several
  operations as one commit.
- `set_board_profile` — the style contract of a board or a whole folder
  (`boardProfiles/{board:<id>|folder:<id>}`, server-only): the type scale,
  spacing, what each palette role and stroke style means, and the patterns that
  must never wrap. Planners take their defaults from it (so a table on the
  seventh board matches the first), `set_legend {fromProfile:true}` draws the
  legend from it, and `validate_scene {profile:"visual-qa"}` checks the board
  against it (`style_font_size_off_profile`, `type_scale_violation`,
  `hierarchy_inverted`, `semantic_conflict`, `role_color_mismatch`). A board's
  own profile wins field by field over its folder's; passing only `scope` reads
  it back. Without a profile those rules are skipped, not guessed at.

Tools that were folded into others (the `read_me` "Which tool" section carries
the table for agents): `describe_scene`, `get_bounds`, `element_at`,
`render_scene`/`render_region`/`render_element`, `delete_region`,
`bring_to_front`/`send_to_back`, `connect`, `scene_diff`, `get_diagram_guide`.

Errors are structured: `{error:{code, message, retryable, retryAfterSec?,
details}}` with codes not_found, forbidden, rate_limited, conflict,
invalid_args, unsupported_field, internal.

See `docs/verification-tools.md` for the engine, the lint, the renderer and the
composite planners.

Each commit broadcasts a `SCENE_UPDATE` over `server-broadcast`, merge-persists
the scene into Firestore in a transaction (so a concurrent human session is
never clobbered), writes a journal entry in that same transaction, and appends
a history entry attributed `Бот <name>`. Commits of one bot are serialized
through a queue, so a persist never snapshots another write half-way through.

The journal lives in `scenes/{roomId}/log/{commitId}`: what changed, by whom,
with the note the agent passed, and an encrypted copy of the affected elements
**as they were before** that commit (skipped for very large commits). That is
what `board_log` reads and what lets `restore {from: commitId}` (and
`mode:"revert"`) put a board back long after the 24 h tombstones are gone.
Entries carry `expiresAt` for a Firestore TTL policy — enable it once per
project:

```bash
gcloud firestore fields ttls update expiresAt \
  --collection-group=log --enable-ttl --project=excalidraw-team
``` The
persist step reports back which stored copies won the version race; the bot
adopts them into memory, so its reads never show what a reload would lose, and
an element the write deliberately created (or revived) is lifted above any
stored tombstone of the same id. A re-created id always gets a version above
its tombstone.

The bot keeps stable ownership of the ids it creates. Only for a short grace
window after it last wrote an element (`RESURRECTION_WINDOW_MS`, 12 s, at most
3 times) does it resist an incoming deletion — that window covers the
stale-tombstone race where an out-of-sync live session drops a just-created
element. Once the window passes, a human deleting or editing a bot element is
respected and wins immediately.

Text metrics and the PNG renderer use the client's fonts, vendored as TTF in
`assets/fonts/` (regenerate with `assets/fonts/build.py`).

## Setup

```bash
cp .env.example .env   # fill in the values
npm install
npm run build
npm start              # or: npm run dev
```

Required env (see `.env.example`):

- `GOOGLE_APPLICATION_CREDENTIALS` — absolute path to the service-account JSON
  (Admin SDK).
- `FIREBASE_WEB_API_KEY` — the web `apiKey` (`AIzaSy...`) from the SDK config;
  required for the custom-token → ID-token exchange.
- `WS_SERVER_URL` — the collab server (default `http://localhost:3002`).
- `FIREBASE_PROJECT_ID` (default `excalidraw-team`), `PORT`, `CORS_ORIGIN`,
  `DATA_DIR`, `PUBLIC_BASE_URL`.

## Mint a token + paste the MCP config

```bash
curl -X POST http://localhost:3015/mcp/tokens \
  -H "Authorization: Bearer <FIREBASE_ID_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"boardId":"<roomId>"}'
```

The response `configSnippet` is a ready-to-paste remote-MCP client config:

```json
{
  "mcpServers": {
    "excalidraw-board": {
      "type": "http",
      "url": "http://localhost:3015/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

The agent connecting with that config draws on the board as the token's user.

## Deploy notes

- Run behind TLS and set `PUBLIC_BASE_URL` so `mcpUrl` in token responses is
  correct.
- Mount `DATA_DIR` on persistent storage (it replaces Firebase Storage, and
  holds `exports/` — the files behind `export` links).
- Set `INTERNAL_SECRET`: it signs export links. With it empty the server signs
  with a per-process key, so every export link dies on restart.
- The proxy must route `/exports/` to the backend (both `proxy/nginx.conf` and
  `k8s/proxy.conf` in the stack repo do).
- The service holds in-memory `CollabBot` instances keyed by connect token; it
  is intended to run as a single process. Horizontal scaling would need a
  shared bot registry / sticky routing (not implemented).
- Firestore security rules must allow the service account to read `boards`,
  `boardKeys`, `teams` and read/write `scenes*` and `mcpTokens`. (The Admin SDK
  bypasses rules; `create_board` writes `boards`, `boardKeys` and the caller's
  `bots` document, and the folder tools write `users/{uid}/folders`.)
- `PUBLIC_APP_ORIGIN` — origin the Excalidraw app is served from, used to put an
  openable `url` in the `create_board` response. Falls back to
  `PUBLIC_BASE_URL`, which is the same origin in the default stack.

## Not yet verified live

End-to-end testing needs real credentials and a running room server, which are
not available in this build environment. The following paths are
structurally complete and type-checked but **not exercised against live
infrastructure**:

- Firebase Admin init with a real service account and `verifyIdToken`.
- Custom-token → ID-token exchange against Identity Toolkit, and the room
  server accepting that ID token and applying read-only for viewer tokens.
- Live socket handshake (`init-room` → `join-room` →
  `first-in-room`/`new-user`/`room-user-change`) and `client-broadcast`
  decryption / reconciliation timing. The handshake resolves on the first
  membership event or after a 4s fallback.
- Actual Firestore writes to `scenes/{roomId}` and `scenes/{roomId}~history*`
  and the frontend HistorySidebar rendering the `Бот <name>` entries.
- The frontend reading files written by `PUT /files/*` (path-shape and opaque
  byte passthrough are implemented; the exact `Content-Type`/CORS headers the
  frontend expects on `GET` were set permissively but not validated against a
  live client).
- Fractional index ordering interop: the public `fractional-indexing@3.3.0`
  package is used; the frontend uses `@excalidraw/fractional-indexing@3.3.0`
  (a fork with identical key output), assumed byte-compatible but not
  co-tested.
```
