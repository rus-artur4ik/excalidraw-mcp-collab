import { db } from "./firebase";
import { authorize } from "./acl";
import { logError, logInfo, opaqueRef } from "./logger";

import type { BoardDoc, Identity } from "./types";

export type AccessibleBoard = {
  boardId: string;
  title: string;
  botAccess: "read" | "write";
};

const collectOwned = async (uid: string): Promise<Map<string, BoardDoc>> => {
  const result = new Map<string, BoardDoc>();
  const snap = await db().collection("boards").where("ownerUid", "==", uid).get();
  for (const docSnap of snap.docs) {
    result.set(docSnap.id, docSnap.data() as BoardDoc);
  }
  return result;
};

const collectWhitelisted = async (
  email: string,
): Promise<Map<string, BoardDoc>> => {
  const result = new Map<string, BoardDoc>();
  const snap = await db()
    .collection("boards")
    .where("editors", "array-contains", email)
    .get();
  for (const docSnap of snap.docs) {
    result.set(docSnap.id, docSnap.data() as BoardDoc);
  }
  return result;
};

const collectTeamBoards = async (
  email: string,
): Promise<Map<string, BoardDoc>> => {
  const result = new Map<string, BoardDoc>();
  const teamIds = new Set<string>();
  for (const field of ["admins", "editorEmails", "viewerEmails"]) {
    const snap = await db()
      .collection("teams")
      .where(field, "array-contains", email)
      .get();
    for (const docSnap of snap.docs) {
      teamIds.add(docSnap.id);
    }
  }
  for (const teamId of teamIds) {
    const snap = await db()
      .collection("boards")
      .where("teamId", "==", teamId)
      .get();
    for (const docSnap of snap.docs) {
      result.set(docSnap.id, docSnap.data() as BoardDoc);
    }
  }
  return result;
};

export async function listAccessibleBoards(
  identity: Identity,
): Promise<AccessibleBoard[]> {
  const { uid, email } = identity;
  if (!uid) {
    return [];
  }
  try {
    const empty = new Map<string, BoardDoc>();
    const candidates = new Map<string, BoardDoc>();
    const groups = await Promise.all([
      collectOwned(uid),
      email ? collectWhitelisted(email) : Promise.resolve(empty),
      email ? collectTeamBoards(email) : Promise.resolve(empty),
    ]);
    for (const group of groups) {
      for (const [id, board] of group) {
        candidates.set(id, board);
      }
    }

    const accessible: AccessibleBoard[] = [];
    for (const [boardId, board] of candidates) {
      const access = await authorize(boardId, identity, { asBot: true });
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
