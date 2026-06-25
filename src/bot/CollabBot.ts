import {randomUUID} from "crypto";

import {io, type Socket} from "socket.io-client";

import {config} from "../config";
import {auth, db} from "../firebase";
import {decryptJSON, encryptJSON} from "../encryption";
import {appendSceneHistory, getSceneVersion, loadScene, persistScene,} from "../scene";
import {applyUpdate, buildNewElement, type CreateAttrs, markDeleted, planCreations,} from "../elements";
import {
  type ArrangeOptions,
  arrangePositions,
  asText,
  type Bounds,
  DEFAULT_FONT_FAMILY,
  DEFAULT_FONT_SIZE,
  elementAtPoint,
  getCommonBounds,
  getElementBounds,
  isBindable,
  layoutText,
  lintElement,
  type LintFinding,
  lintScene,
  type LintScopeOptions,
  planConnection,
  type RenderOptions,
  renderSvg,
  svgToPngBase64,
} from "../verify";
import {currentRequestId, logError, logInfo, logWarn, opaqueRef, safeUrl,} from "../logger";

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
};

export type ElementWriteResult = {
  element: ExcalidrawElement;
  sceneVersion: number;
  readback: { found: boolean; version?: number };
  warnings: LintFinding[];
  related?: ExcalidrawElement[];
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

  private roomKey = "";
  private idToken = "";
  private idTokenExpiresAt = 0;
  private displayName = "";

  private socket: Socket | null = null;
  private accessDenied = false;
  private connecting: Promise<void> | null = null;

  private elements = new Map<string, ExcalidrawElement>();
  private lastPointer = { x: 0, y: 0 };

  private static readonly MAX_WRITE_LOG = 1000;
  private static readonly MAX_UNDO = 50;
  private writeLog: Array<{
    id: string;
    origin: "bot" | "incoming";
    sceneVersionAfter: number;
    updated: number;
  }> = [];
  private writeLogEvicted = false;
  private undoStack: Array<Array<{ id: string; prior: ExcalidrawElement | null }>> = [];
  private undoing = false;

  constructor(identity: BotIdentity) {
    this.uid = identity.uid;
    this.boardId = identity.boardId;
    this.role = identity.role;
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
    return `🤖 ${this.displayName || "Bot"}`;
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
      customToken = await auth().createCustomToken(this.uid);
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
    } catch (error) {
      logError("collab.scene_initialization.failed", error, {
        boardId: this.boardId,
      });
      throw error;
    }
  }

  async createElement(attrs: CreateAttrs): Promise<ElementWriteResult> {
    this.requireEditor();
    await this.ensureConnected();
    const { created, containerUpdates } = planCreations(
      [attrs],
      [...this.elements.values()],
    );
    await this.commitCreations(created, containerUpdates, { select: true });
    const live = this.liveElements();
    const primary = created[0];
    return {
      element: primary,
      sceneVersion: this.currentSceneVersion(),
      readback: this.readback(primary.id),
      warnings: created.flatMap((element) => lintElement(element, live)),
      ...(created.length > 1 ? { related: created.slice(1) } : {}),
    };
  }

  async updateElement(
    id: string,
    patch: Partial<ExcalidrawElement>,
  ): Promise<ElementWriteResult> {
    const { updated } = await this.updateElements([{ id, ...patch }]);
    const element = (updated as ExcalidrawElement[])[0];
    return {
      element,
      sceneVersion: this.currentSceneVersion(),
      readback: this.readback(id),
      warnings: lintElement(element, this.liveElements()),
    };
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

  async ensureConnected(): Promise<void> {
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
        auth: { token, traceId: currentRequestId(), asBot: true },
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

  async updateElements(
    patches: Array<{ id: string } & Partial<ExcalidrawElement>>,
    opts: { returnIds?: boolean } = {},
  ): Promise<{
    updated: ExcalidrawElement[] | string[];
    sceneVersion: number;
    warnings: LintFinding[];
  }> {
    this.requireEditor();
    await this.ensureConnected();
    const frame: Array<{ id: string; prior: ExcalidrawElement | null }> = [];
    const changed: ExcalidrawElement[] = [];
    for (const { id, ...patch } of patches) {
      const current = this.elements.get(id);
      if (!current || current.isDeleted) {
        throw new Error(`element not found: ${id}`);
      }
      frame.push({ id, prior: current });
      const updated = applyUpdate(current, this.withTextSizing(current, patch));
      this.elements.set(id, updated);
      changed.push(updated);
    }
    if (changed.length) {
      this.pushUndo(frame);
      await this.commit(changed, { targets: changed, select: true });
      this.recordWrites(changed, "bot");
    }
    const live = this.liveElements();
    return {
      updated: opts.returnIds ? changed.map((element) => element.id) : changed,
      sceneVersion: this.currentSceneVersion(),
      warnings: changed.flatMap((element) => lintElement(element, live)),
    };
  }

  async createElements(
    items: CreateAttrs[],
    opts: { returnIds?: boolean } = {},
  ): Promise<{
    created: ExcalidrawElement[] | string[];
    sceneVersion: number;
    warnings: LintFinding[];
  }> {
    this.requireEditor();
    await this.ensureConnected();
    const { created, containerUpdates } = planCreations(items, [
      ...this.elements.values(),
    ]);
    await this.commitCreations(created, containerUpdates, { select: true });
    const live = this.liveElements();
    const warnings = created.flatMap((element) => lintElement(element, live));
    return {
      created: opts.returnIds ? created.map((element) => element.id) : created,
      sceneVersion: this.currentSceneVersion(),
      warnings,
    };
  }

  async deleteElements(selector: {
    ids?: string[];
    groupId?: string;
  }): Promise<{ deleted: string[]; sceneVersion: number }> {
    this.requireEditor();
    await this.ensureConnected();
    return this.deleteResolved(this.resolveTargets(selector));
  }

  async deleteRegion(
    region: Bounds,
    opts: { mode?: "intersect" | "contain"; type?: string } = {},
  ): Promise<{ deleted: string[]; sceneVersion: number }> {
    this.requireEditor();
    await this.ensureConnected();
    const mode = opts.mode ?? "intersect";
    const targets = this.liveElements().filter((element) => {
      if (opts.type && element.type !== opts.type) {
        return false;
      }
      const [x1, y1, x2, y2] = getElementBounds(element);
      return mode === "contain"
        ? x1 >= region[0] && y1 >= region[1] && x2 <= region[2] && y2 <= region[3]
        : x1 <= region[2] && x2 >= region[0] && y1 <= region[3] && y2 >= region[1];
    });
    return this.deleteResolved(targets);
  }

  async groupElements(
    ids: string[],
  ): Promise<{ groupId: string; updated: string[]; sceneVersion: number }> {
    this.requireEditor();
    await this.ensureConnected();
    const targets = this.resolveTargets({ ids });
    if (targets.length < 2) {
      throw new Error("need at least two existing elements to group");
    }
    const groupId = randomUUID();
    const changed = await this.patchMany(
      targets.map((element) => ({
        id: element.id,
        patch: { groupIds: [...(element.groupIds ?? []), groupId] },
      })),
    );
    return {
      groupId,
      updated: changed.map((element) => element.id),
      sceneVersion: this.currentSceneVersion(),
    };
  }

  private requireEditor(): void {
    if (this.role !== "editor") {
      throw new ReadOnlyError();
    }
  }

  async ungroupElements(selector: {
    ids?: string[];
    groupId?: string;
  }): Promise<{ updated: string[]; sceneVersion: number }> {
    this.requireEditor();
    await this.ensureConnected();
    const targets = this.resolveTargets(selector);
    const changed = await this.patchMany(
      targets.map((element) => ({
        id: element.id,
        patch: {
          groupIds: selector.groupId
            ? (element.groupIds ?? []).filter((g) => g !== selector.groupId)
            : (element.groupIds ?? []).slice(0, -1),
        },
      })),
    );
    return {
      updated: changed.map((element) => element.id),
      sceneVersion: this.currentSceneVersion(),
    };
  }

  async deleteElement(
    id: string,
  ): Promise<{ deleted: string; sceneVersion: number }> {
    this.requireEditor();
    await this.ensureConnected();
    const current = this.elements.get(id);
    if (!current || current.isDeleted) {
      throw new Error(`element not found: ${id}`);
    }
    this.pushUndo([{ id, prior: current }]);
    const deleted = markDeleted(current);
    this.elements.set(id, deleted);
    await this.showActivity([current], false);
    await this.commit([deleted]);
    this.recordWrites([deleted], "bot");
    return { deleted: id, sceneVersion: this.currentSceneVersion() };
  }

  async createFrame(opts: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    name?: string;
    childIds?: string[];
  }): Promise<{ frame: ExcalidrawElement; children: string[]; sceneVersion: number }> {
    this.requireEditor();
    await this.ensureConnected();
    const children = opts.childIds
      ? this.resolveTargets({ ids: opts.childIds })
      : [];
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
      const pad = 24;
      bounds = [x1 - pad, y1 - pad, x2 + pad, y2 + pad];
    } else {
      throw new Error("createFrame needs explicit x/y/width/height or childIds");
    }
    const frame = buildNewElement(
      {
        type: "frame",
        x: bounds[0],
        y: bounds[1],
        width: bounds[2] - bounds[0],
        height: bounds[3] - bounds[1],
        name: opts.name ?? null,
        backgroundColor: "transparent",
      },
      [...this.elements.values()],
    );
    const frameUndo: Array<{ id: string; prior: ExcalidrawElement | null }> = [
      { id: frame.id, prior: null },
    ];
    const changed: ExcalidrawElement[] = [frame];
    for (const child of children) {
      frameUndo.push({ id: child.id, prior: child });
      const updated = applyUpdate(child, { frameId: frame.id });
      this.elements.set(child.id, updated);
      changed.push(updated);
    }
    this.elements.set(frame.id, frame);
    this.pushUndo(frameUndo);
    await this.commit(changed, { targets: [frame], select: true });
    this.recordWrites(changed, "bot");
    return {
      frame,
      children: children.map((child) => child.id),
      sceneVersion: this.currentSceneVersion(),
    };
  }

  async clearCanvas(
    confirm: boolean,
  ): Promise<{ deletedCount: number; requiresConfirm: boolean; wouldDelete?: number }> {
    this.requireEditor();
    await this.ensureConnected();
    const live = this.liveElements();
    if (!confirm) {
      return { deletedCount: 0, requiresConfirm: true, wouldDelete: live.length };
    }
    const changed: ExcalidrawElement[] = [];
    const frame: Array<{ id: string; prior: ExcalidrawElement | null }> = [];
    for (const element of this.elements.values()) {
      if (!element.isDeleted) {
        frame.push({ id: element.id, prior: element });
        const deleted = markDeleted(element);
        this.elements.set(deleted.id, deleted);
        changed.push(deleted);
      }
    }
    if (changed.length) {
      this.pushUndo(frame);
      await this.commit(changed);
      this.recordWrites(changed, "bot");
    }
    return { deletedCount: changed.length, requiresConfirm: false };
  }

  async queryElements(filter?: {
    type?: string;
    ids?: string[];
    groupId?: string;
  }): Promise<ExcalidrawElement[]> {
    const all = await this.describeScene();
    return all.filter((element) => {
      if (filter?.type && element.type !== filter.type) {
        return false;
      }
      if (filter?.ids && !filter.ids.includes(element.id)) {
        return false;
      }
      return !(
        filter?.groupId && !(element.groupIds ?? []).includes(filter.groupId)
      );
    });
  }

  async validateScene(
    options?: LintScopeOptions,
  ): Promise<ReturnType<typeof lintScene> & { sceneVersion: number }> {
    await this.ensureConnected();
    const result = lintScene(this.liveElements(), options);
    return { ...result, sceneVersion: this.currentSceneVersion() };
  }

  async render(
    options: RenderOptions & { format?: "png" | "svg"; groupId?: string },
  ): Promise<{
    format: "png" | "svg";
    png?: string;
    svg?: string;
    transform: ReturnType<typeof renderSvg>["transform"];
    legend: ReturnType<typeof renderSvg>["legend"];
    width: number;
    height: number;
    sceneVersion: number;
  }> {
    await this.ensureConnected();
    const ids = options.groupId
      ? this.resolveTargets({ groupId: options.groupId }).map((element) => element.id)
      : options.ids;
    const rendered = renderSvg([...this.elements.values()], { ...options, ids });
    const png =
      options.format === "svg" ? null : svgToPngBase64(rendered.svg);
    return {
      format: png ? "png" : "svg",
      ...(png ? { png } : { svg: rendered.svg }),
      transform: rendered.transform,
      legend: rendered.legend,
      width: rendered.width,
      height: rendered.height,
      sceneVersion: this.currentSceneVersion(),
    };
  }

  private async commitCreations(
    created: ExcalidrawElement[],
    containerUpdates: ExcalidrawElement[],
    opts: { select: boolean },
  ): Promise<void> {
    const all = [...containerUpdates, ...created];
    if (!all.length) {
      return;
    }
    this.pushUndo([
      ...containerUpdates.map((element) => ({
        id: element.id,
        prior: this.elements.get(element.id) ?? null,
      })),
      ...created.map((element) => ({ id: element.id, prior: null })),
    ]);
    for (const element of all) {
      this.elements.set(element.id, element);
    }
    await this.commit(all, {
      targets: created.length ? created : all,
      select: opts.select,
    });
    this.recordWrites(all, "bot");
  }

  private withTextSizing(
    current: ExcalidrawElement,
    patch: Partial<ExcalidrawElement>,
  ): Partial<ExcalidrawElement> {
    if (current.type !== "text" || asText(current).containerId != null) {
      return patch;
    }
    const touched = patch as {
      text?: unknown;
      fontSize?: unknown;
      fontFamily?: unknown;
      lineHeight?: number;
    };
    const touchesText =
      touched.text !== undefined ||
      touched.fontSize !== undefined ||
      touched.fontFamily !== undefined;
    if (!touchesText) {
      return patch;
    }
    if (typeof patch.width === "number" && typeof patch.height === "number") {
      return patch;
    }
    const raw = String(
      patch.text !== undefined ? patch.text : asText(current).text ?? "",
    );
    const fontSize =
      typeof patch.fontSize === "number"
        ? patch.fontSize
        : asText(current).fontSize ?? DEFAULT_FONT_SIZE;
    const fontFamily =
      typeof patch.fontFamily === "number"
        ? patch.fontFamily
        : asText(current).fontFamily ?? DEFAULT_FONT_FAMILY;
    const fixedWidth =
      typeof patch.width === "number"
        ? patch.width
        : asText(current).autoResize === false
          ? current.width || undefined
          : undefined;
    const layout = layoutText(raw, fontSize, fontFamily, fixedWidth);
    return {
      ...patch,
      width: patch.width ?? layout.width,
      height: patch.height ?? layout.height,
      text: layout.text,
      lineHeight: touched.lineHeight ?? layout.lineHeight,
    };
  }

  async connectElements(
    fromId: string,
    toId: string,
    options: {
      mode?: "inside" | "orbit" | "skip";
      startArrowhead?: string | null;
      endArrowhead?: string | null;
    } = {},
  ): Promise<ElementWriteResult> {
    this.requireEditor();
    await this.ensureConnected();
    if (fromId === toId) {
      throw new Error("cannot connect an element to itself");
    }
    const from = this.elements.get(fromId);
    const to = this.elements.get(toId);
    if (!from || from.isDeleted) {
      throw new Error(`element not found: ${fromId}`);
    }
    if (!to || to.isDeleted) {
      throw new Error(`element not found: ${toId}`);
    }
    if (!isBindable(from) || !isBindable(to)) {
      throw new Error("both elements must be bindable shapes to connect");
    }

    const arrowId = randomUUID();
    const plan = planConnection(from, to, {
      arrowId,
      mode: options.mode,
      startArrowhead: options.startArrowhead,
      endArrowhead: options.endArrowhead,
    });
    const arrow = buildNewElement(
      { ...plan.arrow, id: arrowId },
      [...this.elements.values()],
    );
    const pruneBackrefs = (
      entries: { id: string; type: string }[],
    ): { id: string; type: string }[] =>
      entries.filter((entry) => {
        if (entry.type !== "arrow" || entry.id === arrowId) {
          return true;
        }
        const target = this.elements.get(entry.id);
        return !!target && !target.isDeleted;
      });
    const fromUpdated = applyUpdate(from, {
      boundElements: pruneBackrefs(plan.fromBoundElements),
    });
    const toUpdated = applyUpdate(to, {
      boundElements: pruneBackrefs(plan.toBoundElements),
    });

    this.pushUndo([
      { id: arrowId, prior: null },
      { id: fromId, prior: from },
      { id: toId, prior: to },
    ]);
    this.elements.set(arrowId, arrow);
    this.elements.set(fromId, fromUpdated);
    this.elements.set(toId, toUpdated);
    const changed = [arrow, fromUpdated, toUpdated];
    await this.commit(changed, { targets: [arrow], select: true });
    this.recordWrites(changed, "bot");

    return {
      element: arrow,
      sceneVersion: this.currentSceneVersion(),
      readback: this.readback(arrowId),
      warnings: lintElement(arrow, this.liveElements()),
    };
  }

  async arrange(
    ids: string[],
    options: ArrangeOptions,
  ): Promise<{ moved: ExcalidrawElement[]; sceneVersion: number }> {
    this.requireEditor();
    await this.ensureConnected();
    const targets = ids
      .map((id) => this.elements.get(id))
      .filter((element): element is ExcalidrawElement => !!element && !element.isDeleted);
    if (!targets.length) {
      throw new Error("no matching elements to arrange");
    }
    const positions = arrangePositions(targets, options);
    const frame: Array<{ id: string; prior: ExcalidrawElement | null }> = [];
    const changed: ExcalidrawElement[] = [];
    for (const target of targets) {
      const next = positions.get(target.id);
      if (!next) {
        continue;
      }
      frame.push({ id: target.id, prior: target });
      const [minX, minY] = getElementBounds(target);
      const updated = applyUpdate(target, {
        x: target.x + (next[0] - minX),
        y: target.y + (next[1] - minY),
      });
      this.elements.set(target.id, updated);
      changed.push(updated);
    }
    if (changed.length) {
      this.pushUndo(frame);
      await this.commit(changed, { targets: changed, select: true });
      this.recordWrites(changed, "bot");
    }
    return { moved: changed, sceneVersion: this.currentSceneVersion() };
  }

  private async commit(
    changed: ExcalidrawElement[],
    activity?: { targets: ExcalidrawElement[]; select: boolean },
  ): Promise<void> {
    await this.broadcastUpdate(changed);
    // Emit the cursor before the Firestore writes so presence doesn't trail the persist latency.
    if (activity) {
      await this.showActivity(activity.targets, activity.select);
    }
    const all = [...this.elements.values()];
    await persistScene(this.boardId, this.roomKey, all);
    // History is recorded independently: a history failure must not lose the
    // user-visible change (already broadcast + persisted), but must be loud.
    try {
      await appendSceneHistory({
        roomId: this.boardId,
        roomKey: this.roomKey,
        author: this.authorLabel,
        elements: all,
      });
    } catch (error) {
      logError("collab.commit.history_failed", error, {
        boardId: this.boardId,
        changedCount: changed.length,
        totalCount: all.length,
      });
    }
    logInfo("collab.commit.succeeded", {
      boardId: this.boardId,
      changedCount: changed.length,
      totalCount: all.length,
    });
  }

  async describeScene(): Promise<ExcalidrawElement[]> {
    await this.ensureConnected();
    return [...this.elements.values()].filter((element) => !element.isDeleted);
  }

  private async patchMany(
    items: Array<{ id: string; patch: Partial<ExcalidrawElement> }>,
  ): Promise<ExcalidrawElement[]> {
    const frame: Array<{ id: string; prior: ExcalidrawElement | null }> = [];
    const changed: ExcalidrawElement[] = [];
    for (const { id, patch } of items) {
      const current = this.elements.get(id);
      if (!current || current.isDeleted) {
        continue;
      }
      frame.push({ id, prior: current });
      const updated = applyUpdate(current, patch);
      this.elements.set(id, updated);
      changed.push(updated);
    }
    if (changed.length) {
      this.pushUndo(frame);
      await this.commit(changed, { targets: changed, select: true });
      this.recordWrites(changed, "bot");
    }
    return changed;
  }

  async undoLast(): Promise<{ undone: number; sceneVersion: number }> {
    this.requireEditor();
    await this.ensureConnected();
    const frame = this.undoStack.pop();
    if (!frame) {
      return { undone: 0, sceneVersion: this.currentSceneVersion() };
    }
    const changed: ExcalidrawElement[] = [];
    for (const { id, prior } of frame) {
      const current = this.elements.get(id);
      if (prior === null) {
        if (current && !current.isDeleted) {
          const deleted = markDeleted(current);
          this.elements.set(id, deleted);
          changed.push(deleted);
        }
        continue;
      }
      const base = current ?? prior;
      const restored = applyUpdate(base, prior);
      this.elements.set(id, restored);
      changed.push(restored);
    }
    if (changed.length) {
      this.undoing = true;
      try {
        await this.commit(changed);
      } finally {
        this.undoing = false;
      }
      this.recordWrites(changed, "bot");
    }
    return { undone: changed.length, sceneVersion: this.currentSceneVersion() };
  }

  async getBounds(ids?: string[]): Promise<{
    bounds: Bounds;
    width: number;
    height: number;
    elements: string[];
  }> {
    await this.ensureConnected();
    const live = this.liveElements();
    const targets =
      ids && ids.length
        ? live.filter((element) => ids.includes(element.id))
        : live;
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

  private resolveTargets(selector: {
    ids?: string[];
    groupId?: string;
  }): ExcalidrawElement[] {
    const live = this.liveElements();
    if (selector.groupId) {
      const groupId = selector.groupId;
      return live.filter((element) => (element.groupIds ?? []).includes(groupId));
    }
    if (selector.ids) {
      const set = new Set(selector.ids);
      return live.filter((element) => set.has(element.id));
    }
    return [];
  }

  async sceneDiff(sinceVersion?: number): Promise<{
    sceneVersion: number;
    since: number | null;
    truncated: boolean;
    changes: Array<{
      id: string;
      type: string;
      origin: "bot" | "incoming";
      version: number;
      status: "present" | "deleted";
    }>;
    byOrigin: { bot: string[]; incoming: string[] };
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
      version: number;
      status: "present" | "deleted";
    }> = [];
    const byOrigin = { bot: [] as string[], incoming: [] as string[] };
    for (const [id, origin] of latestById) {
      const element = this.elements.get(id);
      if (!element) {
        continue;
      }
      changes.push({
        id,
        type: element.type,
        origin,
        version: element.version,
        status: element.isDeleted ? "deleted" : "present",
      });
      byOrigin[origin].push(id);
    }
    return {
      sceneVersion,
      since: sinceVersion ?? null,
      truncated,
      changes,
      byOrigin,
    };
  }

  // Deleting a container cascades to its bound text, matching the live editor.
  private async deleteResolved(
    targets: ExcalidrawElement[],
  ): Promise<{ deleted: string[]; sceneVersion: number }> {
    const ids = new Set(targets.map((element) => element.id));
    for (const element of this.liveElements()) {
      const container = asText(element).containerId;
      if (typeof container === "string" && ids.has(container)) {
        ids.add(element.id);
      }
    }
    const frame: Array<{ id: string; prior: ExcalidrawElement | null }> = [];
    const changed: ExcalidrawElement[] = [];
    for (const id of ids) {
      const current = this.elements.get(id);
      if (!current || current.isDeleted) {
        continue;
      }
      frame.push({ id, prior: current });
      const deleted = markDeleted(current);
      this.elements.set(id, deleted);
      changed.push(deleted);
    }
    if (changed.length) {
      this.pushUndo(frame);
      await this.commit(changed);
      this.recordWrites(changed, "bot");
    }
    return {
      deleted: changed.map((element) => element.id),
      sceneVersion: this.currentSceneVersion(),
    };
  }

  private reconcileIncoming(elements: ExcalidrawElement[]): void {
    const accepted: ExcalidrawElement[] = [];
    for (const incoming of elements) {
      const current = this.elements.get(incoming.id);
      if (!current || incoming.version > current.version) {
        this.elements.set(incoming.id, incoming);
        accepted.push(incoming);
      }
    }
    if (accepted.length) {
      this.recordWrites(accepted, "incoming");
    }
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
  ): void {
    const sceneVersionAfter = this.currentSceneVersion();
    for (const element of changed) {
      this.writeLog.push({
        id: element.id,
        origin,
        sceneVersionAfter,
        updated: element.updated,
      });
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

  private pushUndo(
    frame: Array<{ id: string; prior: ExcalidrawElement | null }>,
  ): void {
    if (this.undoing) {
      return;
    }
    this.undoStack.push(frame);
    if (this.undoStack.length > CollabBot.MAX_UNDO) {
      this.undoStack.shift();
    }
  }

  private readback(
    id: string,
  ): { found: boolean; version?: number } {
    const element = this.elements.get(id);
    return element && !element.isDeleted
      ? { found: true, version: element.version }
      : { found: false };
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
