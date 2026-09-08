import {StreamableHTTPServerTransport} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, {type NextFunction, type Request, type RequestHandler, type Response,} from "express";

import {config, getBoardUrl, getMcpUrl} from "./config";
import {authorize} from "./acl";
import {createBoardForBot, listAccessibleBoards} from "./boards";
import {auth} from "./firebase";
import {createToken, getToken, listTokens, revokeToken, touchToken,} from "./tokens";
import {
  BoardCreationDeniedError,
  bindingFor,
  decideBotBoardAccess,
  decideBotBoardCreation,
  getBot,
  getOwnedBot,
} from "./bots";
import {
  BotAccessDeniedError,
  type CollabBot,
  disposeBotsForToken,
  getOrCreateBot,
  statusForTokens,
} from "./bot/CollabBot";
import {buildMcpServer, type CreateBoardInput} from "./mcp";
import {createRateLimiter} from "./rateLimit";
import {getFile, putFile} from "./files";
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

// A looping agent must not be able to bury its owner in fresh boards; the
// permission decides *whether* a bot may create, this decides *how fast*.
const BOARD_CREATE_LIMIT = 10;
const BOARD_CREATE_WINDOW_MS = 60 * 60_000;
const boardCreateLimiter = createRateLimiter({
  limit: BOARD_CREATE_LIMIT,
  windowMs: BOARD_CREATE_WINDOW_MS,
});

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

  const body = (req.body ?? {}) as { botId?: unknown; name?: unknown };
  const botId = typeof body.botId === "string" ? body.botId : undefined;
  if (!botId) {
    res.status(400).json({ error: "botId is required" });
    return;
  }
  const bot = await getOwnedBot(botId, user.uid);
  if (!bot) {
    res.sendStatus(404);
    return;
  }
  const name =
    typeof body.name === "string" && body.name.trim()
      ? body.name.trim()
      : null;

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
      name: doc.name ?? null,
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
  disposeBotsForToken(req.params.token);
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
    res.status(400).json({ error: "botId is required" });
    return;
  }
  const bot = await getOwnedBot(botId, user.uid);
  if (!bot) {
    res.sendStatus(404);
    return;
  }
  const tokens = (await listTokens({ uid: user.uid, botId })).map(
    ({ token }) => token,
  );
  const boards = statusForTokens(tokens);
  res.json({ online: boards.some((board) => board.connected), boards });
}));

app.post("/mcp/bots/:botId/stop", asyncRoute(async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) {
    return;
  }
  const bot = await getOwnedBot(req.params.botId, user.uid);
  if (!bot) {
    res.sendStatus(404);
    return;
  }
  const tokens = await listTokens({ uid: user.uid, botId: req.params.botId });
  for (const { token } of tokens) {
    disposeBotsForToken(token);
  }
  res.sendStatus(204);
  logInfo("mcp_bot.stop.succeeded", { count: tokens.length });
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

  // botId-scoped tokens are capped by the bot's board allow-list; legacy tokens
  // (no botId) stay account-wide.
  const botDoc = doc.botId ? await getBot(doc.botId) : null;
  if (doc.botId && (!botDoc || botDoc.disabled)) {
    logWarn("mcp.connect.bot_unavailable", {
      botMissing: !botDoc,
      disabled: botDoc?.disabled ?? false,
    });
    res.status(403).json({ error: "bot is disabled or no longer exists" });
    return;
  }

  if (!doc.lastUsedAt || Date.now() - doc.lastUsedAt > 60_000) {
    void touchToken(connectToken);
  }

  const resolveBot = async (boardId: string): Promise<CollabBot> => {
    setLogContext({ boardId });
    const binding = doc.botId ? bindingFor(botDoc, boardId) : undefined;
    const access = await authorize(boardId, account, { asBot: true });
    const decision = decideBotBoardAccess(!!doc.botId, binding, access);
    if (!decision.allowed) {
      logWarn("mcp.board.access_denied", {
        boardId,
        inAllowlist: !doc.botId || !!binding,
        canRead: access.canRead,
      });
      throw new BotAccessDeniedError(boardId);
    }
    const bot = getOrCreateBot(connectToken, {
      uid: account.uid,
      boardId,
      role: decision.role,
      botId: doc.botId,
    });
    await bot.ensureConnected();
    return bot;
  };

  const createBoard = async (input: CreateBoardInput) => {
    const decision = decideBotBoardCreation(!!doc.botId, botDoc);
    if (!decision.allowed) {
      logWarn("mcp.board.create_denied", {
        botScoped: !!doc.botId,
        reason: decision.reason,
      });
      throw new BoardCreationDeniedError(decision.reason);
    }
    // decideBotBoardCreation only allows bot-scoped tokens, so botId is set.
    const botId = doc.botId as string;
    const verdict = boardCreateLimiter.take(botId);
    if (!verdict.allowed) {
      const retryAfterMin = Math.max(1, Math.ceil(verdict.retryAfterMs / 60_000));
      logWarn("mcp.board.create_rate_limited", {
        botId,
        retryAfterMs: verdict.retryAfterMs,
      });
      throw new BoardCreationDeniedError(
        `this bot has hit its limit of ${BOARD_CREATE_LIMIT} new boards per hour; try again in ${retryAfterMin} min or draw on an existing board`,
      );
    }
    const created = await createBoardForBot({
      identity: account,
      botId,
      title: input.title,
      visibility: input.visibility,
    });
    // The bot doc was read at the start of this request, so refresh the
    // in-memory allow-list: a draw call in the same request must not be denied
    // on a board this bot just created.
    if (botDoc) {
      botDoc.boards = [
        ...(botDoc.boards ?? []),
        { boardId: created.boardId, role: "write" },
      ];
    }
    logInfo("mcp.board.created", { boardId: created.boardId, botId });
    return { ...created, url: getBoardUrl(created.boardId) };
  };

  const server = buildMcpServer({
    resolveBot,
    listBoards: () => listAccessibleBoards(account),
    createBoard,
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
