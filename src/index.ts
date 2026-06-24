import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type NextFunction, type Request, type Response } from "express";

import { config, getMcpUrl } from "./config";
import { authorize } from "./acl";
import { auth } from "./firebase";
import {
  createToken,
  getToken,
  listTokens,
  revokeToken,
} from "./tokens";
import {
  BotAccessDeniedError,
  disposeBot,
  getOrCreateBot,
} from "./bot/CollabBot";
import { buildMcpServer } from "./mcp";
import { getFile, putFile } from "./files";

const app = express();

app.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Access-Control-Allow-Origin", config.corsOrigin);
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS",
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, mcp-session-id, mcp-protocol-version",
  );
  res.setHeader(
    "Access-Control-Expose-Headers",
    "Content-Type, Content-Length, mcp-session-id",
  );
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

const bearer = (req: Request): string | undefined => {
  const header = req.header("authorization");
  return header?.startsWith("Bearer ") ? header.slice(7) : undefined;
};

const requireUser = async (
  req: Request,
  res: Response,
): Promise<{ uid: string; email: string | null } | null> => {
  const token = bearer(req);
  if (!token) {
    res.sendStatus(401);
    return null;
  }
  try {
    const decoded = await auth().verifyIdToken(token);
    return { uid: decoded.uid, email: decoded.email ?? null };
  } catch {
    res.sendStatus(401);
    return null;
  }
};

app.post("/mcp/tokens", express.json(), async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) {
    return;
  }
  const boardId = (req.body as { boardId?: string })?.boardId;
  if (!boardId) {
    res.status(400).json({ error: "boardId required" });
    return;
  }

  const access = await authorize(boardId, user);
  if (!access.canRead) {
    res.sendStatus(403);
    return;
  }
  const role = access.canWrite ? "editor" : "viewer";
  const { token } = await createToken({
    uid: user.uid,
    email: user.email,
    boardId,
    role,
  });

  const mcpUrl = getMcpUrl(config.port);
  const configSnippet = {
    mcpServers: {
      "excalidraw-board": {
        type: "http",
        url: mcpUrl,
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  };

  res.json({ token, mcpUrl, role, configSnippet });
});

app.get("/mcp/tokens", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) {
    return;
  }
  const boardId =
    typeof req.query.boardId === "string" ? req.query.boardId : undefined;
  const tokens = await listTokens({ uid: user.uid, boardId });
  res.json({
    tokens: tokens.map(({ token, doc }) => ({
      token,
      boardId: doc.boardId,
      role: doc.role,
      createdAt: doc.createdAt,
      revoked: doc.revoked,
    })),
  });
});

app.delete("/mcp/tokens/:token", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) {
    return;
  }
  const doc = await getToken(req.params.token);
  if (!doc || doc.uid !== user.uid) {
    res.sendStatus(404);
    return;
  }
  await revokeToken(req.params.token);
  disposeBot(req.params.token);
  res.sendStatus(204);
});

const resolveConnectToken = (req: Request): string | undefined => {
  const fromHeader = bearer(req);
  if (fromHeader) {
    return fromHeader;
  }
  return typeof req.query.token === "string" ? req.query.token : undefined;
};

app.all("/mcp", express.json(), async (req, res) => {
  const connectToken = resolveConnectToken(req);
  if (!connectToken) {
    res.status(401).json({ error: "missing connect token" });
    return;
  }
  const doc = await getToken(connectToken);
  if (!doc || doc.revoked) {
    res.status(401).json({ error: "invalid or revoked token" });
    return;
  }

  const access = await authorize(doc.boardId, {
    uid: doc.uid,
    email: doc.email,
  });
  if (!access.canRead) {
    disposeBot(connectToken);
    res.status(403).json({ error: "access denied to board" });
    return;
  }

  const bot = getOrCreateBot(connectToken, {
    uid: doc.uid,
    boardId: doc.boardId,
    role: access.canWrite ? "editor" : "viewer",
  });

  try {
    await bot.ensureConnected();
  } catch (error) {
    if (error instanceof BotAccessDeniedError) {
      disposeBot(connectToken);
      res.status(403).json({ error: "access denied to board" });
      return;
    }
    res.status(502).json({ error: "failed to attach to collab board" });
    return;
  }

  const server = buildMcpServer(bot);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.put(
  "/files/*",
  express.raw({ type: "*/*", limit: "50mb" }),
  (req, res) => {
    void putFile(req, res);
  },
);

app.get("/files/*", (req, res) => {
  void getFile(req, res);
});

app.listen(config.port, () => {
  console.log(`excalidraw-access-backend listening on :${config.port}`);
});
