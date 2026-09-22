import {randomBytes} from "crypto";

import {reassertElement} from "./elements";

import type {ExcalidrawElement} from "./types";

// Union two element sets by id keeping the higher `version`; ties keep `mine`.
// This mirrors the frontend's version-based reconciliation so a transactional
// persist merges with whatever a concurrent writer (human session) already
// stored instead of clobbering it.
export const mergeByVersion = (
  mine: readonly ExcalidrawElement[],
  theirs: readonly ExcalidrawElement[],
): ExcalidrawElement[] => {
  const byId = new Map<string, ExcalidrawElement>();
  for (const element of theirs) {
    byId.set(element.id, element);
  }
  for (const element of mine) {
    const other = byId.get(element.id);
    if (!other || element.version >= other.version) {
      byId.set(element.id, element);
    }
  }
  return [...byId.values()];
};

export type PersistMerge = {
  merged: ExcalidrawElement[];
  // Stored copies that beat ours (a newer version we never saw): adopt them.
  storedWins: ExcalidrawElement[];
  // Our creations re-versioned above a stored tombstone so they are not lost.
  bumped: ExcalidrawElement[];
};

// mergeByVersion for a persist, with one exception: an element this commit
// just created (or revived) must win over a stored copy of the same id — a
// tombstone left by an earlier delete would otherwise swallow it silently.
export const mergeForPersist = (
  mine: readonly ExcalidrawElement[],
  stored: readonly ExcalidrawElement[],
  reviveIds: ReadonlySet<string> = new Set(),
): PersistMerge => {
  const storedById = new Map(stored.map((element) => [element.id, element] as const));
  const bumped: ExcalidrawElement[] = [];
  const adjusted = mine.map((element) => {
    if (!reviveIds.has(element.id) || element.isDeleted) {
      return element;
    }
    const other = storedById.get(element.id);
    if (!other || other.version < element.version) {
      return element;
    }
    const lifted = {
      ...element,
      version: other.version + 1,
      versionNonce: randomBytes(4).readUInt32BE(0),
    };
    bumped.push(lifted);
    return lifted;
  });
  const merged = mergeByVersion(adjusted, stored);
  const mergedById = new Map(merged.map((element) => [element.id, element] as const));
  const storedWins: ExcalidrawElement[] = [];
  for (const element of adjusted) {
    const winner = mergedById.get(element.id);
    if (winner && winner !== element) {
      storedWins.push(winner);
    }
  }
  return { merged, storedWins, bumped };
};

export type ConflictKind =
  | "resurrected"
  | "yielded"
  | "overwritten_by_incoming";

export type IncomingDecision =
  | { action: "ignore" }
  | { action: "accept" }
  | { action: "accept_conflict"; kind: ConflictKind }
  | { action: "resurrect"; element: ExcalidrawElement }
  | { action: "yield" };

// Strictly-newer incoming versions win. A deletion of a just-created owned
// element (still `resurrectable`) is resisted as a stale-tombstone clobber from
// an out-of-sync live session; past the window it is the human's edit and wins.
export const decideIncoming = (params: {
  incoming: ExcalidrawElement;
  current: ExcalidrawElement | undefined;
  isOwned: boolean;
  botDeleted: boolean;
  resurrectCount: number;
  maxResurrections: number;
  resurrectable: boolean;
  snapshot: ExcalidrawElement | undefined;
}): IncomingDecision => {
  const {
    incoming,
    current,
    isOwned,
    botDeleted,
    resurrectCount,
    maxResurrections,
    resurrectable,
    snapshot,
  } = params;

  if (current && incoming.version <= current.version) {
    return { action: "ignore" };
  }

  if (isOwned && incoming.isDeleted && !botDeleted) {
    if (
      resurrectable &&
      resurrectCount < maxResurrections &&
      snapshot &&
      !snapshot.isDeleted
    ) {
      return {
        action: "resurrect",
        element: reassertElement(snapshot, incoming.version),
      };
    }
    return { action: "yield" };
  }

  if (isOwned && !incoming.isDeleted) {
    return { action: "accept_conflict", kind: "overwritten_by_incoming" };
  }

  return { action: "accept" };
};
