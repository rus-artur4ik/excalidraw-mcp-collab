import { io, type Socket } from "socket.io-client";

import { config } from "../config";
import { auth, db } from "../firebase";
import { decryptJSON, encryptJSON } from "../encryption";
import { appendSceneHistory, loadScene, persistScene } from "../scene";
import { applyUpdate, buildNewElement, markDeleted } from "../elements";

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
      return this.idToken;
    }
    const customToken = await auth().createCustomToken(this.uid);
    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${config.firebaseWebApiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: customToken, returnSecureToken: true }),
      },
    );
    if (!response.ok) {
      throw new Error(`custom token exchange failed: ${response.status}`);
    }
    const data = (await response.json()) as { idToken?: string };
    if (!data.idToken) {
      throw new Error("custom token exchange returned no idToken");
    }
    this.idToken = data.idToken;
    this.idTokenExpiresAt = Date.now() + ID_TOKEN_TTL_MS;
    return this.idToken;
  }

  private async loadBoardContext(): Promise<void> {
    const keySnap = await db().collection("boardKeys").doc(this.boardId).get();
    const roomKey = keySnap.exists
      ? (keySnap.data() as { roomKey?: string }).roomKey
      : undefined;
    if (!roomKey) {
      throw new Error(`missing roomKey for board ${this.boardId}`);
    }
    this.roomKey = roomKey;

    try {
      const user = await auth().getUser(this.uid);
      this.displayName = user.displayName ?? user.email ?? this.uid;
    } catch {
      this.displayName = this.uid;
    }
  }

  private async initElements(): Promise<void> {
    const stored = await loadScene(this.boardId, this.roomKey);
    this.elements.clear();
    for (const element of stored ?? []) {
      this.elements.set(element.id, element);
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
      throw new BotAccessDeniedError(this.boardId);
    }
    if (this.socket?.connected) {
      return;
    }
    if (this.connecting) {
      return this.connecting;
    }
    this.connecting = this.connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async connect(): Promise<void> {
    if (!this.roomKey) {
      await this.loadBoardContext();
      await this.initElements();
    }
    const token = await this.mintIdToken();

    await new Promise<void>((resolve, reject) => {
      const socket = io(config.wsServerUrl, {
        transports: ["websocket", "polling"],
        auth: { token },
      });
      this.socket = socket;

      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (action: () => void) => {
        clearTimeout(timer);
        action();
      };
      const detach = () => {
        socket.close();
        if (this.socket === socket) {
          this.socket = null;
        }
      };

      const onError = (error: unknown) => {
        detach();
        settle(() =>
          reject(error instanceof Error ? error : new Error(String(error))),
        );
      };

      socket.on("init-room", () => {
        socket.emit("join-room", this.boardId);
      });
      socket.on("first-in-room", () => settle(resolve));
      socket.on("room-user-change", () => settle(resolve));
      socket.on("new-user", () => settle(resolve));
      socket.on("access-denied", () => {
        this.accessDenied = true;
        detach();
        settle(() => reject(new BotAccessDeniedError(this.boardId)));
      });
      socket.on("client-broadcast", (data: ArrayBuffer, iv: Uint8Array) => {
        void this.handleClientBroadcast(data, iv);
      });
      socket.on("connect_error", onError);

      timer = setTimeout(() => {
        if (socket.connected) {
          resolve();
          return;
        }
        onError(new Error(`collab connection timed out for board ${this.boardId}`));
      }, 4000);
    });
  }

  private async broadcastUpdate(changed: ExcalidrawElement[]): Promise<void> {
    if (!this.socket?.connected) {
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
  }

  private async commit(changed: ExcalidrawElement[]): Promise<void> {
    const all = [...this.elements.values()];
    await this.broadcastUpdate(changed);
    await persistScene(this.boardId, this.roomKey, all);
    await appendSceneHistory({
      roomId: this.boardId,
      roomKey: this.roomKey,
      author: this.authorLabel,
      elements: all,
    });
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
      if (filter?.ids && !filter.ids.includes(element.id)) {
        return false;
      }
      return true;
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
    return existing;
  }
  if (existing) {
    existing.dispose();
  }
  const bot = new CollabBot(identity);
  bots.set(token, bot);
  return bot;
}

export function disposeBot(token: string): void {
  const bot = bots.get(token);
  if (bot) {
    bot.dispose();
    bots.delete(token);
  }
}
