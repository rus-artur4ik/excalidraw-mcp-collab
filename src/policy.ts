import type {Access, BoardDoc, BotPolicy, Identity, TeamDoc, TeamRole,} from "./types";
import {DEFAULT_BOT_POLICY} from "./types";

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

function inList(list: string[] | undefined, email: string | null): boolean {
  return !!email && !!list?.includes(email);
}

export function teamRoleOf(
  team: TeamDoc | null,
  email: string | null,
): TeamRole | null {
  if (inList(team?.admins, email)) {
    return "admin";
  }
  if (inList(team?.editorEmails, email)) {
    return "editor";
  }
  if (inList(team?.viewerEmails, email)) {
    return "viewer";
  }
  return null;
}

function legacyAccess(
  identity: Identity,
  board: BoardDoc,
  team: TeamDoc | null,
): Access {
  const { uid, email } = identity;
  const isOwner = !!uid && uid === board.ownerUid;
  const isWhitelisted = inList(board.editors, email);
  const role = board.teamId ? teamRoleOf(team, email) : null;
  const teamEditor = role === "admin" || role === "editor";
  const teamMember = role !== null;
  return {
    canRead:
      board.readPolicy === "public" || isOwner || isWhitelisted || teamMember,
    canWrite:
      board.writePolicy === "everyone" ||
      isOwner ||
      (board.writePolicy === "whitelist" && isWhitelisted) ||
      (board.writePolicy !== "owner" && teamEditor),
  };
}

export function evaluateAccess(
  identity: Identity,
  board: BoardDoc | null,
  team: TeamDoc | null,
  asBot: boolean,
): Access {
  // A missing board doc means a legacy `#room=` share (secured by link secrecy)
  // for humans, but a bot must never touch a board that has no ACL document.
  if (!board) {
    return asBot
      ? { canRead: false, canWrite: false }
      : { canRead: true, canWrite: true };
  }

  const { uid, email } = identity;
  const isOwner = !!uid && uid === board.ownerUid;

  let access: Access;
  if (board.visibility === undefined) {
    access = legacyAccess(identity, board, team);
  } else {
    const role = teamRoleOf(team, email);
    const teamEditor = role === "admin" || role === "editor";
    const teamMember = role !== null;
    const invitedEditor = inList(board.editors, email);
    const invitedViewer = inList(board.viewers, email);
    access = {
      canRead:
        isOwner ||
        board.visibility === "link" ||
        (board.visibility === "team" && teamMember) ||
        invitedEditor ||
        invitedViewer,
      canWrite:
        isOwner || (board.visibility === "team" && teamEditor) || invitedEditor,
    };
  }

  return asBot
    ? capByBotPolicy(access, board.botPolicy ?? DEFAULT_BOT_POLICY)
    : access;
}

export function needsTeam(board: BoardDoc | null): boolean {
  return !!board && (board.visibility === "team" || board.teamId != null);
}
