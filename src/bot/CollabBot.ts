import {randomUUID} from "crypto";

import {io, type Socket} from "socket.io-client";

import {auth, db} from "../firebase";
import {getBot} from "../bots";
import {
  encodeBinaryFile,
  fileIdForBytes,
  parseUploadData,
  writeRoomFile,
} from "../binaryFiles";
import {decryptJSON, encryptJSON} from "../encryption";
import {
  appendSceneHistory,
  appendSceneLogEntry,
  getSceneVersion,
  listSceneHistory,
  getSceneLogEntry,
  listSceneLog,
  loadScene,
  loadSceneHistoryEntry,
  loadSceneLogBefore,
  persistScene,
  type PersistOutcome,
  type SceneHistoryEntry,
  type SceneLogEntry,
  type SceneLogInput,
  type SceneLogOp,
} from "../scene";
import {applyUpdate, bottomFractionalIndex, planReorder, type ReorderPlacement,} from "../elements";
import {type ConflictKind, decideIncoming} from "../reconcile";
import {
  type ArrangeOptions,
  arrangePositions,
  asText,
  type Bounds,
  type DiagramInput,
  elementAtPoint,
  getCommonBounds,
  getElementBounds,
  type LintScopeOptions,
  lintScene,
  planDiagram,
  type RenderOptions,
  type RenderResult,
  renderSvg,
  svgToPngBase64,
} from "../verify";
import type {Target} from "../toolSchemas";
import type {Anchor, RouteKind} from "../engine/arrows";
import {putNewElement} from "../engine/common";
import {createItems, type CreateContext, type CreateItem, type OnExisting} from "../engine/create";
import {invalidArgs, notFound} from "../engine/errors";
import {CORE_REPAIR_CODES, deleteTargets, repairCore, restoreFrom} from "../engine/lifecycle";
import {planRepairs, REPAIRABLE_CODES} from "../verify/repair";
import {canonicalLintCode} from "../verify/lintProfiles";
import {type Carry, moveElements} from "../engine/move";
import {createStack, type CreateStackInput} from "../engine/stack";
import {type QueryOptions, type QueryResult, runQuery} from "../engine/query";
import {pushBelow, reflowAfterGrowth, type ReflowOptions} from "../engine/reflow";
import {hasConditions, resolveTarget} from "../engine/selector";
import type {SceneTxn} from "../engine/txn";
import {fitFrameToChildren, type Patch, updateItems} from "../engine/update";
import {checkExpected, type ExpectedScene} from "../engine/expected";
import {type FrameLayoutOptions, layoutFrames} from "../engine/frames";
import {patchFromItem, upsertItems} from "../engine/upsert";
import {buildEnvelope, type ChangeSummary, type Envelope, planWrite, type WriteOptions} from "../engine/write";
import {type BoardProfile, resolveProfile} from "../profile";
import {
  type ComposePlan,
  type LegendInput,
  planBadge,
  planCallout,
  planCodeCard,
  planLegend,
  planTable,
  type TablePlan,
  type TableSpecInput,
} from "../compose";
import {currentRequestId, logError, logInfo, logWarn, opaqueRef, safeUrl,} from "../logger";
import {config, getBoardUrl} from "../config";

import type {ExcalidrawElement, Role} from "../types";

const WS_SUBTYPE_INIT = "SCENE_INIT";
const WS_SUBTYPE_UPDATE = "SCENE_UPDATE";
const WS_SUBTYPE_MOUSE_LOCATION = "MOUSE_LOCATION";
const ID_TOKEN_TTL_MS = 50 * 60 * 1000;
const CURSOR_STEPS = 6;
const CURSOR_STEP_DELAY_MS = 45;

type Broadcast = {
  type: typeof WS_SUBTYPE_INIT | typeof WS_SUBTYPE_UPDATE;
  payload: { elements: ExcalidrawElement[] };
};

type CursorFrame = {
  type: typeof WS_SUBTYPE_MOUSE_LOCATION;
  payload: {
    socketId: string;
    pointer: { x: number; y: number; tool: "pointer" };
    button: "up" | "down";
    selectedElementIds: Record<string, true>;
    username: string;
    avatarUrl: string | null;
    color: { background: string; stroke: string } | null;
  };
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const elementCenter = (element: ExcalidrawElement): { x: number; y: number } => ({
  x: element.x + (element.width || 0) / 2,
  y: element.y + (element.height || 0) / 2,
});

export type BotIdentity = {
  uid: string;
  boardId: string;
  role: Role;
  botId?: string;
};

export type ConflictRecord = {
  id: string;
  kind: ConflictKind;
  resurrections: number;
  sceneVersion: number;
};

export type WriteCallOptions = WriteOptions;

const COMPOSITE_TYPES = new Set(["code", "callout", "badge"]);

// batch_create {type:"code"|"callout"|"badge"} → the composite planner.
const planComposite = (
  item: CreateItem,
  live: readonly ExcalidrawElement[],
  profile?: BoardProfile | null,
): ComposePlan => {
  const raw = item as Record<string, unknown>;
  if (typeof raw.id !== "string" || !raw.id) {
    throw invalidArgs(`a ${item.type} needs an id (its parts get ids derived from it)`, { field: "id" });
  }
  try {
    switch (item.type) {
      case "code":
        return planCodeCard(
          {
            id: raw.id,
            x: Number(raw.x ?? 0),
            y: Number(raw.y ?? 0),
            code: String(raw.code ?? raw.text ?? ""),
            title: raw.title as string | undefined,
            source: raw.source as string | undefined,
            fontSize: raw.fontSize as number | undefined,
            width: raw.width as number | "auto" | undefined,
            frameId: raw.frameId as string | undefined,
          },
          live,
          profile,
        );
      case "callout":
        return planCallout(
          {
            id: raw.id,
            anchorId: String(raw.anchorId ?? ""),
            text: String(raw.text ?? raw.label ?? ""),
            side: raw.side as "auto" | "top" | "right" | "bottom" | "left" | undefined,
            maxDistance: raw.maxDistance as number | undefined,
            role: raw.role as string | undefined,
            frameId: raw.frameId as string | undefined,
          },
          live,
          profile,
        );
      default:
        return planBadge(
          {
            id: raw.id,
            anchorId: String(raw.anchorId ?? ""),
            text: String(raw.text ?? raw.label ?? ""),
            corner: raw.corner as "top-left" | "top-right" | "bottom-left" | "bottom-right" | undefined,
            role: raw.role as string | undefined,
          },
          live,
        );
    }
  } catch (error) {
    throw invalidArgs(error instanceof Error ? error.message : String(error));
  }
};

export class ReadOnlyError extends Error {
  constructor() {
    super("read-only access");
    this.name = "ReadOnlyError";
  }
}

export class BotAccessDeniedError extends Error {
  constructor(boardId: string) {
    super(`access denied to board ${boardId}`);
    this.name = "BotAccessDeniedError";
  }
}

export class CollabBot {
  private readonly uid: string;
  private readonly boardId: string;
  private readonly role: Role;
  private readonly botId?: string;

  private roomKey = "";
  private idToken = "";
  private idTokenExpiresAt = 0;
  private displayName = "";
  private presenceColor: string | null = null;
  private presenceEmoji = "🤖";
  private lastActiveAt = 0;

  private socket: Socket | null = null;
  private accessDenied = false;
  private connecting: Promise<void> | null = null;

  private elements = new Map<string, ExcalidrawElement>();
  private lastPointer = { x: 0, y: 0 };

  private static readonly MAX_WRITE_LOG = 1000;
  // Bigger commits skip the "before" snapshot rather than push a Firestore doc
  // toward its 1 MiB limit; the entry itself is still written.
  private static readonly MAX_JOURNAL_SNAPSHOT = 400;
  private static readonly MAX_RESURRECTIONS = 3;
  // Re-assertion only defends a freshly bot-written element for this long. After
  // it, an incoming deletion/overwrite is the human's deliberate edit and wins.
  private static readonly RESURRECTION_WINDOW_MS = 12_000;
  private writeLog: Array<{
    id: string;
    origin: "bot" | "incoming";
    sceneVersionAfter: number;
    updated: number;
  }> = [];
  private writeLogEvicted = false;

  // Sticky ownership of bot-created ids (survives human echoes): snapshots feed
  // re-assertion, botDeletedIds stops the bot resisting its own deletions,
  // ownedAssertedAt bounds re-assertion to a grace window after the last write.
  private ownedIds = new Set<string>();
  private ownedSnapshots = new Map<string, ExcalidrawElement>();
  private ownedAssertedAt = new Map<string, number>();
  private botDeletedIds = new Set<string>();
  private resurrections = new Map<string, number>();
  private conflicts = new Map<string, ConflictRecord>();
  // Every commit and resurrection flush runs through this queue, one at a
  // time, so a persist never snapshots another write half-way through.
  private persistQueue: Promise<void> = Promise.resolve();
  // Ids that some planned-but-not-yet-persisted write (re)creates: every
  // persist must lift them above stored tombstones, whichever write's
  // snapshot happens to carry them to the store first.
  private pendingForceWin = new Map<string, number>();
  // The board's style profile (typeScale, spacing, role meanings, nowrap). The
  // MCP layer sets it per request; writes and lint use it unless a call passes
  // its own.
  private profile: BoardProfile | null = null;

  useProfile(profile: BoardProfile | null): void {
    this.profile = profile;
  }

  // The profile a call should use: what it passed, else the board's.
  private profileFor(options: { boardProfile?: BoardProfile | null }): BoardProfile | null {
    return options.boardProfile ?? this.profile;
  }

  constructor(identity: BotIdentity) {
    this.uid = identity.uid;
    this.boardId = identity.boardId;
    this.role = identity.role;
    this.botId = identity.botId;
  }

  matches(identity: BotIdentity): boolean {
    return (
      this.uid === identity.uid &&
      this.boardId === identity.boardId &&
      this.role === identity.role
    );
  }

  private get authorLabel(): string {
    return `Бот ${this.displayName || this.uid}`;
  }

  private get presenceName(): string {
    return `${this.presenceEmoji} ${this.displayName || "Bot"}`;
  }

  private async showActivity(
    targets: ExcalidrawElement[],
    select: boolean,
  ): Promise<void> {
    if (!this.socket?.connected || !targets.length) {
      return;
    }
    const focus = elementCenter(targets[targets.length - 1]);
    const selectedElementIds: Record<string, true> = {};
    if (select) {
      for (const target of targets) {
        selectedElementIds[target.id] = true;
      }
    }
    const from = this.lastPointer;
    for (let step = 1; step <= CURSOR_STEPS; step++) {
      const progress = step / CURSOR_STEPS;
      await this.emitCursor(
        {
          x: from.x + (focus.x - from.x) * progress,
          y: from.y + (focus.y - from.y) * progress,
        },
        step === CURSOR_STEPS ? selectedElementIds : {},
      );
      await sleep(CURSOR_STEP_DELAY_MS);
    }
    this.lastPointer = focus;
  }

  // The room socket server authenticates with a Firebase ID token. The Admin
  // SDK can only mint a *custom* token for a uid, so we exchange it for an ID
  // token via Identity Toolkit so the room server resolves the bot AS the user

  async ensureConnected(): Promise<void> {
    this.lastActiveAt = Date.now();
    if (this.accessDenied) {
      logWarn("collab.connection.previously_denied", {
        boardId: this.boardId,
      });
      throw new BotAccessDeniedError(this.boardId);
    }
    if (this.socket?.connected) {
      logInfo("collab.connection.reused", {
        boardId: this.boardId,
        socketId: this.socket.id,
      });
      return;
    }
    if (this.connecting) {
      logInfo("collab.connection.awaiting_inflight", {
        boardId: this.boardId,
      });
      return this.connecting;
    }
    this.connecting = this.connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async emitCursor(
    pointer: { x: number; y: number },
    selectedElementIds: Record<string, true>,
  ): Promise<void> {
    const socket = this.socket;
    if (!socket?.connected || !socket.id) {
      return;
    }
    const frame: CursorFrame = {
      type: WS_SUBTYPE_MOUSE_LOCATION,
      payload: {
        socketId: socket.id,
        pointer: { x: pointer.x, y: pointer.y, tool: "pointer" },
        button: "up",
        selectedElementIds,
        username: this.presenceName,
        avatarUrl: null,
        color: this.presenceColor
          ? { background: this.presenceColor, stroke: this.presenceColor }
          : null,
      },
    };
    try {
      const { ciphertext, iv } = await encryptJSON(this.roomKey, frame);
      socket.emit(
        "server-volatile-broadcast",
        this.boardId,
        ciphertext.buffer.slice(
          ciphertext.byteOffset,
          ciphertext.byteOffset + ciphertext.byteLength,
        ),
        iv,
      );
    } catch (error) {
      logWarn("collab.presence.emit_failed", {
        boardId: this.boardId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async loadBoardContext(): Promise<void> {
    const keySnap = await (async () => {
      try {
        logInfo("firestore.board_key.load_started", { boardId: this.boardId });
        return await db().collection("boardKeys").doc(this.boardId).get();
      } catch (error) {
        logError("firestore.board_key.load_failed", error, {
          boardId: this.boardId,
        });
        throw error;
      }
    })();
    const roomKey = keySnap.exists
      ? (keySnap.data() as { roomKey?: string }).roomKey
      : undefined;
    if (!roomKey) {
      const error = new Error(`missing roomKey for board ${this.boardId}`);
      logError("firestore.board_key.missing", error, {
        boardId: this.boardId,
        documentExists: keySnap.exists,
      });
      throw error;
    }
    this.roomKey = roomKey;
    logInfo("firestore.board_key.loaded", { boardId: this.boardId });

    try {
      const user = await auth().getUser(this.uid);
      this.displayName = user.displayName ?? user.email ?? this.uid;
      logInfo("firebase.bot_user.loaded", {
        boardId: this.boardId,
        subjectRef: opaqueRef(this.uid),
      });
    } catch (error) {
      logWarn("firebase.bot_user.load_failed_using_uid", {
        boardId: this.boardId,
        subjectRef: opaqueRef(this.uid),
        error:
          error instanceof Error
            ? { name: error.name, message: error.message }
            : String(error),
      });
      this.displayName = this.uid;
    }

    await this.loadBotPresence();
  }

  private async initElements(): Promise<void> {
    try {
      logInfo("collab.scene_initialization.started", {
        boardId: this.boardId,
      });
      const stored = await loadScene(this.boardId, this.roomKey);
      this.elements.clear();
      for (const element of stored ?? []) {
        this.elements.set(element.id, element);
      }
      logInfo("collab.scene_initialization.succeeded", {
        boardId: this.boardId,
        elementCount: this.elements.size,
      });
      void this.logReload();
    } catch (error) {
      logError("collab.scene_initialization.failed", error, {
        boardId: this.boardId,
      });
      throw error;
    }
  }

  private async handleClientBroadcast(
    encryptedData: ArrayBuffer | Uint8Array,
    iv: Uint8Array,
  ): Promise<void> {
    try {
      const bytes =
        encryptedData instanceof Uint8Array
          ? encryptedData
          : new Uint8Array(encryptedData);
      const decoded = await decryptJSON<Broadcast>(this.roomKey, bytes, iv);
      if (
        decoded?.type === WS_SUBTYPE_INIT ||
        decoded?.type === WS_SUBTYPE_UPDATE
      ) {
        this.reconcileIncoming(decoded.payload?.elements ?? []);
      }
    } catch {
      // volatile cursor frames share client-broadcast and don't parse as scene updates
    }
  }

  runtimeStatus(): BotBoardRuntimeStatus {
    return {
      boardId: this.boardId,
      connected: this.socket?.connected === true,
      lastActiveAt: this.lastActiveAt || null,
    };
  }

  // and its own ACL enforces read-only.
  private async mintIdToken(): Promise<string> {
    if (this.idToken && Date.now() < this.idTokenExpiresAt) {
      logInfo("firebase.bot_id_token.cache_hit", {
        boardId: this.boardId,
        subjectRef: opaqueRef(this.uid),
      });
      return this.idToken;
    }
    let customToken: string;
    try {
      logInfo("firebase.custom_token.create_started", {
        boardId: this.boardId,
        subjectRef: opaqueRef(this.uid),
      });
      customToken = await auth().createCustomToken(this.uid, {
        bot: true,
        ...(this.botId ? { botId: this.botId } : {}),
      });
      logInfo("firebase.custom_token.created", {
        boardId: this.boardId,
        subjectRef: opaqueRef(this.uid),
      });
    } catch (error) {
      logError("firebase.custom_token.create_failed", error, {
        boardId: this.boardId,
        subjectRef: opaqueRef(this.uid),
      });
      throw error;
    }

    const exchangeUrl =
      "https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken";
    let response: Response;
    try {
      logInfo("firebase.id_token.exchange_started", {
        boardId: this.boardId,
        endpoint: exchangeUrl,
      });
      response = await fetch(`${exchangeUrl}?key=${config.firebaseWebApiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: customToken, returnSecureToken: true }),
      });
    } catch (error) {
      logError("firebase.id_token.exchange_network_failed", error, {
        boardId: this.boardId,
        endpoint: exchangeUrl,
      });
      throw error;
    }
    if (!response.ok) {
      const responseText = await response.text().catch(() => "");
      const error = new Error(
        `custom token exchange failed: ${response.status} ${response.statusText}`,
      );
      logError("firebase.id_token.exchange_rejected", error, {
        boardId: this.boardId,
        endpoint: exchangeUrl,
        responseStatus: response.status,
        responseBody: responseText.slice(0, 1000),
      });
      throw error;
    }
    let data: { idToken?: string };
    try {
      data = (await response.json()) as { idToken?: string };
    } catch (error) {
      logError("firebase.id_token.exchange_invalid_json", error, {
        boardId: this.boardId,
        endpoint: exchangeUrl,
      });
      throw error;
    }
    if (!data.idToken) {
      const error = new Error("custom token exchange returned no idToken");
      logError("firebase.id_token.exchange_missing_token", error, {
        boardId: this.boardId,
        endpoint: exchangeUrl,
      });
      throw error;
    }
    this.idToken = data.idToken;
    this.idTokenExpiresAt = Date.now() + ID_TOKEN_TTL_MS;
    logInfo("firebase.id_token.exchange_succeeded", {
      boardId: this.boardId,
      expiresInMs: ID_TOKEN_TTL_MS,
    });
    return this.idToken;
  }

  private sceneCentroid(): { x: number; y: number } {
    let sumX = 0;
    let sumY = 0;
    let count = 0;
    for (const element of this.elements.values()) {
      if (element.isDeleted) {
        continue;
      }
      const center = elementCenter(element);
      sumX += center.x;
      sumY += center.y;
      count += 1;
    }
    return count ? { x: sumX / count, y: sumY / count } : { x: 0, y: 0 };
  }

  private async broadcastUpdate(changed: ExcalidrawElement[]): Promise<void> {
    if (!this.socket?.connected) {
      logWarn("collab.broadcast.skipped_disconnected", {
        boardId: this.boardId,
        changedCount: changed.length,
      });
      return;
    }
    const data: Broadcast = {
      type: WS_SUBTYPE_UPDATE,
      payload: { elements: changed },
    };
    const { ciphertext, iv } = await encryptJSON(this.roomKey, data);
    this.socket.emit(
      "server-broadcast",
      this.boardId,
      ciphertext.buffer.slice(
        ciphertext.byteOffset,
        ciphertext.byteOffset + ciphertext.byteLength,
      ),
      iv,
    );
    logInfo("collab.broadcast.sent", {
      boardId: this.boardId,
      changedCount: changed.length,
      socketId: this.socket.id,
    });
  }

  private async loadBotPresence(): Promise<void> {
    if (!this.botId) {
      return;
    }
    try {
      const bot = await getBot(this.botId);
      if (!bot) {
        return;
      }
      if (bot.name?.trim()) {
        this.displayName = bot.name.trim();
      }
      if (typeof bot.color === "string" && bot.color.trim()) {
        this.presenceColor = bot.color.trim();
      }
      const emoji = (bot.avatar as { value?: string } | undefined)?.value;
      if (typeof emoji === "string" && emoji.trim()) {
        this.presenceEmoji = emoji.trim();
      }
    } catch (error) {
      logWarn("firestore.bot.presence_load_failed", {
        boardId: this.boardId,
        botId: this.botId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private requireEditor(): void {
    if (this.role !== "editor") {
      throw new ReadOnlyError();
    }
  }

  async uploadFile(input: {
    data: string;
    mimeType?: string;
  }): Promise<{ fileId: string; size: number; mimeType: string; reused: boolean }> {
    this.requireEditor();
    await this.ensureConnected();
    const { bytes, mimeType } = parseUploadData(input.data, input.mimeType);
    const fileId = fileIdForBytes(bytes);
    const now = Date.now();
    const dataURL = `data:${mimeType};base64,${bytes.toString("base64")}`;
    const encoded = await encodeBinaryFile(
      dataURL,
      { id: fileId, mimeType, created: now, lastRetrieved: now },
      this.roomKey,
    );
    const { reused } = await writeRoomFile(this.boardId, fileId, encoded);
    return { fileId, size: bytes.length, mimeType, reused };
  }

  async sceneDiff(sinceVersion?: number): Promise<{
    sceneVersion: number;
    since: number | null;
    truncated: boolean;
    changes: Array<{
      id: string;
      type: string;
      origin: "bot" | "incoming";
      owned: boolean;
      version: number;
      status: "present" | "deleted";
    }>;
    byOrigin: { bot: string[]; incoming: string[] };
    owned: string[];
    conflicts: ConflictRecord[];
  }> {
    await this.ensureConnected();
    const sceneVersion = this.currentSceneVersion();
    const oldestLogged = this.writeLog.length
      ? this.writeLog[0].sceneVersionAfter
      : sceneVersion;
    const truncated =
      sinceVersion !== undefined &&
      this.writeLogEvicted &&
      sinceVersion < oldestLogged;
    const latestById = new Map<string, "bot" | "incoming">();
    if (sinceVersion === undefined || truncated) {
      for (const element of this.liveElements()) {
        latestById.set(element.id, this.lastOrigin(element.id));
      }
    } else {
      for (const entry of this.writeLog) {
        if (entry.sceneVersionAfter > sinceVersion) {
          latestById.set(entry.id, entry.origin);
        }
      }
    }
    const changes: Array<{
      id: string;
      type: string;
      origin: "bot" | "incoming";
      owned: boolean;
      version: number;
      status: "present" | "deleted";
    }> = [];
    // Keyed on who created the element, not the last writer, so bot elements
    // stay in `bot` after a human edits them.
    const byOrigin = { bot: [] as string[], incoming: [] as string[] };
    for (const [id, origin] of latestById) {
      const element = this.elements.get(id);
      if (!element) {
        continue;
      }
      const owned = this.ownedIds.has(id);
      changes.push({
        id,
        type: element.type,
        origin,
        owned,
        version: element.version,
        status: element.isDeleted ? "deleted" : "present",
      });
      (owned ? byOrigin.bot : byOrigin.incoming).push(id);
    }
    return {
      sceneVersion,
      since: sinceVersion ?? null,
      truncated,
      changes,
      byOrigin,
      owned: [...this.ownedIds],
      conflicts: [...this.conflicts.values()],
    };
  }

  // ---- the write pipeline -------------------------------------------------

  // Every write goes through here: plan in a SceneTxn against the current
  // scene, lint what it touched (before/after), and — unless it is a dry run —
  // commit in one broadcast + persist + history entry.
  private async write<T>(
    options: WriteCallOptions,
    fn: (txn: SceneTxn) => T,
  ): Promise<Envelope & { result: T }> {
    this.requireEditor();
    await this.ensureConnected();
    const prevSceneVersion = this.currentSceneVersion();
    if (options.boardProfile === undefined && this.profile) {
      options = { ...options, boardProfile: this.profile };
    }
    const planned = planWrite(this.elements, options, fn);
    if (options.dryRun || !planned.txn.hasChanges()) {
      return {
        ...buildEnvelope(planned, {
          sceneVersion: prevSceneVersion,
          prevSceneVersion,
          dryRun: options.dryRun,
          returnElements: options.returnElements,
        }),
        result: planned.result,
      };
    }
    const changed = planned.txn.changed();
    const report = planned.txn.report;
    // Copies as they are *before* this write lands in the live map (the
    // transaction reads through to that map, so this cannot wait).
    const beforeCopies = changed
      .map((element) => planned.txn.original(element.id))
      .filter((element): element is ExcalidrawElement => !!element);
    this.holdForceWin(report.forceWin);
    for (const element of changed) {
      this.elements.set(element.id, element);
    }
    this.claimOwnership(changed.filter((element) => report.forceWin.has(element.id)));
    const live = changed.filter((element) => !element.isDeleted);
    const journal = await this.journalEntry(planned.summary, changed, beforeCopies, prevSceneVersion, options.note);
    journal.historyEntryId = randomUUID();
    let committed: { commitId?: string; outcome: PersistOutcome | null };
    try {
      committed = await this.enqueue(() =>
        this.commit(changed, live.length ? { targets: live, select: true } : undefined, journal),
      );
    } finally {
      this.releaseForceWin(report.forceWin);
    }
    // Report what is really live now: the persist may have lifted a revived
    // element's version further, or a stored copy may have won.
    const final = changed.map((element) => this.elements.get(element.id) ?? element);
    this.recordWrites(final, "bot");
    return {
      ...buildEnvelope(planned, {
        sceneVersion: this.currentSceneVersion(),
        prevSceneVersion,
        commitId: journal.commitId,
        persisted: this.persistedFor(changed, committed.outcome),
        conflicts: this.conflictsFor(changed.map((element) => element.id)),
        returnElements: options.returnElements,
        finalElements: final,
      }),
      result: planned.result,
    };
  }

  // One journal entry per commit: what changed, by whom, and an encrypted copy
  // of the affected elements as they were before — that is what makes a revert
  // possible long after the 24 h tombstones are gone.
  private async journalEntry(
    summary: ChangeSummary,
    changed: ExcalidrawElement[],
    previous: ExcalidrawElement[],
    sceneVersionBefore: number,
    note?: string,
  ): Promise<SceneLogInput> {
    const { created, updated, deleted, revived } = summary;
    const counts = {
      created: created.length,
      updated: updated.length,
      deleted: deleted.length,
      revived: revived.length,
    };
    const ops: SceneLogOp[] = [];
    if (counts.created) ops.push("create");
    if (counts.updated) ops.push("update");
    if (counts.deleted) ops.push("delete");
    if (counts.revived) ops.push("revive");
    const entry: SceneLogInput = {
      commitId: randomUUID(),
      op: ops.length === 1 ? ops[0] : "mixed",
      ids: changed.map((element) => element.id),
      counts,
      sceneVersionBefore,
      actor: {
        kind: "bot",
        ...(this.botId ? { botId: this.botId } : {}),
        uid: this.uid,
        ...(note ? { note } : {}),
      },
    };
    if (previous.length > CollabBot.MAX_JOURNAL_SNAPSHOT) {
      return { ...entry, beforeOmitted: true };
    }
    try {
      const { ciphertext, iv } = await encryptJSON(this.roomKey, previous);
      return { ...entry, before: { ciphertext, iv, count: previous.length } };
    } catch (error) {
      logWarn("collab.journal.snapshot_failed", {
        boardId: this.boardId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { ...entry, beforeOmitted: true };
    }
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.persistQueue.then(task);
    this.persistQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private holdForceWin(ids: Iterable<string>): void {
    for (const id of ids) {
      this.pendingForceWin.set(id, (this.pendingForceWin.get(id) ?? 0) + 1);
    }
  }

  private releaseForceWin(ids: Iterable<string>): void {
    for (const id of ids) {
      const count = (this.pendingForceWin.get(id) ?? 1) - 1;
      if (count > 0) this.pendingForceWin.set(id, count);
      else this.pendingForceWin.delete(id);
    }
  }

  private persistedFor(
    changed: ExcalidrawElement[],
    outcome: PersistOutcome | null,
  ): Envelope["persisted"] {
    if (!outcome) {
      return undefined;
    }
    const ours = new Map(changed.map((element) => [element.id, element] as const));
    const lost = outcome.storedWins
      .filter((stored) => ours.has(stored.id) && !this.pendingForceWin.has(stored.id))
      .map((stored) => ({
        id: stored.id,
        storedVersion: stored.version,
        localVersion: ours.get(stored.id)!.version,
      }));
    if (lost.length) {
      return { ok: false, lost };
    }
    // A creation that had to be lifted above a stored tombstone is saved, but
    // under a higher version than the plan said: report the version to use.
    const lifted = outcome.bumped
      .filter((element) => ours.has(element.id))
      .map((element) => ({ id: element.id, version: element.version }));
    return lifted.length ? { ok: true, lifted } : { ok: true };
  }

  // Runs inside the persist queue (see enqueue).
  private async commit(
    changed: ExcalidrawElement[],
    activity: { targets: ExcalidrawElement[]; select: boolean } | undefined,
    journal?: SceneLogInput,
  ): Promise<{ commitId?: string; outcome: PersistOutcome | null }> {
    await this.broadcastUpdate(changed);
    // Emit the cursor before the Firestore writes so presence doesn't trail the persist latency.
    if (activity) {
      await this.showActivity(activity.targets, activity.select);
    }
    const outcome = await persistScene(
      this.boardId,
      this.roomKey,
      [...this.elements.values()],
      { reviveIds: new Set(this.pendingForceWin.keys()), ...(journal ? { log: journal } : {}) },
    );
    await this.adoptPersistOutcome(outcome);
    // History is recorded independently: a history failure must not lose the
    // user-visible change (already broadcast + persisted), but must be loud.
    let commitId: string | undefined;
    try {
      commitId = await appendSceneHistory({
        roomId: this.boardId,
        roomKey: this.roomKey,
        author: this.authorLabel,
        elements: [...this.elements.values()],
        ...(journal?.historyEntryId ? { entryId: journal.historyEntryId } : {}),
      });
    } catch (error) {
      logError("collab.commit.history_failed", error, {
        boardId: this.boardId,
        changedCount: changed.length,
      });
    }
    logInfo("collab.commit.succeeded", {
      boardId: this.boardId,
      changedCount: changed.length,
      totalCount: this.elements.size,
    });
    return { commitId, outcome };
  }

  // The store is the truth: a stored copy that beat ours replaces ours in
  // memory (so reads never show what a reload would lose), and a creation
  // lifted above a stored tombstone is re-broadcast at its final version.
  private async adoptPersistOutcome(outcome: PersistOutcome): Promise<void> {
    for (const stored of outcome.storedWins) {
      // A revival still in flight is lifted by its own persist; do not let
      // someone else's snapshot turn it back into the stored tombstone.
      if (this.pendingForceWin.has(stored.id)) {
        continue;
      }
      const mine = this.elements.get(stored.id);
      if (!mine || mine.version < stored.version) {
        this.elements.set(stored.id, stored);
      }
    }
    if (outcome.bumped.length) {
      const lifted: ExcalidrawElement[] = [];
      for (const element of outcome.bumped) {
        const mine = this.elements.get(element.id);
        if (!mine || mine.version < element.version) {
          this.elements.set(element.id, element);
          lifted.push(element);
        }
      }
      if (lifted.length) {
        this.recordWrites(lifted, "bot");
        await this.broadcastUpdate(lifted);
        logWarn("collab.persist.revived_over_stored_tombstone", {
          boardId: this.boardId,
          ids: lifted.map((element) => element.id),
        });
      }
    }
  }

  private linkFor = (boardId: string, frameId?: string): string | undefined => {
    const url = getBoardUrl(boardId);
    return url && frameId ? `${url}?element=${encodeURIComponent(frameId)}` : url;
  };

  private createContext(onExisting?: OnExisting, profile?: BoardProfile | null): CreateContext {
    const nowrap = profile ? resolveProfile(profile).nowrap : [];
    return {
      onExisting,
      linkFor: this.linkFor,
      ...(nowrap.length ? { nowrap } : {}),
      replace: (txn, id, item) => {
        const current = txn.live(id);
        if (!current) {
          return;
        }
        const patch = patchFromItem(current, item, txn);
        if (patch) {
          updateItems(txn, [patch], { linkFor: this.linkFor });
        }
      },
    };
  }

  private targetsIn(txn: SceneTxn, target: Target | undefined, ids?: string[]): ExcalidrawElement[] {
    if (hasConditions(target)) {
      return resolveTarget(txn.liveElements(), target as Target);
    }
    if (ids?.length) {
      return resolveTarget(txn.liveElements(), { ids });
    }
    return [];
  }

  async createElements(
    items: CreateItem[],
    options: WriteCallOptions & { onExisting?: OnExisting } = {},
  ): Promise<Envelope & { result: { ids: string[] } }> {
    return this.write(options, (txn) => {
      const plain = items.filter((item) => !COMPOSITE_TYPES.has(item.type));
      const composites = items.filter((item) => COMPOSITE_TYPES.has(item.type));
      const ids = plain.length
        ? createItems(txn, plain, this.createContext(options.onExisting, this.profileFor(options))).ids
        : [];
      // Code cards, callouts and badges expand into plain elements; they come
      // after the plain items so they can point at shapes created here.
      for (const item of composites) {
        const plan = planComposite(item, txn.liveElements(), this.profileFor(options));
        for (const warning of plan.warnings ?? []) {
          txn.report.warnings.push(`${String(item.id)}: ${warning}`);
        }
        const result = upsertItems(txn, plan.items as CreateItem[], {
          removeIds: plan.removeIds,
          context: this.createContext("replace"),
        });
        if (plan.extraPatches?.length) {
          updateItems(txn, plan.extraPatches.map((entry) => ({ ...entry.patch, id: entry.id })));
        }
        ids.push(...result.created, ...result.updated);
      }
      return { ids };
    });
  }

  async setTable(
    input: { tableId: string; spec: TableSpecInput; frameId?: string },
    options: WriteCallOptions & { reflow?: ReflowOptions } = {},
  ): Promise<
    Envelope & {
      result: {
        cells: Record<string, Record<string, string>>;
        bounds: { x: number; y: number; width: number; height: number };
        diff: { added: string[]; updated: string[]; removed: string[] };
      };
    }
  > {
    return this.write(options, (txn) => {
      let plan: TablePlan;
      try {
        plan = planTable(input, txn.liveElements(), this.profileFor(options));
      } catch (error) {
        throw invalidArgs(error instanceof Error ? error.message : String(error));
      }
      const root = txn.live(input.tableId);
      const result = upsertItems(txn, plan.items as CreateItem[], {
        removeIds: plan.removeIds,
        context: this.createContext("replace"),
      });
      if (plan.previousBounds) {
        pushBelow(
          txn,
          plan.previousBounds,
          plan.bounds,
          new Set(plan.items.map((item) => item.id)),
          options.reflow ?? { push: "below", growFrame: true },
          root?.frameId ?? input.frameId ?? null,
        );
      }
      return {
        cells: plan.cells,
        bounds: plan.bounds,
        diff: { added: result.created, updated: result.updated, removed: result.removed },
      };
    });
  }

  async setLegend(
    input: LegendInput,
    options: WriteCallOptions = {},
  ): Promise<Envelope & { result: { bounds: { x: number; y: number; width: number; height: number }; ids: string[] } }> {
    return this.write(options, (txn) => {
      let plan: ComposePlan;
      try {
        plan = planLegend(input, txn.liveElements(), this.profileFor(options));
      } catch (error) {
        throw invalidArgs(error instanceof Error ? error.message : String(error));
      }
      const result = upsertItems(txn, plan.items as CreateItem[], {
        removeIds: plan.removeIds,
        context: this.createContext("replace"),
      });
      return { bounds: plan.bounds, ids: [...result.created, ...result.updated] };
    });
  }

  async updateElements(
    patches: Patch[],
    options: WriteCallOptions & {
      reflow?: ReflowOptions;
      target?: Target;
      patch?: Record<string, unknown>;
    } = {},
  ): Promise<Envelope & { result: { updated: string[] } }> {
    return this.write(options, (txn) => {
      let all = patches;
      if (options.patch && hasConditions(options.target)) {
        const targets = resolveTarget(txn.liveElements(), options.target as Target);
        all = [...patches, ...targets.map((element) => ({ ...options.patch, id: element.id }))];
      }
      const before = new Map<string, ExcalidrawElement>();
      for (const patch of all) {
        const element = txn.live(String(patch.id));
        if (element) before.set(element.id, element);
      }
      const result = updateItems(txn, all, { linkFor: this.linkFor, strict: options.strict });
      if (options.reflow) {
        reflowAfterGrowth(txn, before, options.reflow);
      }
      return result;
    });
  }

  async moveElements(
    target: Target,
    dx: number,
    dy: number,
    carry: Carry | undefined,
    options: WriteCallOptions = {},
  ): Promise<Envelope & { result: { moved: string[]; rerouted: string[] } }> {
    return this.write(options, (txn) => {
      const targets = resolveTarget(txn.liveElements(), target);
      if (!targets.length) {
        throw notFound("target matched no elements");
      }
      return moveElements(txn, targets, dx, dy, carry);
    });
  }

  async deleteElements(
    selector: { ids?: string[]; groupId?: string; target?: Target; force?: boolean },
    options: WriteCallOptions = {},
  ): Promise<Envelope & { result: { deleted: string[]; detached: string[]; skippedProtected: string[] } }> {
    return this.write(options, (txn) => {
      const target: Target = {
        ...(selector.target ?? {}),
        ...(selector.groupId ? { groupId: selector.groupId } : {}),
        ...(selector.ids?.length ? { ids: selector.ids } : {}),
      };
      const targets = hasConditions(target) ? resolveTarget(txn.liveElements(), target) : [];
      return deleteTargets(txn, targets, { force: selector.force, note: options.note });
    });
  }

  async createDiagram(
    input: DiagramInput,
    options: WriteCallOptions = {},
  ): Promise<
    Envelope & {
      result: { ids: string[] };
      nodes: Record<string, string>;
      edges: string[];
      groups: Record<string, string>;
      bounds: { x: number; y: number; width: number; height: number };
    }
  > {
    const plan = await planDiagram(input);
    const envelope = await this.write(options, (txn) => {
      if (!input.diagramId) {
        return createItems(txn, plan.items, this.createContext("revive", this.profile));
      }
      // Re-running a diagramId re-lays out the same elements in place.
      const planned = new Set(plan.items.map((item) => item.id as string));
      const stale = txn
        .liveElements()
        .filter(
          (element) =>
            (element.customData as { diagramId?: unknown } | undefined)?.diagramId === input.diagramId &&
            !planned.has(element.id) &&
            !(element.type === "text" && typeof asText(element).containerId === "string"),
        )
        .map((element) => element.id);
      const upserted = upsertItems(txn, plan.items, {
        removeIds: stale,
        context: this.createContext("replace"),
      });
      return { ids: [...upserted.created, ...upserted.updated] };
    });
    return {
      ...envelope,
      nodes: plan.nodeElementIds,
      edges: plan.edgeElementIds,
      groups: plan.groupElementIds,
      bounds: plan.bounds,
    };
  }

  async createFrame(
    opts: {
      id?: string;
      x?: number;
      y?: number;
      width?: number;
      height?: number;
      name?: string;
      childIds?: string[];
      padding?: number;
      titleGap?: number;
      kind?: string;
    },
    options: WriteCallOptions = {},
  ): Promise<Envelope & { result: { frameId: string; children: string[] } }> {
    return this.write(options, (txn) => {
      const children = opts.childIds ? resolveTarget(txn.liveElements(), { ids: opts.childIds }) : [];
      let bounds: Bounds;
      if (
        typeof opts.x === "number" &&
        typeof opts.y === "number" &&
        typeof opts.width === "number" &&
        typeof opts.height === "number"
      ) {
        bounds = [opts.x, opts.y, opts.x + opts.width, opts.y + opts.height];
      } else if (children.length) {
        const [x1, y1, x2, y2] = getCommonBounds(children);
        const pad = opts.padding ?? 24;
        const titleGap = opts.titleGap ?? 0;
        bounds = [x1 - pad, y1 - pad - titleGap, x2 + pad, y2 + pad];
      } else {
        throw invalidArgs("create_frame needs explicit x/y/width/height or childIds");
      }
      const frame = putNewElement(txn, {
        ...(opts.id ? { id: opts.id } : {}),
        type: "frame",
        x: bounds[0],
        y: bounds[1],
        width: bounds[2] - bounds[0],
        height: bounds[3] - bounds[1],
        name: opts.name ?? null,
        backgroundColor: "transparent",
        index: bottomFractionalIndex(txn.all()),
        ...(opts.kind ? { customData: { kind: opts.kind } } : {}),
      });
      const moved = this.putIntoFrame(txn, frame.id, children.map((child) => child.id));
      return { frameId: frame.id, children: moved };
    });
  }

  // Set frameId on the children and on their labels (a label always shares
  // its container's frame).
  private putIntoFrame(txn: SceneTxn, frameId: string, childIds: string[]): string[] {
    const ids = new Set(childIds);
    for (const element of txn.liveElements()) {
      const containerId = asText(element).containerId;
      if (typeof containerId === "string" && ids.has(containerId)) {
        ids.add(element.id);
      }
    }
    const moved: string[] = [];
    for (const id of ids) {
      const current = txn.live(id);
      if (!current || current.id === frameId || current.frameId === frameId) {
        continue;
      }
      txn.put(applyUpdate(current, { frameId }));
      moved.push(id);
    }
    return moved;
  }

  async frameAddChildren(
    frameId: string,
    childIds: string[],
    opts: { refit?: boolean; padding?: number; titleGap?: number } = {},
    options: WriteCallOptions = {},
  ): Promise<Envelope & { result: { frame: string; children: string[] } }> {
    return this.write(options, (txn) => {
      const frame = txn.live(frameId);
      if (!frame || frame.type !== "frame") {
        throw notFound(`frame not found: ${frameId}`, [frameId]);
      }
      const children = this.putIntoFrame(
        txn,
        frameId,
        resolveTarget(txn.liveElements(), { ids: childIds }).map((element) => element.id),
      );
      if (opts.refit) {
        fitFrameToChildren(txn, frameId, { padding: opts.padding, titleGap: opts.titleGap, shrink: false });
      }
      return { frame: frameId, children };
    });
  }

  async reorder(
    ids: string[],
    placement: ReorderPlacement,
    options: WriteCallOptions = {},
  ): Promise<Envelope & { result: { reordered: string[] } }> {
    return this.write(options, (txn) => {
      const changed = planReorder(txn.all(), ids, placement);
      for (const element of changed) {
        txn.put(element);
      }
      return { reordered: changed.map((element) => element.id) };
    });
  }

  async bringToFront(ids: string[], options: WriteCallOptions = {}) {
    return this.reorder(ids, { to: "front" }, options);
  }

  async sendToBack(ids: string[], options: WriteCallOptions = {}) {
    return this.reorder(ids, { to: "back" }, options);
  }

  async groupElements(
    ids: string[],
    options: WriteCallOptions = {},
  ): Promise<Envelope & { result: { groupId: string; updated: string[] } }> {
    return this.write(options, (txn) => {
      const targets = resolveTarget(txn.liveElements(), { ids });
      if (targets.length < 2) {
        throw invalidArgs("need at least two existing elements to group");
      }
      const groupId = randomUUID();
      const { updated } = updateItems(
        txn,
        targets.map((element) => ({ id: element.id, groupIds: [...(element.groupIds ?? []), groupId] })),
      );
      return { groupId, updated };
    });
  }

  async ungroupElements(
    selector: { ids?: string[]; groupId?: string },
    options: WriteCallOptions = {},
  ): Promise<Envelope & { result: { updated: string[] } }> {
    return this.write(options, (txn) => {
      const targets = selector.groupId
        ? resolveTarget(txn.liveElements(), { groupId: selector.groupId })
        : resolveTarget(txn.liveElements(), { ids: selector.ids ?? [] });
      return updateItems(
        txn,
        targets
          .filter((element) => !(element.type === "text" && typeof asText(element).containerId === "string"))
          .map((element) => ({
            id: element.id,
            groupIds: selector.groupId
              ? (element.groupIds ?? []).filter((g) => g !== selector.groupId)
              : (element.groupIds ?? []).slice(0, -1),
          })),
      );
    });
  }

  async connectElements(
    fromId: string,
    toId: string,
    options: {
      mode?: "inside" | "orbit" | "skip";
      startArrowhead?: string | null;
      endArrowhead?: string | null;
      waypoints?: [number, number][];
      route?: RouteKind;
      startAnchor?: Anchor;
      endAnchor?: Anchor;
      label?: string;
    } = {},
    writeOptions: WriteCallOptions = {},
  ): Promise<Envelope & { result: { ids: string[] } }> {
    return this.write(writeOptions, (txn) =>
      createItems(txn, [
        {
          type: "arrow",
          fromId,
          toId,
          bindMode: options.mode,
          startArrowhead: options.startArrowhead,
          endArrowhead: options.endArrowhead,
          waypoints: options.waypoints,
          route: options.route,
          startAnchor: options.startAnchor,
          endAnchor: options.endAnchor,
          ...(options.label !== undefined ? { label: options.label } : {}),
        },
      ]),
    );
  }

  async arrange(
    ids: string[],
    arrangeOptions: ArrangeOptions,
    options: WriteCallOptions = {},
  ): Promise<Envelope & { result: { moved: string[] } }> {
    return this.write(options, (txn) => {
      const targets = resolveTarget(txn.liveElements(), { ids }).filter(
        (element) => !(element.type === "text" && typeof asText(element).containerId === "string"),
      );
      if (!targets.length) {
        throw notFound("no matching elements to arrange", ids);
      }
      const positions = arrangePositions(targets, arrangeOptions);
      const moved: string[] = [];
      for (const target of targets) {
        const next = positions.get(target.id);
        const current = txn.live(target.id);
        if (!next || !current) continue;
        const [minX, minY] = getElementBounds(current);
        const dx = next[0] - minX;
        const dy = next[1] - minY;
        if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) continue;
        // Moving through move_elements keeps labels and arrows attached.
        moved.push(...moveElements(txn, [current], dx, dy).moved);
      }
      return { moved };
    });
  }

  async restore(
    ids: string[],
    from: string | undefined,
    options: WriteCallOptions & { mode?: "restore" | "revert" } = {},
  ): Promise<Envelope & { result: { restored: string[]; missing: string[]; removed?: string[] } }> {
    const commit = from && from !== "tombstone" ? await this.commitSource(from) : null;
    const source = commit?.before ?? null;
    const mode = options.mode ?? "restore";
    const wanted = ids.length ? ids : (commit?.touched ?? []);
    return this.write(options, (txn) => {
      const result = restoreFrom(txn, wanted, (id) => {
        if (source) {
          return source.get(id);
        }
        const element = txn.get(id);
        return element?.isDeleted ? element : undefined;
      });
      if (mode !== "revert" || !source) {
        return result;
      }
      // Undoing a commit also means removing what that commit created: ids it
      // touched that had no previous copy.
      const created = wanted.filter((id) => !source.has(id) && txn.live(id));
      const removed = created.length
        ? deleteTargets(
            txn,
            created.map((id) => txn.live(id)!),
            { force: true },
          ).deleted
        : [];
      return { ...result, ...(removed.length ? { removed } : {}) };
    });
  }

  // A commit id from board_log: the journal's pre-commit copies when it kept
  // them (plus every id that commit touched, so a revert can also remove what
  // it created), otherwise the shared history snapshot of that entry.
  private async commitSource(
    commitId: string,
  ): Promise<{ before: Map<string, ExcalidrawElement>; touched: string[] }> {
    await this.ensureConnected();
    const entry = await getSceneLogEntry(this.boardId, commitId).catch(() => null);
    const before = await loadSceneLogBefore(this.boardId, this.roomKey, commitId).catch(() => null);
    if (before) {
      return {
        before: new Map(before.map((element) => [element.id, element] as const)),
        touched: entry?.ids ?? before.map((element) => element.id),
      };
    }
    if (entry && !entry.hasBefore && !entry.historyEntryId) {
      throw notFound(
        `commit ${commitId} kept no snapshot (it was too large); restore the ids you need from a neighbouring commit`,
      );
    }
    const snapshot = await this.historySnapshot(entry?.historyEntryId ?? commitId);
    return { before: snapshot, touched: entry?.ids ?? [...snapshot.keys()] };
  }

  private async historySnapshot(entryId: string): Promise<Map<string, ExcalidrawElement>> {
    await this.ensureConnected();
    const elements = await loadSceneHistoryEntry(this.boardId, this.roomKey, entryId);
    if (!elements) {
      throw notFound(`history entry ${entryId} not found (it may have been trimmed); list entries with board_log`);
    }
    return new Map(elements.map((element) => [element.id, element] as const));
  }

  async boardLog(
    opts: {
      limit?: number;
      ids?: string[];
      ops?: string[];
      since?: number;
      sinceVersion?: number;
      includeGeometry?: boolean;
    } = {},
  ): Promise<{
    entries: Array<Record<string, unknown>>;
    tombstones: Array<{ id: string; type: string; deletedAt: number; textPreview?: string }>;
    owned: string[];
    conflicts: ConflictRecord[];
    sceneVersion: number;
  }> {
    await this.ensureConnected();
    const limit = Math.min(Math.max(1, opts.limit ?? 20), 100);
    const journal = await listSceneLog(this.boardId, {
      limit,
      since: opts.since,
      ids: opts.ids,
      ops: opts.ops,
    }).catch((error) => {
      logWarn("collab.board_log.journal_failed", {
        boardId: this.boardId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [] as SceneLogEntry[];
    });
    const filtered = opts.sinceVersion
      ? journal.filter((entry) => entry.sceneVersionAfter > (opts.sinceVersion as number))
      : journal;
    const entries: Array<Record<string, unknown>> = [];
    for (const entry of filtered) {
      const row: Record<string, unknown> = {
        commitId: entry.commitId,
        at: new Date(entry.ts).toISOString(),
        op: entry.op,
        by: entry.actor.botId ? `bot:${entry.actor.botId}` : entry.actor.kind,
        ...(entry.actor.note ? { note: entry.actor.note } : {}),
        ids: entry.ids.slice(0, 40),
        counts: entry.counts,
        sceneVersion: entry.sceneVersionAfter,
        restorable: entry.hasBefore,
      };
      if (opts.includeGeometry && entry.hasBefore) {
        const before = await loadSceneLogBefore(this.boardId, this.roomKey, entry.commitId).catch(() => null);
        if (before) {
          const wanted = opts.ids?.length ? new Set(opts.ids) : null;
          row.before = before
            .filter((element) => !wanted || wanted.has(element.id))
            .map((element) => ({
              id: element.id,
              type: element.type,
              x: Math.round(element.x),
              y: Math.round(element.y),
              width: Math.round(element.width || 0),
              height: Math.round(element.height || 0),
              isDeleted: element.isDeleted,
              version: element.version,
            }));
        }
      }
      entries.push(row);
    }
    // The shared history also records what people did in the browser, which
    // the bot's own journal never sees.
    const seen = new Set(filtered.map((entry) => entry.historyEntryId).filter(Boolean));
    const history = await listSceneHistory(this.boardId).catch(() => [] as SceneHistoryEntry[]);
    for (const entry of history.slice(0, limit)) {
      if (seen.has(entry.id) || filtered.some((row) => Math.abs(row.ts - entry.createdAt) < 1500)) {
        continue;
      }
      entries.push({
        commitId: entry.id,
        at: new Date(entry.createdAt).toISOString(),
        op: "snapshot",
        by: entry.author ?? "unknown",
        sceneVersion: entry.sceneVersion,
        source: "history",
        restorable: true,
      });
    }
    entries.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    const wanted = opts.ids?.length ? new Set(opts.ids) : null;
    const tombstones = [...this.elements.values()]
      .filter((element) => element.isDeleted && (!wanted || wanted.has(element.id)))
      .sort((a, b) => b.updated - a.updated)
      .slice(0, 50)
      .map((element) => {
        const text = asText(element).text;
        return {
          id: element.id,
          type: element.type,
          deletedAt: element.updated,
          ...(typeof text === "string" && text.trim()
            ? { textPreview: text.replace(/\s+/g, " ").slice(0, 40) }
            : {}),
        };
      });
    return {
      entries: entries.slice(0, limit),
      tombstones,
      owned: [...this.ownedIds],
      conflicts: [...this.conflicts.values()],
      sceneVersion: this.currentSceneVersion(),
    };
  }

  // A `reload` marker so a gap in the journal reads as "the process restarted
  // here" instead of "nothing happened".
  private async logReload(): Promise<void> {
    try {
      await appendSceneLogEntry(this.boardId, {
        commitId: randomUUID(),
        op: "reload",
        ids: [],
        counts: { created: 0, updated: 0, deleted: 0, revived: 0 },
        sceneVersionBefore: 0,
        sceneVersionAfter: this.currentSceneVersion(),
        actor: { kind: "system", ...(this.botId ? { botId: this.botId } : {}), uid: this.uid },
      });
    } catch (error) {
      logWarn("collab.journal.reload_failed", {
        boardId: this.boardId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async repairScene(
    codes: string[],
    target: Target | undefined,
    options: WriteCallOptions = {},
  ): Promise<Envelope & { result: { applied: Array<{ code: string; id: string }>; unknownCodes?: string[] } }> {
    return this.write({ ...options, dryRun: options.dryRun ?? true }, (txn) => {
      const scope = hasConditions(target)
        ? resolveTarget(txn.liveElements(), target as Target).map((element) => element.id)
        : undefined;
      const wanted = new Set(codes.map(canonicalLintCode));
      const repairable = new Set<string>([...REPAIRABLE_CODES, ...CORE_REPAIR_CODES]);
      const unknownCodes = [...wanted].filter((code) => !repairable.has(code));
      const applied: Array<{ code: string; id: string }> = [];
      // Data fixes first (they are computed on the whole scene, tombstones
      // included, and each one on top of the previous), then geometry.
      const patches = planRepairs(txn.all(), { codes: [...wanted], ids: scope });
      for (const { code, id, patch } of patches) {
        const current = txn.live(id);
        if (!current) continue;
        txn.put(applyUpdate(current, patch as Partial<ExcalidrawElement>));
        applied.push({ code, id });
      }
      applied.push(
        ...repairCore(
          txn,
          wanted,
          scope ?? txn.liveElements().map((element) => element.id),
        ),
      );
      return { applied, ...(unknownCodes.length ? { unknownCodes } : {}) };
    });
  }

  async upsertComposite(
    plan: { items: CreateItem[]; removeIds: string[]; extraPatches?: Array<{ id: string; patch: Record<string, unknown> }> },
    options: WriteCallOptions & { reflow?: ReflowOptions; previousBounds?: { x: number; y: number; width: number; height: number }; bounds?: { x: number; y: number; width: number; height: number } } = {},
  ): Promise<Envelope & { result: { created: string[]; updated: string[]; removed: string[] } }> {
    return this.write(options, (txn) => {
      const result = upsertItems(txn, plan.items, {
        removeIds: plan.removeIds,
        context: this.createContext("replace"),
      });
      if (plan.extraPatches?.length) {
        updateItems(txn, plan.extraPatches.map((entry) => ({ ...entry.patch, id: entry.id })));
      }
      if (options.reflow && options.previousBounds && options.bounds) {
        pushBelow(txn, options.previousBounds, options.bounds, new Set(plan.items.map((item) => item.id as string)), options.reflow);
      }
      return result;
    });
  }

  // ---- reads -------------------------------------------------------------

  async describeScene(): Promise<ExcalidrawElement[]> {
    await this.ensureConnected();
    return this.liveElements();
  }

  async loadStored(): Promise<ExcalidrawElement[]> {
    await this.ensureConnected();
    return (await loadScene(this.boardId, this.roomKey)) ?? [];
  }

  async queryElements(
    input: QueryOptions & { target?: Target; source?: "memory" | "stored" },
  ): Promise<QueryResult & { sceneVersion: number; source?: "stored" }> {
    await this.ensureConnected();
    const stored = input.source === "stored";
    const scene = stored
      ? (await this.loadStored()).filter((element) => !element.isDeleted)
      : this.liveElements();
    const selected = hasConditions(input.target) ? resolveTarget(scene, input.target as Target) : scene;
    const result = runQuery(scene, selected, input);
    return {
      ...result,
      sceneVersion: stored ? getSceneVersion(scene) : this.currentSceneVersion(),
      ...(stored ? { source: "stored" as const } : {}),
    };
  }

  async validateScene(
    options: LintScopeOptions & {
      target?: Target;
      checkPersisted?: boolean;
      expected?: ExpectedScene;
    },
  ): Promise<ReturnType<typeof lintScene> & { sceneVersion: number }> {
    await this.ensureConnected();
    const { target, checkPersisted, expected, ...lintOptions } = options;
    const live = this.liveElements();
    const ids = hasConditions(target)
      ? resolveTarget(live, target as Target).map((element) => element.id)
      : lintOptions.ids;
    const stored =
      checkPersisted === false ? undefined : await this.loadStored().catch(() => undefined);
    const result = lintScene(live, {
      ...lintOptions,
      ...(ids ? { ids } : {}),
      ...(stored ? { stored } : {}),
      ...(this.profile ? { boardProfile: this.profile } : {}),
    });
    if (expected) {
      const extra = checkExpected(this.elements, expected);
      result.findings.push(...(lintOptions.summaryOnly ? [] : extra));
      for (const finding of extra) {
        if (finding.severity === "error") result.summary.errors++;
        else if (finding.severity === "warning") result.summary.warnings++;
        else result.summary.infos++;
      }
    }
    return { ...result, sceneVersion: this.currentSceneVersion() };
  }

  async createStack(
    input: CreateStackInput,
    options: WriteCallOptions = {},
  ): Promise<Envelope & { result: { stackId: string; members: string[] } }> {
    return this.write(options, (txn) => createStack(txn, input));
  }

  // The elements a copy needs: the selection itself, plus the labels and
  // frame children planCopy pulls in.
  liveSnapshot(): ExcalidrawElement[] {
    return this.liveElements();
  }

  async copyInto(
    items: CreateItem[],
    options: WriteCallOptions = {},
  ): Promise<Envelope & { result: { ids: string[] } }> {
    return this.write(options, (txn) => createItems(txn, items, this.createContext("revive", this.profileFor(options))));
  }

  async applyOps(
    ops: Array<Record<string, unknown>>,
    options: WriteCallOptions = {},
  ): Promise<Envelope & { result: { applied: Array<{ op: string; ids: string[] }> } }> {
    // Anything that needs a read (a restore source) is fetched before the
    // transaction, so the ops themselves run without an await between them.
    const sources = new Map<string, Map<string, ExcalidrawElement>>();
    for (const op of ops) {
      if (op.op === "restore" && typeof op.from === "string" && op.from !== "tombstone") {
        sources.set(op.from, (await this.commitSource(op.from)).before);
      }
    }
    return this.write(options, (txn) => {
      const applied: Array<{ op: string; ids: string[] }> = [];
      for (const op of ops) {
        const kind = String(op.op);
        switch (kind) {
          case "create": {
            const result = createItems(txn, (op.elements ?? []) as CreateItem[], this.createContext(op.onExisting as OnExisting, this.profileFor(options)));
            applied.push({ op: kind, ids: result.ids });
            break;
          }
          case "update": {
            const result = updateItems(txn, (op.elements ?? []) as Patch[], { linkFor: this.linkFor });
            applied.push({ op: kind, ids: result.updated });
            break;
          }
          case "delete": {
            const target: Target = {
              ...((op.target as Target) ?? {}),
              ...(Array.isArray(op.ids) ? { ids: op.ids as string[] } : {}),
            };
            const targets = hasConditions(target) ? resolveTarget(txn.liveElements(), target) : [];
            applied.push({ op: kind, ids: deleteTargets(txn, targets, { force: !!op.force }).deleted });
            break;
          }
          case "move": {
            const targets = resolveTarget(txn.liveElements(), (op.target as Target) ?? {});
            const result = moveElements(txn, targets, Number(op.dx ?? 0), Number(op.dy ?? 0), op.carry as Carry);
            applied.push({ op: kind, ids: result.moved });
            break;
          }
          case "restore": {
            const source = typeof op.from === "string" ? sources.get(op.from) : undefined;
            const result = restoreFrom(txn, (op.ids ?? []) as string[], (id) => {
              if (source) return source.get(id);
              const element = txn.get(id);
              return element?.isDeleted ? element : undefined;
            });
            applied.push({ op: kind, ids: result.restored });
            break;
          }
          default:
            throw invalidArgs(`unknown op "${kind}"; use create, update, delete, move or restore`, {
              field: "op",
            });
        }
      }
      return { applied };
    });
  }

  async layoutFrames(
    input: FrameLayoutOptions,
    options: WriteCallOptions = {},
  ): Promise<Envelope & { result: { moved: string[] } }> {
    return this.write(options, (txn) => layoutFrames(txn, input));
  }

  async render(
    options: RenderOptions & { format?: "png" | "svg"; groupId?: string; target?: Target },
  ): Promise<{
    format: "png" | "svg";
    png?: string;
    svg?: string;
    tiles?: Array<{ region: Bounds; png?: string; svg?: string; width: number; height: number }>;
    transform: RenderResult["transform"];
    legend?: RenderResult["legend"];
    legendOrder: RenderResult["legendOrder"];
    fidelity: RenderResult["fidelity"];
    readability: RenderResult["readability"];
    sheet?: RenderResult["sheet"];
    width: number;
    height: number;
    sceneVersion: number;
  }> {
    await this.ensureConnected();
    const live = this.liveElements();
    let ids = options.ids;
    let region = options.region;
    if (options.groupId) {
      ids = resolveTarget(live, { groupId: options.groupId }).map((element) => element.id);
    }
    if (hasConditions(options.target)) {
      const matched = resolveTarget(live, options.target as Target);
      if (!matched.length) {
        throw notFound("render target matched no elements");
      }
      region = getCommonBounds(matched);
      ids = undefined;
    }
    const rendered: RenderResult = renderSvg([...this.elements.values()], {
      ...options,
      ids,
      region,
      legend: options.legend ?? "none",
    });
    const wantPng = options.format !== "svg";
    const png = wantPng ? svgToPngBase64(rendered.svg) : null;
    const tiles = rendered.tiles?.map((tile) => {
      const tilePng = wantPng ? svgToPngBase64(tile.svg) : null;
      return {
        region: tile.region,
        width: tile.width,
        height: tile.height,
        ...(tilePng ? { png: tilePng } : { svg: tile.svg }),
      };
    });
    return {
      format: png ? "png" : "svg",
      ...(png ? { png } : { svg: rendered.svg }),
      ...(tiles ? { tiles } : {}),
      transform: rendered.transform,
      ...(rendered.legend !== undefined ? { legend: rendered.legend } : {}),
      legendOrder: rendered.legendOrder,
      fidelity: rendered.fidelity,
      readability: rendered.readability,
      ...(rendered.sheet ? { sheet: rendered.sheet } : {}),
      width: rendered.width,
      height: rendered.height,
      sceneVersion: this.currentSceneVersion(),
    };
  }

  async getBounds(ids?: string[]): Promise<{
    bounds: Bounds;
    width: number;
    height: number;
    elements: string[];
  }> {
    await this.ensureConnected();
    const live = this.liveElements();
    const targets = ids && ids.length ? resolveTarget(live, { ids }) : live;
    const bounds = getCommonBounds(targets);
    return {
      bounds,
      width: bounds[2] - bounds[0],
      height: bounds[3] - bounds[1],
      elements: targets.map((element) => element.id),
    };
  }

  async elementAt(x: number, y: number): Promise<ExcalidrawElement | null> {
    await this.ensureConnected();
    return elementAtPoint([...this.elements.values()], x, y);
  }

  private reconcileIncoming(elements: ExcalidrawElement[]): void {
    const accepted: ExcalidrawElement[] = [];
    const resurrected: ExcalidrawElement[] = [];
    for (const incoming of elements) {
      const id = incoming.id;
      const assertedAt = this.ownedAssertedAt.get(id) ?? 0;
      const decision = decideIncoming({
        incoming,
        current: this.elements.get(id),
        isOwned: this.ownedIds.has(id),
        botDeleted: this.botDeletedIds.has(id),
        resurrectCount: this.resurrections.get(id) ?? 0,
        maxResurrections: CollabBot.MAX_RESURRECTIONS,
        resurrectable: Date.now() - assertedAt < CollabBot.RESURRECTION_WINDOW_MS,
        snapshot: this.ownedSnapshots.get(id),
      });
      switch (decision.action) {
        case "ignore":
          break;
        case "accept":
          this.elements.set(id, incoming);
          accepted.push(incoming);
          break;
        case "accept_conflict":
          this.elements.set(id, incoming);
          // A human edit means the element is alive again: track their geometry
          // as the snapshot and reset the fight count. The grace window is not
          // re-armed, so a deletion made after it still yields to the human.
          this.ownedSnapshots.set(id, incoming);
          this.resurrections.delete(id);
          accepted.push(incoming);
          this.recordConflict(id, decision.kind);
          break;
        case "resurrect":
          this.elements.set(id, decision.element);
          this.ownedSnapshots.set(id, decision.element);
          this.resurrections.set(id, (this.resurrections.get(id) ?? 0) + 1);
          this.recordConflict(id, "resurrected");
          resurrected.push(decision.element);
          break;
        case "yield":
          this.elements.set(id, incoming);
          accepted.push(incoming);
          this.ownedIds.delete(id);
          this.ownedAssertedAt.delete(id);
          this.recordConflict(id, "yielded");
          break;
      }
    }
    if (accepted.length) {
      this.recordWrites(accepted, "incoming");
    }
    if (resurrected.length) {
      // Record synchronously, while `resurrected` still matches in-memory state:
      // the async flush could otherwise roll snapshots back behind a concurrent
      // tool commit. A re-assertion is not a genuine write, so it must not push
      // the grace window forward (that is measured from the last real bot write).
      this.recordWrites(resurrected, "bot", { touchAssertedAt: false });
      logWarn("collab.reconcile.resurrected_owned_elements", {
        boardId: this.boardId,
        ids: resurrected.map((element) => element.id),
      });
      this.scheduleResurrectionFlush(resurrected);
    }
  }

  private claimOwnership(elements: ExcalidrawElement[]): void {
    const now = Date.now();
    for (const element of elements) {
      this.ownedIds.add(element.id);
      this.botDeletedIds.delete(element.id);
      this.resurrections.delete(element.id);
      if (!element.isDeleted) {
        this.ownedSnapshots.set(element.id, element);
        this.ownedAssertedAt.set(element.id, now);
      }
    }
  }

  private recordConflict(id: string, kind: ConflictKind): void {
    this.conflicts.set(id, {
      id,
      kind,
      resurrections: this.resurrections.get(id) ?? 0,
      sceneVersion: this.currentSceneVersion(),
    });
  }

  private conflictsFor(ids: string[]): ConflictRecord[] {
    const wanted = new Set(ids);
    return [...this.conflicts.values()].filter((conflict) =>
      wanted.has(conflict.id),
    );
  }

  private scheduleResurrectionFlush(resurrected: ExcalidrawElement[]): void {
    const ids = resurrected.map((element) => element.id);
    this.holdForceWin(ids);
    void this.enqueue(() => this.flushResurrection(resurrected))
      .catch((error) =>
        logError("collab.reconcile.resurrection_flush_failed", error, {
          boardId: this.boardId,
        }),
      )
      .finally(() => this.releaseForceWin(ids));
  }

  private async flushResurrection(
    resurrected: ExcalidrawElement[],
  ): Promise<void> {
    await this.broadcastUpdate(resurrected);
    const outcome = await persistScene(this.boardId, this.roomKey, [...this.elements.values()], {
      reviveIds: new Set(this.pendingForceWin.keys()),
    });
    await this.adoptPersistOutcome(outcome);
    logInfo("collab.reconcile.resurrection_flushed", {
      boardId: this.boardId,
      count: resurrected.length,
    });
  }

  private currentSceneVersion(): number {
    return getSceneVersion([...this.elements.values()]);
  }

  private liveElements(): ExcalidrawElement[] {
    return [...this.elements.values()].filter((element) => !element.isDeleted);
  }

  private recordWrites(
    changed: ExcalidrawElement[],
    origin: "bot" | "incoming",
    opts: { touchAssertedAt?: boolean } = {},
  ): void {
    const touchAssertedAt = opts.touchAssertedAt !== false;
    const sceneVersionAfter = this.currentSceneVersion();
    for (const element of changed) {
      this.writeLog.push({
        id: element.id,
        origin,
        sceneVersionAfter,
        updated: element.updated,
      });
      if (origin === "bot" && this.ownedIds.has(element.id)) {
        if (element.isDeleted) {
          this.ownedIds.delete(element.id);
          this.ownedSnapshots.delete(element.id);
          this.ownedAssertedAt.delete(element.id);
          this.botDeletedIds.add(element.id);
        } else {
          this.ownedSnapshots.set(element.id, element);
          if (touchAssertedAt) {
            this.ownedAssertedAt.set(element.id, Date.now());
          }
        }
      }
    }
    const overflow = this.writeLog.length - CollabBot.MAX_WRITE_LOG;
    if (overflow > 0) {
      this.writeLog.splice(0, overflow);
      this.writeLogEvicted = true;
    }
  }

  private lastOrigin(id: string): "bot" | "incoming" {
    for (let i = this.writeLog.length - 1; i >= 0; i--) {
      if (this.writeLog[i].id === id) {
        return this.writeLog[i].origin;
      }
    }
    return "bot";
  }

  private async connect(): Promise<void> {
    const startedAt = Date.now();
    logInfo("collab.connection.started", {
      boardId: this.boardId,
      subjectRef: opaqueRef(this.uid),
      role: this.role,
      wsServerUrl: safeUrl(config.wsServerUrl),
    });
    if (!this.roomKey) {
      await this.loadBoardContext();
      await this.initElements();
    }
    const token = await this.mintIdToken();

    await new Promise<void>((resolve, reject) => {
      const socket = io(config.wsServerUrl, {
        transports: ["websocket", "polling"],
        auth: { token, traceId: currentRequestId() },
      });
      this.socket = socket;

      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const settle = (event: string, action: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        logInfo("collab.connection.settled", {
          boardId: this.boardId,
          event,
          socketId: socket.id,
          connected: socket.connected,
          durationMs: Date.now() - startedAt,
        });
        action();
      };
      const detach = () => {
        socket.removeAllListeners();
        socket.close();
        if (this.socket === socket) {
          this.socket = null;
        }
      };

      const onError = (error: unknown) => {
        logError("collab.connection.failed", error, {
          boardId: this.boardId,
          socketId: socket.id,
          connected: socket.connected,
          durationMs: Date.now() - startedAt,
          wsServerUrl: safeUrl(config.wsServerUrl),
        });
        detach();
        settle("error", () =>
          reject(error instanceof Error ? error : new Error(String(error))),
        );
      };

      socket.on("connect", () => {
        logInfo("collab.socket.connected", {
          boardId: this.boardId,
          socketId: socket.id,
          transport: socket.io.engine.transport.name,
        });
      });
      socket.on("init-room", () => {
        logInfo("collab.socket.init_room_received", {
          boardId: this.boardId,
          socketId: socket.id,
        });
        socket.emit("join-room", this.boardId);
        logInfo("collab.socket.join_room_sent", {
          boardId: this.boardId,
          socketId: socket.id,
        });
      });
      socket.on("first-in-room", () => settle("first-in-room", resolve));
      socket.on("room-user-change", () =>
        settle("room-user-change", resolve),
      );
      socket.on("new-user", () => settle("new-user", resolve));
      socket.on("access-denied", (payload: unknown) => {
        logWarn("collab.socket.access_denied", {
          boardId: this.boardId,
          socketId: socket.id,
          payload,
        });
        this.accessDenied = true;
        detach();
        settle("access-denied", () =>
          reject(new BotAccessDeniedError(this.boardId)),
        );
      });
      socket.on("client-broadcast", (data: ArrayBuffer, iv: Uint8Array) => {
        void this.handleClientBroadcast(data, iv);
      });
      socket.on("connect_error", onError);
      socket.on("disconnect", (reason, description) => {
        logWarn("collab.socket.disconnected", {
          boardId: this.boardId,
          socketId: socket.id,
          reason,
          description:
            description instanceof Error
              ? description.message
              : description === undefined
                ? undefined
                : String(description),
          settled,
        });
        if (!settled) {
          onError(new Error(`collab socket disconnected before join: ${reason}`));
        }
      });

      timer = setTimeout(() => {
        if (socket.connected) {
          logWarn("collab.connection.join_ack_timeout_connected", {
            boardId: this.boardId,
            socketId: socket.id,
            durationMs: Date.now() - startedAt,
          });
          settle("connected-without-room-ack", resolve);
          return;
        }
        onError(
          new Error(`collab connection timed out for board ${this.boardId}`),
        );
      }, 4000);
    });

    this.lastPointer = this.sceneCentroid();
    await this.emitCursor(this.lastPointer, {});
  }

  dispose(): void {
    logInfo("collab.bot.disposed", {
      boardId: this.boardId,
      socketId: this.socket?.id,
    });
    this.socket?.close();
    this.socket = null;
  }
}

const bots = new Map<string, CollabBot>();

const botKey = (token: string, boardId: string): string => `${token}:${boardId}`;
const tokenPrefix = (token: string): string => `${token}:`;

export function getOrCreateBot(
  token: string,
  identity: BotIdentity,
): CollabBot {
  const key = botKey(token, identity.boardId);
  const existing = bots.get(key);
  if (existing && existing.matches(identity)) {
    logInfo("collab.bot.reused", { boardId: identity.boardId });
    return existing;
  }
  if (existing) {
    existing.dispose();
  }
  const bot = new CollabBot(identity);
  bots.set(key, bot);
  logInfo("collab.bot.created", {
    boardId: identity.boardId,
    role: identity.role,
    subjectRef: opaqueRef(identity.uid),
  });
  return bot;
}

export function disposeBotsForToken(token: string): void {
  const prefix = tokenPrefix(token);
  for (const [key, bot] of bots) {
    if (key.startsWith(prefix)) {
      bot.dispose();
      bots.delete(key);
    }
  }
}

export type BotBoardRuntimeStatus = {
  boardId: string;
  connected: boolean;
  lastActiveAt: number | null;
};

export function statusForTokens(tokens: string[]): BotBoardRuntimeStatus[] {
  const prefixes = tokens.map(tokenPrefix);
  const result: BotBoardRuntimeStatus[] = [];
  for (const [key, bot] of bots) {
    if (prefixes.some((prefix) => key.startsWith(prefix))) {
      result.push(bot.runtimeStatus());
    }
  }
  return result;
}
