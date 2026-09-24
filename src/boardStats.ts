import {db} from "./firebase";
import type {BoardStats} from "./metrics";

const DAY_MS = 24 * 60 * 60_000;

// Scene history metadata docs (`scenes/<boardId>~history`) carry `updatedAt`
// (ms) and are rewritten on every saved version, by people and bots alike;
// other docs in `scenes` have no such field and never match the range filter.
export async function loadBoardStats(now: number = Date.now()): Promise<BoardStats> {
  const boards = db().collection("boards");
  const scenes = db().collection("scenes");
  const [total, archived, edited24h, edited7d] = await Promise.all([
    boards.count().get(),
    boards.where("archived", "==", true).count().get(),
    scenes.where("updatedAt", ">=", now - DAY_MS).count().get(),
    scenes.where("updatedAt", ">=", now - 7 * DAY_MS).count().get(),
  ]);
  const archivedCount = archived.data().count;
  return {
    active: total.data().count - archivedCount,
    archived: archivedCount,
    edited24h: edited24h.data().count,
    edited7d: edited7d.data().count,
  };
}
