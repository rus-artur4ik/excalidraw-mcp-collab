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

- `describe_scene` — current non-deleted elements (viewer + editor).
- `query_elements` — filter by `type` / `ids` (viewer + editor).
- `create_element`, `update_element`, `delete_element`, `clear_canvas` —
  editor only. A viewer token gets an MCP error `read-only access`.

Each mutating tool: applies the change (bumps `version`, fresh `versionNonce`,
`updated`, fractional `index` after the last element), broadcasts a
`SCENE_UPDATE` over `server-broadcast`, persists the full scene, and appends a
history entry attributed `Бот <name>`.

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
- Mount `DATA_DIR` on persistent storage (it replaces Firebase Storage).
- The service holds in-memory `CollabBot` instances keyed by connect token; it
  is intended to run as a single process. Horizontal scaling would need a
  shared bot registry / sticky routing (not implemented).
- Firestore security rules must allow the service account to read `boards`,
  `boardKeys`, `teams` and read/write `scenes*` and `mcpTokens`.

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
