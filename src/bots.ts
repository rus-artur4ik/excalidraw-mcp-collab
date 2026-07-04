import {db} from "./firebase";
import {logError, logInfo, opaqueRef} from "./logger";

import type {BotDoc} from "./types";

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

export async function requireOwnedBot(
  botId: string,
  ownerUid: string,
): Promise<BotDoc | null> {
  const bot = await getBot(botId);
  if (!bot || bot.ownerUid !== ownerUid) {
    logWarnMismatch(botId, ownerUid, bot);
    return null;
  }
  return bot;
}

const logWarnMismatch = (
  botId: string,
  ownerUid: string,
  bot: BotDoc | null,
): void => {
  logInfo("firestore.bot.owner_mismatch", {
    botId,
    subjectRef: opaqueRef(ownerUid),
    found: !!bot,
  });
};
