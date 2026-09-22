import {StreamableHTTPServerTransport} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, {type NextFunction, type Request, type RequestHandler, type Response,} from "express";

import {config, getBoardUrl, getMcpUrl} from "./config";
import {authorize, loadBoard} from "./acl";
import {
  createBoardForBot,
  listAccessibleBoards,
  normalizeBoardTitle,
  renameBoardForBot,
  setBoardDescriptionForBot,
} from "./boards";
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
import {
  createFolderForBot,
  decideBotFolderAccess,
  fileBoardInFolder,
  FolderPermissionDeniedError,
  getFolder,
  listFolders,
} from "./folders";
import {buildMcpServer, type CreateBoardInput} from "./mcp";
import {loadBoardScene, loadBoardSummary} from "./scene";
import {type BoardProfile, loadProfile, type ProfileScope, saveProfile} from "./profile";
import {createRateLimiter} from "./rateLimit";
import {getFile, putFile} from "./files";
import {exportRoute, pruneExports} from "./exports";
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

const FOLDER_CREATE_LIMIT = 20;
const FOLDER_CREATE_WINDOW_MS = 60 * 60_000;
const folderCreateLimiter = createRateLimiter({
  limit: FOLDER_CREATE_LIMIT,
  windowMs: FOLDER_CREATE_WINDOW_MS,
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

  const requireFolderAccess = (tool: string) => {
    const decision = decideBotFolderAccess(!!doc.botId, botDoc);
    if (!decision.allowed) {
      logWarn("mcp.folder.denied", {
        tool,
        botScoped: !!doc.botId,
        reason: decision.reason,
      });
      throw new FolderPermissionDeniedError(decision.reason);
    }
  };

  const listBotFolders = async () => {
    requireFolderAccess("list_folders");
    // Folder contents are the owner's private board list: only echo back the
    // boards this bot is already bound to.
    const reachable = new Set(
      (botDoc?.boards ?? []).map((binding) => binding.boardId),
    );
    return (await listFolders(account)).map((folder) => ({
      ...folder,
      boardIds: folder.boardIds.filter((boardId) => reachable.has(boardId)),
    }));
  };

  const createFolder = async (input: { name: string }) => {
    requireFolderAccess("create_folder");
    // decideBotFolderAccess only allows bot-scoped tokens, so botId is set.
    const botId = doc.botId as string;
    const verdict = folderCreateLimiter.take(botId);
    if (!verdict.allowed) {
      const retryAfterMin = Math.max(1, Math.ceil(verdict.retryAfterMs / 60_000));
      logWarn("mcp.folder.create_rate_limited", {
        botId,
        retryAfterMs: verdict.retryAfterMs,
      });
      throw new FolderPermissionDeniedError(
        `this bot has hit its limit of ${FOLDER_CREATE_LIMIT} new folders per hour; try again in ${retryAfterMin} min or reuse a folder from list_folders`,
      );
    }
    const folder = await createFolderForBot({
      identity: account,
      botId,
      name: input.name,
    });
    logInfo("mcp.folder.created", {
      folderId: folder.folderId,
      botId,
      reused: !folder.created,
    });
    return folder;
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
    // Resolve the target folder before anything is written: a bad folderId or a
    // missing folder permission must not leave a stray board behind.
    let targetFolder: Awaited<ReturnType<typeof getFolder>> = null;
    if (input.folderId) {
      requireFolderAccess("create_board");
      targetFolder = await getFolder(account, input.folderId);
      if (!targetFolder) {
        throw new FolderPermissionDeniedError(
          `folder "${input.folderId}" does not exist on this account; pick an id from list_folders or make one with create_folder`,
        );
      }
    }
    // decideBotBoardCreation only allows bot-scoped tokens, so botId is set.
    const botId = doc.botId as string;
    if (input.dryRun) {
      const quota = boardCreateLimiter.peek(botId);
      return {
        dryRun: true,
        allowed: quota.used < quota.limit,
        quota: {
          limit: quota.limit,
          used: quota.used,
          resetAt: quota.resetAt ? new Date(quota.resetAt).toISOString() : null,
        },
        ...(targetFolder ? { folder: { folderId: targetFolder.folderId, name: targetFolder.name } } : {}),
      };
    }
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
      description: input.description,
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
    const result = { ...created, url: getBoardUrl(created.boardId) };
    if (!targetFolder) {
      return result;
    }
    // The board exists and is usable either way; a failed filing is reported
    // next to it rather than thrown, so the agent does not retry create_board
    // and end up with a duplicate.
    try {
      await fileBoardInFolder(account, targetFolder.folderId, created.boardId);
      return {
        ...result,
        folder: { folderId: targetFolder.folderId, name: targetFolder.name },
      };
    } catch (error) {
      logError("mcp.board.folder_filing_failed", error, {
        boardId: created.boardId,
        folderId: targetFolder.folderId,
      });
      return {
        ...result,
        folder: null,
        folderWarning:
          "the board was created but could not be filed into the folder; do not call create_board again — the owner can move it on the home page",
      };
    }
  };

  const setBoardDescription = async (input: {
    boardId: string;
    description: string;
  }) => {
    setLogContext({ boardId: input.boardId });
    // Same allow-list the drawing tools go through, without opening a
    // collab connection: this only touches the board document.
    return setBoardDescriptionForBot({
      identity: account,
      boardId: input.boardId,
      description: input.description,
      isFirstClass: !!doc.botId,
      binding: doc.botId ? bindingFor(botDoc, input.boardId) : undefined,
    });
  };

  const renameBoard = async (input: { boardId: string; title: string }) => {
    setLogContext({ boardId: input.boardId });
    return renameBoardForBot({
      identity: account,
      boardId: input.boardId,
      title: input.title,
      isFirstClass: !!doc.botId,
      binding: doc.botId ? bindingFor(botDoc, input.boardId) : undefined,
    });
  };

  const moveBoardToFolder = async (input: {
    boardId: string;
    folderId: string | null;
  }) => {
    requireFolderAccess("move_board_to_folder");
    setLogContext({ boardId: input.boardId });
    // Only boards this bot can already reach may be (re)filed; read access is
    // enough, since folders never change who can open a board.
    const access = await authorize(input.boardId, account, { asBot: true });
    const decision = decideBotBoardAccess(
      !!doc.botId,
      bindingFor(botDoc, input.boardId),
      access,
    );
    if (!decision.allowed) {
      logWarn("mcp.board.access_denied", {
        boardId: input.boardId,
        tool: "move_board_to_folder",
        canRead: access.canRead,
      });
      throw new BotAccessDeniedError(input.boardId);
    }
    const folderId = input.folderId || null;
    const target = folderId ? await getFolder(account, folderId) : null;
    if (folderId && !target) {
      throw new FolderPermissionDeniedError(
        `folder "${folderId}" does not exist on this account; pick an id from list_folders or make one with create_folder`,
      );
    }
    await fileBoardInFolder(account, folderId, input.boardId);
    const board = await loadBoard(input.boardId);
    logInfo("mcp.board.moved_to_folder", {
      boardId: input.boardId,
      folderId: folderId ?? undefined,
    });
    return {
      boardId: input.boardId,
      title: normalizeBoardTitle(board?.title),
      folder: target ? { folderId: target.folderId, name: target.name } : null,
    };
  };

  const listBoards = async (
    input: { folderId?: string; query?: string; details?: boolean } = {},
  ) => {
    let boards = (await listAccessibleBoards(account)).map((board) => {
      const url = getBoardUrl(board.boardId);
      return url ? { ...board, url } : board;
    });
    // Folder names are the owner's private organization: only bots allowed to
    // work with folders get to see which folder holds each board.
    if (decideBotFolderAccess(!!doc.botId, botDoc).allowed) {
      try {
        const folders = await listFolders(account);
        const folderOf = new Map<string, { folderId: string; name: string }>();
        for (const folder of folders) {
          for (const boardId of folder.boardIds) {
            folderOf.set(boardId, { folderId: folder.folderId, name: folder.name });
          }
        }
        boards = boards.map((board) => {
          const folder = folderOf.get(board.boardId);
          return folder ? { ...board, folder } : board;
        });
      } catch (error) {
        // The board list is what the agent needs; folders are a bonus.
        logError("mcp.list_boards.folders_failed", error);
      }
    } else if (input.folderId) {
      requireFolderAccess("list_boards");
    }
    if (input.folderId) {
      boards = boards.filter((board) => board.folder?.folderId === input.folderId);
    }
    if (input.query) {
      const needle = input.query.toLowerCase();
      boards = boards.filter((board) =>
        `${board.title} ${board.description ?? ""}`.toLowerCase().includes(needle),
      );
    }
    if (!input.details) {
      return boards;
    }
    return Promise.all(
      boards.map(async (board) => {
        // Contents are only read for boards this bot is bound to — the same
        // allow-list the drawing tools enforce.
        if (doc.botId && !bindingFor(botDoc, board.boardId)) {
          return board;
        }
        try {
          return { ...board, ...(await boardDetails(board.boardId)) };
        } catch (error) {
          logWarn("mcp.list_boards.details_failed", {
            boardId: board.boardId,
            error: error instanceof Error ? error.message : String(error),
          });
          return board;
        }
      }),
    );
  };

  const boardDetails = (boardId: string) => loadBoardSummary(boardId);

  // A board inherits the style profile of the folder it sits in, so the
  // lookup needs that folder — resolved once per request.
  let folderOfBoard: Promise<Map<string, string>> | null = null;
  const folderIdFor = async (boardId: string): Promise<string | undefined> => {
    if (!decideBotFolderAccess(!!doc.botId, botDoc).allowed) {
      return undefined;
    }
    if (!folderOfBoard) {
      folderOfBoard = listFolders(account)
        .then((folders) => {
          const map = new Map<string, string>();
          for (const folder of folders) {
            for (const id of folder.boardIds) {
              map.set(id, folder.folderId);
            }
          }
          return map;
        })
        .catch(() => new Map<string, string>());
    }
    return (await folderOfBoard).get(boardId);
  };

  const loadBoardProfile = async (boardId: string): Promise<BoardProfile | null> =>
    loadProfile({ boardId, folderId: await folderIdFor(boardId) });

  const saveBoardProfile = async (scope: ProfileScope, profile: BoardProfile) => {
    if (scope.folderId) {
      requireFolderAccess("set_board_profile");
      const folder = await getFolder(account, scope.folderId);
      if (!folder) {
        throw new FolderPermissionDeniedError(
          `folder "${scope.folderId}" does not exist on this account; pick an id from list_folders`,
        );
      }
    }
    if (scope.boardId) {
      // Changing how a board looks is a write to that board.
      await resolveBot(scope.boardId);
    }
    return saveProfile(scope, profile);
  };

  // Same access decision as resolveBot, but reads the stored scene instead of
  // joining the board's room — for queries across many boards.
  const readBoardSnapshot = async (boardId: string) => {
    const binding = doc.botId ? bindingFor(botDoc, boardId) : undefined;
    const access = await authorize(boardId, account, { asBot: true });
    if (!decideBotBoardAccess(!!doc.botId, binding, access).allowed) {
      throw new BotAccessDeniedError(boardId);
    }
    return (await loadBoardScene(boardId)).filter((element) => !element.isDeleted);
  };

  const folderBoardIds = async (folderId: string): Promise<string[]> => {
    requireFolderAccess("folder scope");
    const folder = await getFolder(account, folderId);
    if (!folder) {
      throw new FolderPermissionDeniedError(
        `folder "${folderId}" does not exist on this account; pick an id from list_folders`,
      );
    }
    const reachable = new Set((await listAccessibleBoards(account)).map((board) => board.boardId));
    return folder.boardIds.filter(
      (boardId) => reachable.has(boardId) && (!doc.botId || !!bindingFor(botDoc, boardId)),
    );
  };

  const getBotInfo = async () => {
    const botId = doc.botId ?? null;
    const quota = (limiter: typeof boardCreateLimiter) => {
      const window = botId ? limiter.peek(botId) : { limit: 0, used: 0, resetAt: null };
      return {
        limit: window.limit,
        used: window.used,
        resetAt: window.resetAt ? new Date(window.resetAt).toISOString() : null,
      };
    };
    return {
      botId,
      permissions: {
        createBoards: decideBotBoardCreation(!!doc.botId, botDoc).allowed,
        createFolders: decideBotFolderAccess(!!doc.botId, botDoc).allowed,
      },
      ...(botDoc ? { boards: (botDoc.boards ?? []).map((binding) => ({ boardId: binding.boardId, access: binding.role })) } : {}),
      quotas: {
        boardsPerHour: quota(boardCreateLimiter),
        foldersPerHour: quota(folderCreateLimiter),
      },
    };
  };

  const server = buildMcpServer({
    resolveBot,
    listBoards,
    getBotInfo,
    folderBoardIds,
    readBoardSnapshot,
    loadBoardProfile,
    saveBoardProfile,
    createBoard,
    setBoardDescription,
    renameBoard,
    listFolders: listBotFolders,
    createFolder,
    moveBoardToFolder,
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

// The token in the path is the only credential: an export link is meant to be
// pasted into a doc. It carries its own expiry and signature (src/exports.ts).
app.get("/exports/:token", exportRoute);

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

const EXPORT_PRUNE_INTERVAL_MS = 60 * 60_000;

app.listen(config.port, () => {
  void pruneExports().catch(() => undefined);
  setInterval(() => {
    void pruneExports().catch(() => undefined);
  }, EXPORT_PRUNE_INTERVAL_MS).unref();
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
