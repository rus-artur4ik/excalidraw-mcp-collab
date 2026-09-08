import {randomBytes} from "crypto";

import {FieldValue} from "firebase-admin/firestore";

import {db} from "./firebase";
import {loadTeam} from "./acl";
import {BoardCreationDeniedError} from "./bots";
import {evaluateAccess, teamRoleOf} from "./policy";
import {logError, logInfo, opaqueRef} from "./logger";

import type {BoardDoc, Identity, TeamDoc, Visibility} from "./types";
import {DEFAULT_BOT_POLICY, TEAM_ID} from "./types";

export type AccessibleBoard = {
  boardId: string;
  title: string;
  botAccess: "read" | "write";
};

type BoardQuerySnapshot = {
  docs: { id: string; data: () => unknown }[];
};

const mergeInto = (target: Map<string, BoardDoc>, snap: BoardQuerySnapshot) => {
  for (const docSnap of snap.docs) {
    target.set(docSnap.id, docSnap.data() as BoardDoc);
  }
};

const collectOwned = async (uid: string): Promise<Map<string, BoardDoc>> => {
  const result = new Map<string, BoardDoc>();
  mergeInto(
    result,
    await db().collection("boards").where("ownerUid", "==", uid).get(),
  );
  return result;
};

const collectInvited = async (
  email: string,
): Promise<Map<string, BoardDoc>> => {
  const result = new Map<string, BoardDoc>();
  const [asEditor, asViewer] = await Promise.all([
    db().collection("boards").where("editors", "array-contains", email).get(),
    db().collection("boards").where("viewers", "array-contains", email).get(),
  ]);
  mergeInto(result, asEditor);
  mergeInto(result, asViewer);
  return result;
};

const collectTeamBoards = async (): Promise<Map<string, BoardDoc>> => {
  const result = new Map<string, BoardDoc>();
  const [byVisibility, legacyByTeamId] = await Promise.all([
    db().collection("boards").where("visibility", "==", "team").get(),
    db().collection("boards").where("teamId", "==", TEAM_ID).get(),
  ]);
  mergeInto(result, byVisibility);
  mergeInto(result, legacyByTeamId);
  return result;
};

const isTeamMember = (team: TeamDoc | null, email: string | null): boolean =>
  !!email &&
  !!team &&
  ((team.admins ?? []).includes(email) ||
    (team.editorEmails ?? []).includes(email) ||
    (team.viewerEmails ?? []).includes(email));

export async function listAccessibleBoards(
  identity: Identity,
): Promise<AccessibleBoard[]> {
  const { uid, email } = identity;
  if (!uid) {
    return [];
  }
  try {
    const team = await loadTeam().catch(() => null);
    const empty = new Map<string, BoardDoc>();
    const groups = await Promise.all([
      collectOwned(uid),
      email ? collectInvited(email) : Promise.resolve(empty),
      isTeamMember(team, email) ? collectTeamBoards() : Promise.resolve(empty),
    ]);

    const candidates = new Map<string, BoardDoc>();
    for (const group of groups) {
      for (const [id, board] of group) {
        candidates.set(id, board);
      }
    }

    const accessible: AccessibleBoard[] = [];
    for (const [boardId, board] of candidates) {
      const access = evaluateAccess(identity, board, team, true);
      if (!access.canRead) {
        continue;
      }
      accessible.push({
        boardId,
        title: board.title ?? "Untitled",
        botAccess: access.canWrite ? "write" : "read",
      });
    }

    logInfo("mcp.list_boards.resolved", {
      subjectRef: opaqueRef(uid),
      candidateCount: candidates.size,
      accessibleCount: accessible.length,
    });
    return accessible;
  } catch (error) {
    logError("mcp.list_boards.failed", error, { subjectRef: opaqueRef(uid) });
    throw error;
  }
}

const ROOM_ID_BYTES = 10;
// The room key is the frontend's AES-GCM-128 JWK `k`: 16 random bytes,
// base64url, unpadded (see src/encryption.ts and the app's
// `generateEncryptionKey`). Any other shape breaks every client that opens the
// board.
const ROOM_KEY_BYTES = 16;
const MAX_TITLE_LENGTH = 120;
const FALLBACK_TITLE = "Untitled";

export const generateRoomId = (): string =>
  randomBytes(ROOM_ID_BYTES).toString("hex");

export const generateRoomKey = (): string =>
  randomBytes(ROOM_KEY_BYTES).toString("base64url");

export const normalizeBoardTitle = (raw: string | undefined): string => {
  const collapsed = (raw ?? "").replace(/\s+/g, " ").trim();
  return collapsed ? collapsed.slice(0, MAX_TITLE_LENGTH) : FALLBACK_TITLE;
};

export type CreatedBoard = {
  boardId: string;
  title: string;
  visibility: Visibility;
  botAccess: "write";
};

/**
 * Creates a board owned by the token's account and binds it to the calling bot
 * in one atomic batch: board doc, room key, and the bot's allow-list entry all
 * land together, so a bot never ends up with a board it cannot open (or an
 * allow-list entry pointing at a board that was never written).
 *
 * The caller is responsible for the permission check
 * (`decideBotBoardCreation`); this function only enforces what depends on
 * Firestore state — team membership for a team-visible board.
 */
export async function createBoardForBot(params: {
  identity: Identity;
  botId: string;
  title?: string;
  visibility?: Visibility;
}): Promise<CreatedBoard> {
  const { identity, botId } = params;
  if (!identity.uid) {
    throw new BoardCreationDeniedError("the token has no account to own the board");
  }
  const visibility = params.visibility ?? "private";
  const title = normalizeBoardTitle(params.title);

  if (visibility === "team") {
    const team = await loadTeam().catch(() => null);
    if (!teamRoleOf(team, identity.email)) {
      throw new BoardCreationDeniedError(
        'visibility "team" needs the owning account to be a member of the shared team; create the board as "private" or "link" instead',
      );
    }
  }

  const boardId = generateRoomId();
  const roomKey = generateRoomKey();
  const stamp = FieldValue.serverTimestamp();
  const board = {
    ownerUid: identity.uid,
    ownerEmail: identity.email,
    title,
    visibility,
    editors: [] as string[],
    viewers: [] as string[],
    botPolicy: DEFAULT_BOT_POLICY,
    createdByBotId: botId,
    createdAt: stamp,
    updatedAt: stamp,
  };

  try {
    const batch = db().batch();
    batch.set(db().collection("boards").doc(boardId), board);
    batch.set(db().collection("boardKeys").doc(boardId), { roomKey });
    // update (not set/merge): a bot deleted mid-call fails the whole batch
    // instead of resurrecting its document.
    batch.update(db().collection("bots").doc(botId), {
      boards: FieldValue.arrayUnion({ boardId, role: "write" }),
      updatedAt: Date.now(),
    });
    await batch.commit();
  } catch (error) {
    logError("firestore.board.create_failed", error, {
      boardId,
      botId,
      subjectRef: opaqueRef(identity.uid),
    });
    throw error;
  }

  logInfo("firestore.board.created", {
    boardId,
    botId,
    visibility,
    subjectRef: opaqueRef(identity.uid),
  });
  return { boardId, title, visibility, botAccess: "write" };
}
