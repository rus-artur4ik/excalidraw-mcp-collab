import { io, type Socket } from "socket.io-client";

import { config } from "../config";
import { auth, db } from "../firebase";
import { decryptJSON, encryptJSON } from "../encryption";
import { appendSceneHistory, loadScene, persistScene } from "../scene";
import { applyUpdate, buildNewElement, markDeleted } from "../elements";
import {
  currentRequestId,
  logError,
  logInfo,
  logWarn,
  opaqueRef,
  safeUrl,
} from "../logger";

import type { ExcalidrawElement, Role } from "../types";

const WS_SUBTYPE_INIT = "SCENE_INIT";
const WS_SUBTYPE_UPDATE = "SCENE_UPDATE";
const ID_TOKEN_TTL_MS = 50 * 60 * 1000;

type Broadcast = {
  type: typeof WS_SUBTYPE_INIT | typeof WS_SUBTYPE_UPDATE;
  payload: { elements: ExcalidrawElement[] };
};

export type BotIdentity = {
  uid: string;
  boardId: string;
  role: Role;
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

  private reconcileIncoming(elements: ExcalidrawElement[]): void {
    for (const incoming of elements) {
      const current = this.elements.get(incoming.id);
      if (!current || incoming.version > current.version) {
        this.elements.set(incoming.id, incoming);
      }
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

  private async commit(changed: ExcalidrawElement[]): Promise<void> {
    const all = [...this.elements.values()];
    try {
      await this.broadcastUpdate(changed);
      await persistScene(this.boardId, this.roomKey, all);
      await appendSceneHistory({
        roomId: this.boardId,
        roomKey: this.roomKey,
        author: this.authorLabel,
        elements: all,
      });
      logInfo("collab.commit.succeeded", {
        boardId: this.boardId,
        changedCount: changed.length,
        totalCount: all.length,
      });
    } catch (error) {
      logError("collab.commit.failed", error, {
        boardId: this.boardId,
        changedCount: changed.length,
        totalCount: all.length,
      });
      throw error;
    }
  }

  private requireEditor(): void {
    if (this.role !== "editor") {
      throw new ReadOnlyError();
    }
  }

  async describeScene(): Promise<ExcalidrawElement[]> {
    await this.ensureConnected();
    return [...this.elements.values()].filter((element) => !element.isDeleted);
  }

  async queryElements(filter?: {
    type?: string;
    ids?: string[];
  }): Promise<ExcalidrawElement[]> {
    const all = await this.describeScene();
    return all.filter((element) => {
      if (filter?.type && element.type !== filter.type) {
        return false;
      }
      return !(filter?.ids && !filter.ids.includes(element.id));

    });
  }

  async createElement(
    attrs: Partial<ExcalidrawElement> & { type: string },
  ): Promise<ExcalidrawElement> {
    this.requireEditor();
    await this.ensureConnected();
    const element = buildNewElement(attrs, [...this.elements.values()]);
    this.elements.set(element.id, element);
    await this.commit([element]);
    return element;
  }

  async updateElement(
    id: string,
    patch: Partial<ExcalidrawElement>,
  ): Promise<ExcalidrawElement> {
    this.requireEditor();
    await this.ensureConnected();
    const current = this.elements.get(id);
    if (!current || current.isDeleted) {
      throw new Error(`element not found: ${id}`);
    }
    const updated = applyUpdate(current, patch);
    this.elements.set(id, updated);
    await this.commit([updated]);
    return updated;
  }

  async deleteElement(id: string): Promise<void> {
    this.requireEditor();
    await this.ensureConnected();
    const current = this.elements.get(id);
    if (!current || current.isDeleted) {
      throw new Error(`element not found: ${id}`);
    }
    const deleted = markDeleted(current);
    this.elements.set(id, deleted);
    await this.commit([deleted]);
  }

  async clearCanvas(): Promise<number> {
    this.requireEditor();
    await this.ensureConnected();
    const changed: ExcalidrawElement[] = [];
    for (const element of this.elements.values()) {
      if (!element.isDeleted) {
        const deleted = markDeleted(element);
        this.elements.set(deleted.id, deleted);
        changed.push(deleted);
      }
    }
    if (changed.length) {
      await this.commit(changed);
    }
    return changed.length;
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

export function getOrCreateBot(
  token: string,
  identity: BotIdentity,
): CollabBot {
  const existing = bots.get(token);
  if (existing && existing.matches(identity)) {
    logInfo("collab.bot.reused", { boardId: identity.boardId });
    return existing;
  }
  if (existing) {
    existing.dispose();
  }
  const bot = new CollabBot(identity);
  bots.set(token, bot);
  logInfo("collab.bot.created", {
    boardId: identity.boardId,
    role: identity.role,
    subjectRef: opaqueRef(identity.uid),
  });
  return bot;
}

export function disposeBot(token: string): void {
  const bot = bots.get(token);
  if (bot) {
    bot.dispose();
    bots.delete(token);
  }
}
