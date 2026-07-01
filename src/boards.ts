import {db} from "./firebase";
import {loadTeam} from "./acl";
import {evaluateAccess} from "./policy";
import {logError, logInfo, opaqueRef} from "./logger";

import type {BoardDoc, Identity, TeamDoc} from "./types";
import {TEAM_ID} from "./types";

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
      if (board.archived) {
        continue;
      }
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
