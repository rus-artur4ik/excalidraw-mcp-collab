import {FieldValue} from "firebase-admin/firestore";

import {db} from "./firebase";
import {type BotDoc, decideBotBoardCreation} from "./bots";
import {logError, logInfo, opaqueRef} from "./logger";

import type {Identity} from "./types";

// Folders are the owner's personal grouping of boards on the app's home page:
// `users/{uid}/folders/{id}` = { name, boardIds, createdAt, updatedAt }. They
// never affect who can open a board. The shape is shared with the frontend
// (excalidraw-app/data/folders.ts) and enforced by firestore.rules for browser
// writes — keep all three in step.

export const FOLDER_NAME_MAX_LENGTH = 60;
// A looping agent must not be able to bury the owner's home page in folders.
export const MAX_FOLDERS_PER_OWNER = 100;

// Like board creation, working with folders is a permission the owner grants
// per bot, so a denial is an actionable outcome handed straight to the agent.
export class FolderPermissionDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FolderPermissionDeniedError";
  }
}

export type FolderDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * "Create folders" is a sub-permission of "Create boards": it only counts
 * while the parent is on, so turning board creation off also takes folders
 * away even if the stored flag is still true.
 */
export function decideBotFolderAccess(
  isFirstClass: boolean,
  bot: BotDoc | null,
): FolderDecision {
  if (!isFirstClass || !bot) {
    return {
      allowed: false,
      reason:
        "this token is not bound to a bot, so it cannot work with folders; mint a token for a bot on the Bots page",
    };
  }
  const parent = decideBotBoardCreation(isFirstClass, bot);
  if (!parent.allowed) {
    return bot.disabled
      ? parent
      : {
          allowed: false,
          reason:
            'this bot is not allowed to work with folders; its owner can turn on "Create boards" and then "Create folders" in the bot\'s settings',
        };
  }
  if (bot.canCreateFolders !== true) {
    return {
      allowed: false,
      reason:
        'this bot is not allowed to work with folders; its owner can turn on "Create folders" (under "Create boards") in the bot\'s settings',
    };
  }
  return { allowed: true };
}

export const normalizeFolderName = (raw: string | undefined): string =>
  (raw ?? "").replace(/\s+/g, " ").trim().slice(0, FOLDER_NAME_MAX_LENGTH);

type FolderDoc = {
  name?: string;
  boardIds?: string[];
  createdAt?: number;
  updatedAt?: number;
};

export type FolderSummary = {
  folderId: string;
  name: string;
  boardIds: string[];
};

const foldersOf = (uid: string) =>
  db().collection("users").doc(uid).collection("folders");

const requireUid = (identity: Identity): string => {
  if (!identity.uid) {
    throw new FolderPermissionDeniedError(
      "the token has no account to own folders",
    );
  }
  return identity.uid;
};

export async function listFolders(
  identity: Identity,
): Promise<FolderSummary[]> {
  const uid = requireUid(identity);
  try {
    const snap = await foldersOf(uid).get();
    return snap.docs
      .map((docSnap) => {
        const data = docSnap.data() as FolderDoc;
        return {
          folderId: docSnap.id,
          name: data.name ?? "",
          boardIds: data.boardIds ?? [],
        };
      })
      .sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
      );
  } catch (error) {
    logError("firestore.folders.list_failed", error, {
      subjectRef: opaqueRef(uid),
    });
    throw error;
  }
}

export type CreatedFolder = {
  folderId: string;
  name: string;
  /** false when a folder with this name already existed and was reused. */
  created: boolean;
};

/**
 * Creates a personal folder for the token's account. Idempotent by name
 * (case-insensitive): agents retry and re-plan, and two "Backend" folders on
 * the owner's home page help nobody.
 */
export async function createFolderForBot(params: {
  identity: Identity;
  botId: string;
  name: string;
}): Promise<CreatedFolder> {
  const uid = requireUid(params.identity);
  const name = normalizeFolderName(params.name);
  if (!name) {
    throw new FolderPermissionDeniedError("a folder needs a non-empty name");
  }

  const existing = await listFolders(params.identity);
  const match = existing.find(
    (folder) =>
      folder.name.localeCompare(name, undefined, { sensitivity: "base" }) === 0,
  );
  if (match) {
    return { folderId: match.folderId, name: match.name, created: false };
  }
  if (existing.length >= MAX_FOLDERS_PER_OWNER) {
    throw new FolderPermissionDeniedError(
      `this account already has ${MAX_FOLDERS_PER_OWNER} folders; reuse one from list_folders`,
    );
  }

  const now = Date.now();
  try {
    const ref = foldersOf(uid).doc();
    // Exactly the keys firestore.rules allows on a folder: an extra field
    // here would make every later rename/move from the browser fail validation.
    await ref.set({
      name,
      boardIds: [] as string[],
      createdAt: now,
      updatedAt: now,
    });
    logInfo("firestore.folder.created", {
      folderId: ref.id,
      botId: params.botId,
      subjectRef: opaqueRef(uid),
    });
    return { folderId: ref.id, name, created: true };
  } catch (error) {
    logError("firestore.folder.create_failed", error, {
      botId: params.botId,
      subjectRef: opaqueRef(uid),
    });
    throw error;
  }
}

/** Resolves a folder of this account, or null when the id is not theirs. */
export async function getFolder(
  identity: Identity,
  folderId: string,
): Promise<FolderSummary | null> {
  const uid = requireUid(identity);
  const snap = await foldersOf(uid).doc(folderId).get();
  if (!snap.exists) {
    return null;
  }
  const data = snap.data() as FolderDoc;
  return { folderId, name: data.name ?? "", boardIds: data.boardIds ?? [] };
}

/**
 * Files a board into a folder. A board sits in at most one folder, so it is
 * pulled out of every other folder in the same batch.
 */
export async function fileBoardInFolder(
  identity: Identity,
  folderId: string,
  boardId: string,
): Promise<void> {
  const uid = requireUid(identity);
  const folders = await listFolders(identity);
  const now = Date.now();
  const batch = db().batch();
  for (const folder of folders) {
    if (folder.folderId !== folderId && folder.boardIds.includes(boardId)) {
      batch.update(foldersOf(uid).doc(folder.folderId), {
        boardIds: FieldValue.arrayRemove(boardId),
        updatedAt: now,
      });
    }
  }
  // update (not set/merge): a folder deleted mid-call fails the batch instead
  // of being resurrected as a nameless doc.
  batch.update(foldersOf(uid).doc(folderId), {
    boardIds: FieldValue.arrayUnion(boardId),
    updatedAt: now,
  });
  await batch.commit();
  logInfo("firestore.folder.board_filed", {
    folderId,
    boardId,
    subjectRef: opaqueRef(uid),
  });
}
