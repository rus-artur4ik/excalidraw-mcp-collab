import {db} from "./firebase";
import {logError, logInfo} from "./logger";

import type {Access, Role} from "./types";

export type BotBoardBinding = { boardId: string; role: "read" | "write" };

export type BotBoardDecision =
  | { allowed: false }
  | { allowed: true; role: Role };

export function decideBotBoardAccess(
  isFirstClass: boolean,
  binding: BotBoardBinding | undefined,
  access: Access,
): BotBoardDecision {
  if (isFirstClass && !binding) {
    return { allowed: false };
  }
  if (!access.canRead) {
    return { allowed: false };
  }
  const canWrite = access.canWrite && binding?.role !== "read";
  return { allowed: true, role: canWrite ? "editor" : "viewer" };
}

export type BotDoc = {
  ownerUid: string;
  name?: string;
  color?: string;
  avatar?: unknown;
  boards?: BotBoardBinding[];
  // Per-bot permission, set by the owner in the bot's settings. Absent = off.
  canCreateBoards?: boolean;
  disabled?: boolean;
  createdAt?: number;
  updatedAt?: number;
};

// Board creation is a permission the owner grants per bot, so a denial is a
// normal, actionable outcome rather than a server fault: the message is handed
// straight to the agent.
export class BoardCreationDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoardCreationDeniedError";
  }
}

export type BoardCreationDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

export function decideBotBoardCreation(
  isFirstClass: boolean,
  bot: BotDoc | null,
): BoardCreationDecision {
  // Legacy account-wide tokens carry no bot doc, so there is nowhere to grant
  // the permission — and nowhere to bind the created board.
  if (!isFirstClass || !bot) {
    return {
      allowed: false,
      reason:
        "this token is not bound to a bot, so it cannot create boards; mint a token for a bot on the Bots page",
    };
  }
  if (bot.disabled) {
    return { allowed: false, reason: "this bot is disabled" };
  }
  if (bot.canCreateBoards !== true) {
    return {
      allowed: false,
      reason:
        'this bot is not allowed to create boards; its owner can turn on "Create boards" in the bot\'s settings',
    };
  }
  return { allowed: true };
}

const COLLECTION = "bots";

export async function getBot(botId: string): Promise<BotDoc | null> {
  try {
    const snap = await db().collection(COLLECTION).doc(botId).get();
    logInfo("firestore.bot.loaded", { botId, exists: snap.exists });
    return snap.exists ? (snap.data() as BotDoc) : null;
  } catch (error) {
    logError("firestore.bot.load_failed", error, { botId });
    throw error;
  }
}

export async function getOwnedBot(
  botId: string,
  uid: string,
): Promise<BotDoc | null> {
  const bot = await getBot(botId);
  return bot && bot.ownerUid === uid ? bot : null;
}

export function bindingFor(
  bot: BotDoc | null,
  boardId: string,
): BotBoardBinding | undefined {
  return bot?.boards?.find((binding) => binding.boardId === boardId);
}
