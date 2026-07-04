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
  disabled?: boolean;
  createdAt?: number;
  updatedAt?: number;
};

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
