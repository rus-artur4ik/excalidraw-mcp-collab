import {randomUUID} from "crypto";

import {db} from "./firebase";
import {decryptJSON, encryptJSON} from "./encryption";
import {logError, logInfo} from "./logger";

import type {ExcalidrawElement} from "./types";

const toUint8 = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value && typeof (value as { toUint8Array?: unknown }).toUint8Array === "function") {
    return (value as { toUint8Array: () => Uint8Array }).toUint8Array();
  }
  return new Uint8Array(value as ArrayBufferLike);
};

const SCENE_HISTORY_VERSION = 1;
const MAX_SCENE_HISTORY_ENTRIES = 120;
const SCENE_HISTORY_ID_SUFFIX = "~history";
const SESSION_ID = `bot:${randomUUID()}`;

type StoredScene = {
  sceneVersion: number;
  iv: unknown;
  ciphertext: unknown;
};

type HistoryEntryKind = "initial" | "change" | "restore";

type HistoryEntryMeta = {
  id: string;
  kind: HistoryEntryKind;
  sequence: number;
  createdAt: number;
  sessionId: string;
  author?: string;
  parentId: string | null;
  summary: string;
  fileIds: string[];
  sceneVersion: number;
  restoreSourceId?: string;
};

type HistoryMetadata = {
  historyVersion: typeof SCENE_HISTORY_VERSION;
  currentEntryId: string | null;
  currentSceneVersion: number | null;
  lastSequence: number;
  updatedAt: number;
  entries: HistoryEntryMeta[];
};

type HistoryPayload = {
  elements: ExcalidrawElement[];
  appState: { viewBackgroundColor?: string; name?: string };
  thumbnail: string | null;
};

const assertHistoryRoomId = (roomId: string) => {
  if (roomId.includes("~")) {
    throw new Error(`Unexpected "~" in collab room id: ${roomId}`);
  }
};

const sceneRef = (roomId: string) => db().collection("scenes").doc(roomId);

const historyMetaRef = (roomId: string) => {
  assertHistoryRoomId(roomId);
  return db()
    .collection("scenes")
    .doc(`${roomId}${SCENE_HISTORY_ID_SUFFIX}`);
};

const historyEntryRef = (roomId: string, entryId: string) => {
  assertHistoryRoomId(roomId);
  return db()
    .collection("scenes")
    .doc(`${roomId}${SCENE_HISTORY_ID_SUFFIX}~${entryId}`);
};

export const getSceneVersion = (
  elements: readonly ExcalidrawElement[],
): number => elements.reduce((acc, element) => acc + element.version, 0);

const isSyncable = (element: ExcalidrawElement): boolean => {
  if (element.isDeleted) {
    return element.updated > Date.now() - 24 * 60 * 60 * 1000;
  }
  if (
    element.type === "line" ||
    element.type === "arrow" ||
    element.type === "freedraw"
  ) {
    const points = (element as { points?: unknown }).points;
    const hasPoints = Array.isArray(points) && points.length >= 2;
    return hasPoints || element.width > 0 || element.height > 0;
  }
  return element.width > 0 && element.height > 0;
};

export const getSyncableElements = (
  elements: readonly ExcalidrawElement[],
): ExcalidrawElement[] => elements.filter(isSyncable);

const referencedFileIds = (elements: readonly ExcalidrawElement[]): string[] => {
  const ids = new Set<string>();
  for (const element of elements) {
    if (
      element.type === "image" &&
      !element.isDeleted &&
      typeof element.fileId === "string"
    ) {
      ids.add(element.fileId);
    }
  }
  return [...ids];
};

export async function loadScene(
  roomId: string,
  roomKey: string,
): Promise<ExcalidrawElement[] | null> {
  try {
    const snap = await sceneRef(roomId).get();
    if (!snap.exists) {
      logInfo("firestore.scene.missing", { boardId: roomId });
      return null;
    }
    const stored = snap.data() as StoredScene;
    const elements = await decryptJSON<ExcalidrawElement[]>(
      roomKey,
      toUint8(stored.ciphertext),
      toUint8(stored.iv),
    );
    logInfo("firestore.scene.loaded", {
      boardId: roomId,
      elementCount: elements.length,
      sceneVersion: stored.sceneVersion,
    });
    return elements;
  } catch (error) {
    logError("firestore.scene.load_or_decrypt_failed", error, {
      boardId: roomId,
    });
    throw error;
  }
}

export async function persistScene(
  roomId: string,
  roomKey: string,
  elements: readonly ExcalidrawElement[],
): Promise<void> {
  const syncable = getSyncableElements(elements);
  const sceneVersion = getSceneVersion(syncable);
  const { ciphertext, iv } = await encryptJSON(roomKey, syncable);
  const stored: StoredScene = {
    sceneVersion,
    ciphertext: Buffer.from(ciphertext),
    iv: Buffer.from(iv),
  };
  try {
    await sceneRef(roomId).set(stored);
    logInfo("firestore.scene.persisted", {
      boardId: roomId,
      elementCount: syncable.length,
      sceneVersion,
    });
  } catch (error) {
    logError("firestore.scene.persist_failed", error, {
      boardId: roomId,
      elementCount: syncable.length,
      sceneVersion,
    });
    throw error;
  }
}

export async function appendSceneHistory(params: {
  roomId: string;
  roomKey: string;
  author?: string;
  elements: readonly ExcalidrawElement[];
  viewBackgroundColor?: string;
  name?: string;
}): Promise<void> {
  const { roomId, roomKey, author, elements } = params;
  const syncable = getSyncableElements(elements);
  const sceneVersion = getSceneVersion(syncable);

  const payload: HistoryPayload = {
    elements: [...syncable],
    appState: {
      viewBackgroundColor: params.viewBackgroundColor,
      name: params.name,
    },
    thumbnail: null,
  };
  const { ciphertext, iv } = await encryptJSON(roomKey, payload);

  const metaRef = historyMetaRef(roomId);
  const entryId = randomUUID();
  const createdAt = Date.now();
  const fileIds = referencedFileIds(syncable);

  try {
    await db().runTransaction(async (transaction) => {
      const metaSnapshot = await transaction.get(metaRef);
      const meta = metaSnapshot.exists
        ? (metaSnapshot.data() as HistoryMetadata)
        : null;

      const existingEntries = meta?.entries ?? [];
      const sequence = (meta?.lastSequence ?? -1) + 1;
      const entryKind: HistoryEntryKind = sequence === 0 ? "initial" : "change";

      const entryMeta: HistoryEntryMeta = {
        id: entryId,
        kind: entryKind,
        sequence,
        createdAt,
        sessionId: SESSION_ID,
        ...(author ? { author } : {}),
        parentId: meta?.currentEntryId ?? null,
        summary:
          entryKind === "initial" ? "Initial version" : "Shared scene updated",
        fileIds,
        sceneVersion,
      };

      const allEntries = [...existingEntries, entryMeta];
      const overflow = Math.max(
        0,
        allEntries.length - MAX_SCENE_HISTORY_ENTRIES,
      );
      const trimmedEntries = allEntries.slice(0, overflow);
      const nextEntries = allEntries.slice(overflow);

      const nextMetadata: HistoryMetadata = {
        historyVersion: SCENE_HISTORY_VERSION,
        currentEntryId: entryId,
        currentSceneVersion: sceneVersion,
        lastSequence: sequence,
        updatedAt: createdAt,
        entries: nextEntries,
      };

      transaction.set(historyEntryRef(roomId, entryId), {
        historyVersion: SCENE_HISTORY_VERSION,
        sceneVersion,
        ciphertext: Buffer.from(ciphertext),
        iv: Buffer.from(iv),
      });
      transaction.set(metaRef, nextMetadata);

      for (const trimmed of trimmedEntries) {
        transaction.delete(historyEntryRef(roomId, trimmed.id));
      }
    });
    logInfo("firestore.scene_history.appended", {
      boardId: roomId,
      sceneVersion,
    });
  } catch (error) {
    logError("firestore.scene_history.append_failed", error, {
      boardId: roomId,
      sceneVersion,
    });
    throw error;
  }
}
