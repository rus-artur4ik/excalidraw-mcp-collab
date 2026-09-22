import {randomUUID} from "crypto";

import {db} from "./firebase";
import {decryptJSON, encryptJSON} from "./encryption";
import {logError, logInfo} from "./logger";
import {mergeForPersist} from "./reconcile";

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

// ---- the change journal (scenes/{roomId}/log/{commitId}) ------------------

export type SceneLogActor = {
  kind: "bot" | "human" | "system";
  botId?: string;
  uid?: string;
  note?: string;
};

export type SceneLogOp = "create" | "update" | "delete" | "revive" | "mixed" | "reload";

export type SceneLogInput = {
  commitId: string;
  op: SceneLogOp;
  ids: string[];
  counts: { created: number; updated: number; deleted: number; revived: number };
  sceneVersionBefore: number;
  actor: SceneLogActor;
  historyEntryId?: string;
  // Encrypted copies of the affected elements as they were BEFORE this commit,
  // so a revert has exact geometry long after the 24 h tombstone is gone.
  before?: { ciphertext: Uint8Array; iv: Uint8Array; count: number };
  beforeOmitted?: boolean;
  ttlDays?: number;
};

export type SceneLogEntry = {
  commitId: string;
  ts: number;
  op: SceneLogOp;
  ids: string[];
  counts: { created: number; updated: number; deleted: number; revived: number };
  sceneVersionBefore: number;
  sceneVersionAfter: number;
  actor: SceneLogActor;
  historyEntryId?: string;
  hasBefore: boolean;
  beforeOmitted?: boolean;
};

export const SCENE_LOG_TTL_DAYS = 30;

const logRef = (roomId: string, commitId: string) =>
  sceneRef(roomId).collection("log").doc(commitId);

const toLogEntry = (data: Record<string, unknown>): SceneLogEntry => ({
  commitId: String(data.commitId ?? ""),
  ts: Number(data.ts ?? 0),
  op: (data.op as SceneLogOp) ?? "mixed",
  ids: Array.isArray(data.ids) ? (data.ids as string[]) : [],
  counts: (data.counts as SceneLogEntry["counts"]) ?? { created: 0, updated: 0, deleted: 0, revived: 0 },
  sceneVersionBefore: Number(data.sceneVersionBefore ?? 0),
  sceneVersionAfter: Number(data.sceneVersionAfter ?? 0),
  actor: (data.actor as SceneLogActor) ?? { kind: "bot" },
  ...(data.historyEntryId ? { historyEntryId: String(data.historyEntryId) } : {}),
  hasBefore: !!data.before,
  ...(data.beforeOmitted ? { beforeOmitted: true } : {}),
});

// Newest first. `ids` filters client-side: an entry is kept when it touched any
// of them (the journal is small — one doc per commit, TTL'd).
export async function listSceneLog(
  roomId: string,
  opts: { limit?: number; since?: number; ids?: readonly string[]; ops?: readonly string[] } = {},
): Promise<SceneLogEntry[]> {
  const limit = Math.min(Math.max(1, opts.limit ?? 20), 100);
  let query = sceneRef(roomId).collection("log").orderBy("ts", "desc");
  if (opts.since) {
    query = query.where("ts", ">", opts.since);
  }
  const wanted = opts.ids?.length ? new Set(opts.ids) : null;
  const ops = opts.ops?.length ? new Set(opts.ops) : null;
  const snapshot = await query.limit(wanted || ops ? limit * 10 : limit).get();
  const entries: SceneLogEntry[] = [];
  for (const doc of snapshot.docs) {
    const entry = toLogEntry(doc.data() as Record<string, unknown>);
    if (wanted && !entry.ids.some((id) => wanted.has(id))) continue;
    if (ops && !ops.has(entry.op)) continue;
    entries.push(entry);
    if (entries.length >= limit) break;
  }
  return entries;
}

export async function getSceneLogEntry(
  roomId: string,
  commitId: string,
): Promise<SceneLogEntry | null> {
  const snapshot = await logRef(roomId, commitId).get();
  return snapshot.exists ? toLogEntry(snapshot.data() as Record<string, unknown>) : null;
}

// The elements as they were before that commit (decrypted), or null when the
// entry is gone, carried no snapshot, or the snapshot was too big to keep.
export async function loadSceneLogBefore(
  roomId: string,
  roomKey: string,
  commitId: string,
): Promise<ExcalidrawElement[] | null> {
  const snapshot = await logRef(roomId, commitId).get();
  if (!snapshot.exists) {
    return null;
  }
  const data = snapshot.data() as { before?: { ciphertext: unknown; iv: unknown } };
  if (!data.before) {
    return null;
  }
  return decryptJSON<ExcalidrawElement[]>(
    roomKey,
    toUint8(data.before.ciphertext),
    toUint8(data.before.iv),
  );
}

export type PersistOutcome = {
  sceneVersion: number;
  storedWins: ExcalidrawElement[];
  bumped: ExcalidrawElement[];
};

// Merge-on-write in a transaction, never a blind set: a concurrent human
// session writes the same doc, so overwriting would clobber elements the bot
// never saw (and vice-versa). Higher element `version` wins per id, except that
// `reviveIds` (elements this commit created) are lifted above a stored copy.
// The outcome tells the caller which stored copies won, so its memory never
// shows something the store does not have.
export async function persistScene(
  roomId: string,
  roomKey: string,
  elements: readonly ExcalidrawElement[],
  opts: { reviveIds?: ReadonlySet<string>; log?: SceneLogInput } = {},
): Promise<PersistOutcome> {
  const mine = getSyncableElements(elements);
  try {
    const outcome = await db().runTransaction(async (transaction) => {
      const snapshot = await transaction.get(sceneRef(roomId));
      let merge = { merged: mine, storedWins: [] as ExcalidrawElement[], bumped: [] as ExcalidrawElement[] };
      if (snapshot.exists) {
        const stored = snapshot.data() as StoredScene;
        // If the stored scene can't be read, abort rather than fall back to a
        // bot-only write — overwriting a doc we couldn't merge is the clobber
        // this transaction exists to prevent.
        const storedElements = await decryptJSON<ExcalidrawElement[]>(
          roomKey,
          toUint8(stored.ciphertext),
          toUint8(stored.iv),
        );
        merge = mergeForPersist(mine, getSyncableElements(storedElements), opts.reviveIds);
      }
      const version = getSceneVersion(merge.merged);
      const { ciphertext, iv } = await encryptJSON(roomKey, merge.merged);
      transaction.set(sceneRef(roomId), {
        sceneVersion: version,
        ciphertext: Buffer.from(ciphertext),
        iv: Buffer.from(iv),
      });
      // The journal entry goes in with the scene it describes: either both
      // land or neither does, so the log can never claim a commit that failed.
      if (opts.log) {
        const entry = opts.log;
        const ttlDays = entry.ttlDays ?? SCENE_LOG_TTL_DAYS;
        transaction.set(logRef(roomId, entry.commitId), {
          commitId: entry.commitId,
          ts: Date.now(),
          expiresAt: new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000),
          op: entry.op,
          ids: entry.ids,
          counts: entry.counts,
          sceneVersionBefore: entry.sceneVersionBefore,
          sceneVersionAfter: version,
          actor: entry.actor,
          ...(entry.historyEntryId ? { historyEntryId: entry.historyEntryId } : {}),
          ...(entry.before
            ? {
                before: {
                  ciphertext: Buffer.from(entry.before.ciphertext),
                  iv: Buffer.from(entry.before.iv),
                  count: entry.before.count,
                },
              }
            : {}),
          ...(entry.beforeOmitted ? { beforeOmitted: true } : {}),
        });
      }
      return { sceneVersion: version, storedWins: merge.storedWins, bumped: merge.bumped };
    });
    logInfo("firestore.scene.persisted", {
      boardId: roomId,
      elementCount: mine.length,
      sceneVersion: outcome.sceneVersion,
      storedWins: outcome.storedWins.length,
      bumped: outcome.bumped.length,
    });
    return outcome;
  } catch (error) {
    logError("firestore.scene.persist_failed", error, {
      boardId: roomId,
      elementCount: mine.length,
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
  // Let the caller pick the id so a journal entry written earlier in the same
  // commit can point at this snapshot.
  entryId?: string;
}): Promise<string> {
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
  const entryId = params.entryId ?? randomUUID();
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
    return entryId;
  } catch (error) {
    logError("firestore.scene_history.append_failed", error, {
      boardId: roomId,
      sceneVersion,
    });
    throw error;
  }
}

export type SceneHistoryEntry = Pick<
  HistoryEntryMeta,
  "id" | "kind" | "sequence" | "createdAt" | "author" | "sceneVersion" | "summary"
>;

// The shared history the browser's History sidebar shows: newest first.
export async function listSceneHistory(roomId: string): Promise<SceneHistoryEntry[]> {
  const snapshot = await historyMetaRef(roomId).get();
  if (!snapshot.exists) {
    return [];
  }
  const meta = snapshot.data() as HistoryMetadata;
  return [...(meta.entries ?? [])]
    .sort((a, b) => b.sequence - a.sequence)
    .map(({ id, kind, sequence, createdAt, author, sceneVersion, summary }) => ({
      id,
      kind,
      sequence,
      createdAt,
      ...(author ? { author } : {}),
      sceneVersion,
      summary,
    }));
}

// Full element snapshot stored with one history entry (tombstones < 24 h old
// included), or null when the entry was trimmed or never existed.
export async function loadSceneHistoryEntry(
  roomId: string,
  roomKey: string,
  entryId: string,
): Promise<ExcalidrawElement[] | null> {
  const snapshot = await historyEntryRef(roomId, entryId).get();
  if (!snapshot.exists) {
    return null;
  }
  const stored = snapshot.data() as { ciphertext: unknown; iv: unknown };
  const payload = await decryptJSON<HistoryPayload>(
    roomKey,
    toUint8(stored.ciphertext),
    toUint8(stored.iv),
  );
  return payload.elements ?? [];
}

// Cheap facts about a board for list_boards {details:true}: how much is on it,
// its frame names, and who touched it last (from the shared history).
export async function roomKeyOf(roomId: string): Promise<string | undefined> {
  const keySnap = await db().collection("boardKeys").doc(roomId).get();
  return keySnap.exists ? (keySnap.data() as { roomKey?: string }).roomKey : undefined;
}

// The persisted scene of a board without joining its room (cross-board reads).
export async function loadBoardScene(roomId: string): Promise<ExcalidrawElement[]> {
  const roomKey = await roomKeyOf(roomId);
  return roomKey ? (await loadScene(roomId, roomKey)) ?? [] : [];
}

export async function loadBoardSummary(roomId: string): Promise<{
  elementCount: number;
  frameNames: string[];
  updatedAt?: string;
  updatedBy?: string;
}> {
  const elements = await loadBoardScene(roomId);
  const live = elements.filter((element) => !element.isDeleted);
  const frameNames = live
    .filter((element) => element.type === "frame" && typeof element.name === "string" && element.name)
    .map((element) => element.name as string);
  const metaSnap = await historyMetaRef(roomId).get();
  const meta = metaSnap.exists ? (metaSnap.data() as HistoryMetadata) : null;
  const last = meta?.entries?.length
    ? [...meta.entries].sort((a, b) => b.sequence - a.sequence)[0]
    : undefined;
  return {
    elementCount: live.length,
    frameNames,
    ...(meta?.updatedAt ? { updatedAt: new Date(meta.updatedAt).toISOString() } : {}),
    ...(last?.author ? { updatedBy: last.author } : {}),
  };
}

// A standalone journal entry (no scene write of its own): the CollabBot start
// marker, so a gap in the log reads as "the process restarted here".
export async function appendSceneLogEntry(
  roomId: string,
  entry: Omit<SceneLogInput, "before" | "beforeOmitted"> & { sceneVersionAfter: number },
): Promise<void> {
  const ttlDays = entry.ttlDays ?? SCENE_LOG_TTL_DAYS;
  await logRef(roomId, entry.commitId).set({
    commitId: entry.commitId,
    ts: Date.now(),
    expiresAt: new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000),
    op: entry.op,
    ids: entry.ids,
    counts: entry.counts,
    sceneVersionBefore: entry.sceneVersionBefore,
    sceneVersionAfter: entry.sceneVersionAfter,
    actor: entry.actor,
  });
}
