import {StreamableHTTPServerTransport} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, {type NextFunction, type Request, type RequestHandler, type Response,} from "express";

import {config, getMcpUrl} from "./config";
import {authorize} from "./acl";
import {listAccessibleBoards, listBotBoards} from "./boards";
import {getBot, requireOwnedBot} from "./bots";
import {auth} from "./firebase";
import {countActiveTokensForBot, createToken, getToken, listTokens, revokeToken, touchToken,} from "./tokens";
import {
  BotAccessDeniedError,
  type BotIdentity,
  botRuntimeStatus,
  type CollabBot,
  getOrCreateBot,
  stopBot,
} from "./bot/CollabBot";
import {DEFAULT_BOT_COLOR} from "./types";
import {buildMcpServer} from "./mcp";
import {deleteRoomFiles, getFile, putFile} from "./files";
import {
  logError,
  logInfo,
  logWarn,
  newRequestId,
  opaqueRef,
  runWithLogContext,
  safeUrl,
  setLogContext,
} from "./logger";

const app = express();
let processTerminationStarted = false;

const terminateAfterLogging = (
  event: string,
  error: unknown,
  fields: Record<string, unknown> = {},
): void => {
  logError(event, error, fields);
  if (processTerminationStarted) {
    return;
  }
  processTerminationStarted = true;
  setTimeout(() => process.exit(1), 50);
};

process.on("unhandledRejection", (reason) => {
  terminateAfterLogging("process.unhandled_rejection", reason);
});

process.on("uncaughtException", (error, origin) => {
  terminateAfterLogging("process.uncaught_exception", error, { origin });
});

app.use((req: Request, res: Response, next: NextFunction) => {
  const requestId = newRequestId();
  const startedAt = Date.now();
  res.setHeader("X-Request-Id", requestId);
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
  runWithLogContext(
    { requestId, method: req.method, path: req.path },
    () => {
      logInfo("http.request.started", {
        userAgent: req.header("user-agent") ?? undefined,
      });
      res.on("finish", () => {
        logInfo("http.request.finished", {
          statusCode: res.statusCode,
          durationMs: Date.now() - startedAt,
        });
      });
      res.on("close", () => {
        if (!res.writableEnded) {
          logWarn("http.request.closed_early", {
            statusCode: res.statusCode,
            durationMs: Date.now() - startedAt,
          });
        }
      });
      if (req.method === "OPTIONS") {
        res.sendStatus(204);
        return;
      }
      next();
    },
  );
});

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

const asyncRoute = (
  handler: (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => Promise<void>,
): RequestHandler => {
  return (req, res, next) => {
    void handler(req, res, next).catch(next);
  };
};

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
    logWarn("firebase.user_auth.missing_token");
    res.sendStatus(401);
    return null;
  }
  try {
    const decoded = await auth().verifyIdToken(token);
    setLogContext({ subjectRef: opaqueRef(decoded.uid) });
    logInfo("firebase.user_auth.succeeded");
    return { uid: decoded.uid, email: decoded.email ?? null };
  } catch (error) {
    logError("firebase.user_auth.failed", error);
    res.sendStatus(401);
    return null;
  }
};

app.post("/mcp/tokens", express.json(), asyncRoute(async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) {
    return;
  }
  const botId = typeof req.body?.botId === "string" ? req.body.botId : undefined;
  if (!botId) {
    res.status(400).json({ error: "botId required" });
    return;
  }
  const name = typeof req.body?.name === "string" ? req.body.name : undefined;
  const bot = await requireOwnedBot(botId, user.uid);
  if (!bot) {
    res.sendStatus(404);
    return;
  }

  const { token } = await createToken({
    uid: user.uid,
    email: user.email,
    botId,
    name,
  });

  const mcpUrl = getMcpUrl(config.port);
  const serverName = "excalidraw-team";
  const configSnippet = {
    mcpServers: {
      [serverName]: {
        type: "http",
        url: mcpUrl,
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  };

  res.json({ token, mcpUrl, serverName, configSnippet });
  logInfo("mcp_token.create.succeeded", {
    tokenRef: opaqueRef(token),
    botId,
  });
}));

app.get("/mcp/tokens", asyncRoute(async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) {
    return;
  }
  const botId =
    typeof req.query.botId === "string" ? req.query.botId : undefined;
  const tokens = await listTokens({ uid: user.uid, botId });
  res.json({
    tokens: tokens.map(({ token, doc }) => ({
      token,
      name: doc.name ?? "",
      createdAt: doc.createdAt,
      revoked: doc.revoked,
      lastUsedAt: doc.lastUsedAt ?? null,
    })),
  });
  logInfo("mcp_token.list.succeeded", { count: tokens.length });
}));

app.delete("/mcp/tokens/:token", asyncRoute(async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) {
    return;
  }
  const doc = await getToken(req.params.token);
  if (!doc || doc.uid !== user.uid) {
    logWarn("mcp_token.revoke.not_found", {
      tokenRef: opaqueRef(req.params.token),
    });
    res.sendStatus(404);
    return;
  }
  setLogContext({
    tokenRef: opaqueRef(req.params.token),
  });
  await revokeToken(req.params.token);
  if (doc.botId && (await countActiveTokensForBot(doc.botId)) === 0) {
    stopBot(doc.botId);
    logInfo("bot.stop.on_last_token_revoke", { botId: doc.botId });
  }
  res.sendStatus(204);
  logInfo("mcp_token.revoke.succeeded");
}));

app.get("/mcp/bots/status", asyncRoute(async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) {
    return;
  }
  const botId =
    typeof req.query.botId === "string" ? req.query.botId : undefined;
  if (!botId) {
    res.status(400).json({ error: "botId required" });
    return;
  }
  const bot = await requireOwnedBot(botId, user.uid);
  if (!bot) {
    res.sendStatus(404);
    return;
  }
  res.json(botRuntimeStatus(botId));
}));

app.post("/mcp/bots/:botId/stop", asyncRoute(async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) {
    return;
  }
  const bot = await requireOwnedBot(req.params.botId, user.uid);
  if (!bot) {
    res.sendStatus(404);
    return;
  }
  stopBot(req.params.botId);
  res.sendStatus(204);
  logInfo("bot.stop.succeeded", { botId: req.params.botId });
}));

const resolveConnectToken = (req: Request): string | undefined => {
  const fromHeader = bearer(req);
  if (fromHeader) {
    return fromHeader;
  }
  return typeof req.query.token === "string" ? req.query.token : undefined;
};

app.all("/mcp", express.json(), asyncRoute(async (req, res) => {
  const connectToken = resolveConnectToken(req);
  if (!connectToken) {
    logWarn("mcp.connect.missing_token");
    res.status(401).json({ error: "missing connect token" });
    return;
  }
  const tokenRef = opaqueRef(connectToken);
  setLogContext({ tokenRef });
  logInfo("mcp.connect.started", {
    rpcMethod:
      typeof req.body?.method === "string" ? req.body.method : undefined,
    protocolVersion: req.header("mcp-protocol-version") ?? undefined,
  });

  const doc = await getToken(connectToken);
  if (!doc || doc.revoked) {
    logWarn("mcp.connect.invalid_token", {
      tokenFound: !!doc,
      revoked: doc?.revoked ?? false,
    });
    res.status(401).json({ error: "invalid or revoked token" });
    return;
  }
  const account = { uid: doc.uid, email: doc.email };
  setLogContext({ subjectRef: opaqueRef(account.uid) });
  logInfo("mcp.connect.token_resolved");
  if (!doc.lastUsedAt || Date.now() - doc.lastUsedAt > 60_000) {
    void touchToken(connectToken);
  }

  const botDoc = doc.botId ? await getBot(doc.botId) : null;
  if (doc.botId && (!botDoc || botDoc.ownerUid !== doc.uid)) {
    logWarn("mcp.connect.bot_missing", { botId: doc.botId });
    res.status(401).json({ error: "bot not found for token" });
    return;
  }
  if (doc.botId && botDoc?.disabled) {
    stopBot(doc.botId);
    logWarn("mcp.connect.bot_disabled", { botId: doc.botId });
    res.status(403).json({ error: "bot disabled" });
    return;
  }

  const profile = botDoc
    ? {
        botId: doc.botId as string,
        name: botDoc.name,
        avatar: botDoc.avatar?.value ?? "🤖",
        color: botDoc.color || DEFAULT_BOT_COLOR,
      }
    : {
        botId: `legacy:${doc.uid}`,
        name: doc.email ?? doc.uid,
        avatar: "🤖",
        color: DEFAULT_BOT_COLOR,
      };
  const bindings = botDoc
    ? Array.isArray(botDoc.boards)
      ? botDoc.boards
      : []
    : null;

  const resolveBot = async (boardId: string): Promise<CollabBot> => {
    setLogContext({ boardId });
    if (bindings && !bindings.some((binding) => binding.boardId === boardId)) {
      logWarn("mcp.board.not_bound", { boardId, botId: profile.botId });
      throw new BotAccessDeniedError(boardId);
    }
    const access = await authorize(boardId, account, { asBot: true });
    if (!access.canRead) {
      logWarn("mcp.board.access_denied", { boardId });
      throw new BotAccessDeniedError(boardId);
    }
    const binding = bindings?.find((entry) => entry.boardId === boardId);
    const canWrite = access.canWrite && (binding ? binding.role === "write" : true);
    const identity: BotIdentity = {
      botId: profile.botId,
      ownerUid: doc.uid,
      boardId,
      role: canWrite ? "editor" : "viewer",
      name: profile.name,
      avatar: profile.avatar,
      color: profile.color,
    };
    const bot = getOrCreateBot(identity);
    await bot.ensureConnected();
    return bot;
  };

  const server = buildMcpServer({
    resolveBot,
    listBoards: () =>
      bindings ? listBotBoards(account, bindings) : listAccessibleBoards(account),
  });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  res.on("close", () => {
    logInfo("mcp.transport.closed");
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    logInfo("mcp.transport.connected");
    await transport.handleRequest(req, res, req.body);
    logInfo("mcp.transport.request_handled");
  } catch (error) {
    logError("mcp.transport.failed", error);
    throw error;
  }
}));

app.put(
  "/files/*",
  express.raw({ type: "*/*", limit: "50mb" }),
  asyncRoute(async (req, res) => {
    await putFile(req, res);
  }),
);

app.get(
  "/files/*",
  asyncRoute(async (req, res) => {
    await getFile(req, res);
  }),
);

app.delete(
  "/files/rooms/:roomId",
  asyncRoute(async (req, res) => {
    await deleteRoomFiles(req, res);
  }),
);

app.use(
  (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logError("http.request.unhandled_error", error, {
      headersSent: res.headersSent,
    });
    if (res.headersSent) {
      res.end();
      return;
    }
    res.status(500).json({ error: "internal server error" });
  },
);

app.listen(config.port, () => {
  logInfo("backend.started", {
    port: config.port,
    firebaseProjectId: config.firebaseProjectId,
    wsServerUrl: safeUrl(config.wsServerUrl),
    publicBaseUrl: config.publicBaseUrl
      ? safeUrl(config.publicBaseUrl)
      : undefined,
    credentialPath:
      config.serviceAccountPath,
    credentialType: "service-account-cert",
  });
});
