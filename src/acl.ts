import { auth, db } from "./firebase";

import type { Access, BoardDoc, Identity, TeamDoc } from "./types";

const ANONYMOUS: Identity = { uid: null, email: null };

export async function resolveIdentity(token?: string): Promise<Identity> {
  if (!token) {
    return ANONYMOUS;
  }
  try {
    const decoded = await auth().verifyIdToken(token);
    return { uid: decoded.uid, email: decoded.email ?? null };
  } catch {
    return ANONYMOUS;
  }
}

export async function loadBoard(roomId: string): Promise<BoardDoc | null> {
  const snap = await db().collection("boards").doc(roomId).get();
  return snap.exists ? (snap.data() as BoardDoc) : null;
}

async function loadTeam(teamId: string): Promise<TeamDoc | null> {
  const snap = await db().collection("teams").doc(teamId).get();
  return snap.exists ? (snap.data() as TeamDoc) : null;
}

function evaluate(
  identity: Identity,
  board: BoardDoc | null,
  team: TeamDoc | null,
): Access {
  if (!board) {
    return { canRead: true, canWrite: true };
  }

  const { uid, email } = identity;

  const isOwner = !!uid && uid === board.ownerUid;
  const isWhitelisted = !!email && !!board.editors?.includes(email);

  const teamAdmin = !!team && !!email && !!team.admins?.includes(email);
  const teamEditor =
    teamAdmin || (!!team && !!email && !!team.editorEmails?.includes(email));
  const teamMember =
    teamAdmin ||
    teamEditor ||
    (!!team && !!email && !!team.viewerEmails?.includes(email));

  const canRead =
    board.readPolicy === "public" || isOwner || isWhitelisted || teamMember;

  const canWrite =
    board.writePolicy === "everyone" ||
    isOwner ||
    teamAdmin ||
    (board.writePolicy === "whitelist" && isWhitelisted) ||
    teamEditor;

  return { canRead, canWrite };
}

export async function authorize(
  roomId: string,
  identity: Identity,
): Promise<Access> {
  const board = await loadBoard(roomId);
  const team = board?.teamId ? await loadTeam(board.teamId) : null;
  return evaluate(identity, board, team);
}
