import {beforeEach, describe, expect, it, vi} from "vitest";

import {
  createBoardForBot,
  generateRoomId,
  generateRoomKey,
  normalizeBoardTitle,
} from "../boards";
import {BoardCreationDeniedError} from "../bots";
import {decryptJSON, encryptJSON} from "../encryption";

type BatchOp = {
  op: "set" | "update";
  collection: string;
  id: string;
  data: Record<string, unknown>;
};

const { state } = vi.hoisted(() => ({
  state: {
    team: null as Record<string, unknown> | null,
    ops: [] as BatchOp[],
    committed: 0,
    commitError: null as Error | null,
  },
}));

vi.mock("../firebase", () => {
  const ref = (collection: string, id: string) => ({
    collection,
    id,
    get: async () => ({
      exists: collection === "teams" && state.team !== null,
      data: () => state.team,
    }),
  });
  return {
    auth: () => ({}),
    db: () => ({
      collection: (collection: string) => ({
        doc: (id: string) => ref(collection, id),
      }),
      batch: () => {
        const staged: BatchOp[] = [];
        return {
          set: (target: { collection: string; id: string }, data: unknown) => {
            staged.push({
              op: "set",
              collection: target.collection,
              id: target.id,
              data: data as Record<string, unknown>,
            });
          },
          update: (target: { collection: string; id: string }, data: unknown) => {
            staged.push({
              op: "update",
              collection: target.collection,
              id: target.id,
              data: data as Record<string, unknown>,
            });
          },
          commit: async () => {
            if (state.commitError) {
              throw state.commitError;
            }
            state.ops.push(...staged);
            state.committed += 1;
          },
        };
      },
    }),
  };
});

const owner = { uid: "u1", email: "owner@x.io" };

const opFor = (collection: string): BatchOp | undefined =>
  state.ops.find((entry) => entry.collection === collection);

beforeEach(() => {
  state.team = null;
  state.ops = [];
  state.committed = 0;
  state.commitError = null;
});

describe("room id / room key generation", () => {
  it("mints a 20-hex-char room id like the app does", () => {
    expect(generateRoomId()).toMatch(/^[0-9a-f]{20}$/);
    expect(generateRoomId()).not.toBe(generateRoomId());
  });

  it("mints a room key the shared AES-GCM helpers accept", async () => {
    const key = generateRoomKey();
    // 16 bytes, base64url, unpadded — the frontend's exported JWK `k`.
    expect(key).toMatch(/^[A-Za-z0-9_-]{22}$/);

    const { ciphertext, iv } = await encryptJSON(key, { hello: "board" });
    expect(await decryptJSON(key, ciphertext, iv)).toEqual({ hello: "board" });
  });
});

describe("normalizeBoardTitle", () => {
  it("collapses whitespace, trims and falls back to Untitled", () => {
    expect(normalizeBoardTitle("  Sprint   plan \n ")).toBe("Sprint plan");
    expect(normalizeBoardTitle("   ")).toBe("Untitled");
    expect(normalizeBoardTitle(undefined)).toBe("Untitled");
  });

  it("caps a runaway title", () => {
    expect(normalizeBoardTitle("x".repeat(500))).toHaveLength(120);
  });
});

describe("createBoardForBot", () => {
  it("writes board, room key and the bot binding in one batch", async () => {
    const created = await createBoardForBot({
      identity: owner,
      botId: "bot1",
      title: "  Retro  ",
    });

    expect(created).toMatchObject({
      title: "Retro",
      visibility: "private",
      botAccess: "write",
    });
    expect(created.boardId).toMatch(/^[0-9a-f]{20}$/);
    expect(state.committed).toBe(1);

    const board = opFor("boards");
    expect(board?.id).toBe(created.boardId);
    expect(board?.data).toMatchObject({
      ownerUid: "u1",
      ownerEmail: "owner@x.io",
      title: "Retro",
      visibility: "private",
      editors: [],
      viewers: [],
      botPolicy: "write",
      createdByBotId: "bot1",
    });

    const key = opFor("boardKeys");
    expect(key?.id).toBe(created.boardId);
    expect(key?.data.roomKey).toMatch(/^[A-Za-z0-9_-]{22}$/);

    const bot = opFor("bots");
    expect(bot?.op).toBe("update");
    expect(bot?.id).toBe("bot1");
    expect(JSON.stringify(bot?.data)).toContain(created.boardId);
  });

  it("refuses team visibility when the owner is not on the team", async () => {
    await expect(
      createBoardForBot({
        identity: owner,
        botId: "bot1",
        title: "Team board",
        visibility: "team",
      }),
    ).rejects.toBeInstanceOf(BoardCreationDeniedError);
    expect(state.committed).toBe(0);
  });

  it("allows team visibility for a team member", async () => {
    state.team = { admins: [], editorEmails: ["owner@x.io"], viewerEmails: [] };
    const created = await createBoardForBot({
      identity: owner,
      botId: "bot1",
      title: "Team board",
      visibility: "team",
    });
    expect(created.visibility).toBe("team");
    expect(opFor("boards")?.data.visibility).toBe("team");
  });

  it("refuses when the token carries no account", async () => {
    await expect(
      createBoardForBot({
        identity: { uid: null, email: null },
        botId: "bot1",
        title: "x",
      }),
    ).rejects.toBeInstanceOf(BoardCreationDeniedError);
    expect(state.committed).toBe(0);
  });

  it("surfaces a failed batch instead of reporting a board that does not exist", async () => {
    state.commitError = new Error("bot deleted mid-call");
    await expect(
      createBoardForBot({ identity: owner, botId: "gone", title: "x" }),
    ).rejects.toThrow("bot deleted mid-call");
    expect(state.ops).toHaveLength(0);
  });
});
