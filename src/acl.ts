import { auth, db } from "./firebase";
import { logError, logInfo, logWarn, opaqueRef } from "./logger";

import { DEFAULT_BOT_POLICY } from "./types";
import type { Access, BoardDoc, BotPolicy, Identity, TeamDoc } from "./types";

const ANONYMOUS: Identity = { uid: null, email: null };

// A bot impersonates the token owner, so it never exceeds that user's access;
// `botPolicy` only narrows it further per board.
function capByBotPolicy(access: Access, botPolicy: BotPolicy): Access {
  if (botPolicy === "none") {
    return { canRead: false, canWrite: false };
  }
  if (botPolicy === "read") {
    return { canRead: access.canRead, canWrite: false };
  }
  return access;
}

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
    logInfo("firestore.board.loaded", {
      boardId: roomId,
      exists: snap.exists,
    });
    return snap.exists ? (snap.data() as BoardDoc) : null;
  } catch (error) {
    logError("firestore.board.load_failed", error, { boardId: roomId });
    throw error;
  }
}

async function loadTeam(teamId: string): Promise<TeamDoc | null> {
  try {
    const snap = await db().collection("teams").doc(teamId).get();
    logInfo("firestore.team.loaded", {
      teamRef: opaqueRef(teamId),
      exists: snap.exists,
    });
    return snap.exists ? (snap.data() as TeamDoc) : null;
  } catch (error) {
    logError("firestore.team.load_failed", error, {
      teamRef: opaqueRef(teamId),
    });
    throw error;
  }
}

function evaluate(
  identity: Identity,
  board: BoardDoc | null,
  team: TeamDoc | null,
  asBot: boolean,
): Access {
  if (!board) {
    const open: Access = { canRead: true, canWrite: true };
    return asBot ? capByBotPolicy(open, DEFAULT_BOT_POLICY) : open;
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

  const access: Access = { canRead, canWrite };
  return asBot
    ? capByBotPolicy(access, board.botPolicy ?? DEFAULT_BOT_POLICY)
    : access;
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
      logWarn("acl.board_missing_defaults_to_open", { boardId: roomId });
    }
    const team = board?.teamId ? await loadTeam(board.teamId) : null;
    const access = evaluate(identity, board, team, asBot);
    logInfo("acl.evaluated", {
      boardId: roomId,
      subjectRef: opaqueRef(identity.uid),
      asBot,
      boardType: board?.type,
      readPolicy: board?.readPolicy,
      writePolicy: board?.writePolicy,
      hasTeam: !!board?.teamId,
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
