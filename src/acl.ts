import {auth, db} from "./firebase";
import {logError, logInfo, logWarn, opaqueRef} from "./logger";
import {evaluateAccess, needsTeam} from "./policy";

import type {Access, BoardDoc, Identity, TeamDoc} from "./types";
import {TEAM_ID} from "./types";

const ANONYMOUS: Identity = { uid: null, email: null };

export async function resolveIdentity(token?: string): Promise<Identity> {
  if (!token) {
    return ANONYMOUS;
  }
  try {
    const decoded = await auth().verifyIdToken(token);
    logInfo("firebase.identity.resolved", {
      subjectRef: opaqueRef(decoded.uid),
    });
    return { uid: decoded.uid, email: decoded.email ?? null };
  } catch (error) {
    logError("firebase.identity.resolve_failed", error);
    return ANONYMOUS;
  }
}

export async function loadBoard(roomId: string): Promise<BoardDoc | null> {
  try {
    const snap = await db().collection("boards").doc(roomId).get();
    logInfo("firestore.board.loaded", { boardId: roomId, exists: snap.exists });
    return snap.exists ? (snap.data() as BoardDoc) : null;
  } catch (error) {
    logError("firestore.board.load_failed", error, { boardId: roomId });
    throw error;
  }
}

export async function loadTeam(): Promise<TeamDoc | null> {
  try {
    const snap = await db().collection("teams").doc(TEAM_ID).get();
    return snap.exists ? (snap.data() as TeamDoc) : null;
  } catch (error) {
    logError("firestore.team.load_failed", error);
    throw error;
  }
}

export async function authorize(
  roomId: string,
  identity: Identity,
  opts: { asBot?: boolean } = {},
): Promise<Access> {
  const asBot = opts.asBot === true;
  try {
    const board = await loadBoard(roomId);
    if (!board) {
      logWarn("acl.board_missing", { boardId: roomId });
    }
    const team = needsTeam(board) ? await loadTeam() : null;
    const access = evaluateAccess(identity, board, team, asBot);
    logInfo("acl.evaluated", {
      boardId: roomId,
      subjectRef: opaqueRef(identity.uid),
      asBot,
      visibility: board?.visibility ?? (board ? "legacy" : "missing"),
      canRead: access.canRead,
      canWrite: access.canWrite,
    });
    return access;
  } catch (error) {
    logError("acl.evaluate_failed", error, {
      boardId: roomId,
      subjectRef: opaqueRef(identity.uid),
    });
    throw error;
  }
}
