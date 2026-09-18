import {FieldValue} from "firebase-admin/firestore";
import {beforeEach, describe, expect, it, vi} from "vitest";

import {
  BOARD_DESCRIPTION_MAX_LENGTH,
  BoardEditDeniedError,
  createBoardForBot,
  decideBoardEdit,
  generateRoomId,
  generateRoomKey,
  normalizeBoardDescription,
  normalizeBoardTitle,
  renameBoardForBot,
  setBoardDescriptionForBot,
} from "../boards";
import {BotAccessDeniedError, ReadOnlyError} from "../bot/CollabBot";
import {BoardCreationDeniedError} from "../bots";
import {decryptJSON, encryptJSON} from "../encryption";

import type {BoardDoc} from "../types";

type BatchOp = {
  op: "set" | "update";
  collection: string;
  id: string;
  data: Record<string, unknown>;
};

const { state } = vi.hoisted(() => ({
  state: {
    team: null as Record<string, unknown> | null,
    boards: new Map<string, Record<string, unknown>>(),
    updates: [] as { collection: string; id: string; data: Record<string, unknown> }[],
    ops: [] as BatchOp[],
    committed: 0,
    commitError: null as Error | null,
  },
}));

vi.mock("../firebase", () => {
  const ref = (collection: string, id: string) => ({
    collection,
    id,
    get: async () =>
      collection === "boards"
        ? { exists: state.boards.has(id), data: () => state.boards.get(id) }
        : {
            exists: collection === "teams" && state.team !== null,
            data: () => state.team,
          },
    update: async (data: Record<string, unknown>) => {
      state.updates.push({ collection, id, data });
    },
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
  state.boards = new Map();
  state.updates = [];
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

describe("normalizeBoardDescription", () => {
  it("collapses whitespace and line breaks into one trimmed paragraph", () => {
    expect(normalizeBoardDescription("  What went\n\n well \t ")).toBe(
      "What went well",
    );
    expect(normalizeBoardDescription("   ")).toBe("");
    expect(normalizeBoardDescription(undefined)).toBe("");
  });

  it("caps a runaway description at the length firestore.rules allows", () => {
    expect(normalizeBoardDescription("x".repeat(1000))).toHaveLength(
      BOARD_DESCRIPTION_MAX_LENGTH,
    );
    expect(BOARD_DESCRIPTION_MAX_LENGTH).toBe(300);
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

  it("stores a normalized description and echoes it back", async () => {
    const created = await createBoardForBot({
      identity: owner,
      botId: "bot1",
      title: "Retro",
      description: "  What went\nwell ",
    });
    expect(created.description).toBe("What went well");
    expect(opFor("boards")?.data.description).toBe("What went well");
  });

  it("leaves the description key out when it is blank", async () => {
    const created = await createBoardForBot({
      identity: owner,
      botId: "bot1",
      title: "Retro",
      description: "   ",
    });
    expect(created).not.toHaveProperty("description");
    expect(opFor("boards")?.data).not.toHaveProperty("description");
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

describe("decideBoardEdit", () => {
  const board = (patch: Partial<BoardDoc> = {}): BoardDoc => ({
    ownerUid: "u1",
    ownerEmail: "owner@x.io",
    title: "Retro",
    visibility: "private",
    editors: [],
    viewers: [],
    ...patch,
  });
  const writeBinding = { boardId: "b1", role: "write" as const };
  const decide = (
    params: Partial<Parameters<typeof decideBoardEdit>[0]> = {},
  ) =>
    decideBoardEdit({
      identity: owner,
      board: board(),
      team: null,
      isFirstClass: true,
      binding: writeBinding,
      ...params,
    });

  it("lets the owner's bot with a write binding edit", () => {
    expect(decide()).toEqual({ allowed: true });
  });

  it("hides boards the bot cannot reach", () => {
    expect(decide({ board: null })).toMatchObject({ denial: "no_access" });
    expect(decide({ binding: undefined })).toMatchObject({
      denial: "no_access",
    });
    expect(decide({ board: board({ botPolicy: "none" }) })).toMatchObject({
      denial: "no_access",
    });
  });

  it("treats a read binding or a read-only bot policy as read-only", () => {
    expect(
      decide({ binding: { boardId: "b1", role: "read" } }),
    ).toMatchObject({ denial: "read_only" });
    expect(decide({ board: board({ botPolicy: "read" }) })).toMatchObject({
      denial: "read_only",
    });
  });

  it("refuses an invited editor's bot: only the owner can change settings", () => {
    const decision = decide({
      identity: { uid: "u2", email: "editor@x.io" },
      board: board({ editors: ["editor@x.io"] }),
    });
    expect(decision).toMatchObject({ allowed: false, denial: "not_manager" });
  });

  it("lets a team admin edit a team board, but not a team editor", () => {
    const team = {
      admins: ["admin@x.io"],
      editorEmails: ["editor@x.io"],
      viewerEmails: [],
    };
    const teamBoard = board({ visibility: "team" });
    expect(
      decide({
        identity: { uid: "u3", email: "admin@x.io" },
        board: teamBoard,
        team,
      }),
    ).toEqual({ allowed: true });
    expect(
      decide({
        identity: { uid: "u2", email: "editor@x.io" },
        board: teamBoard,
        team,
      }),
    ).toMatchObject({ denial: "not_manager" });
  });

  it("does not let a team admin edit someone's private board", () => {
    const team = { admins: ["admin@x.io"], editorEmails: [], viewerEmails: [] };
    expect(
      decide({
        identity: { uid: "u3", email: "admin@x.io" },
        board: board({ editors: ["admin@x.io"] }),
        team,
      }),
    ).toMatchObject({ denial: "not_manager" });
  });

  it("keeps legacy account-wide tokens on the account's own access", () => {
    expect(decide({ isFirstClass: false, binding: undefined })).toEqual({
      allowed: true,
    });
  });
});

describe("setBoardDescriptionForBot", () => {
  const call = (description: string, boardId = "b1") =>
    setBoardDescriptionForBot({
      identity: owner,
      boardId,
      description,
      isFirstClass: true,
      binding: { boardId, role: "write" },
    });

  beforeEach(() => {
    state.boards.set("b1", {
      ownerUid: "u1",
      title: "Retro",
      visibility: "private",
      editors: [],
      viewers: [],
    });
  });

  it("writes the normalized description", async () => {
    const result = await call("  What went\nwell ");
    expect(result).toEqual({
      boardId: "b1",
      title: "Retro",
      description: "What went well",
    });
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]).toMatchObject({
      collection: "boards",
      id: "b1",
      data: { description: "What went well" },
    });
  });

  it("removes the field when the description is emptied", async () => {
    const result = await call("   ");
    expect(result.description).toBeNull();
    const written = state.updates[0].data.description as FieldValue;
    expect(written.isEqual(FieldValue.delete())).toBe(true);
  });

  it("refuses without writing when the bot cannot reach the board", async () => {
    await expect(call("x", "missing")).rejects.toBeInstanceOf(
      BotAccessDeniedError,
    );
    expect(state.updates).toHaveLength(0);
  });

  it("refuses without writing on a read-only binding", async () => {
    await expect(
      setBoardDescriptionForBot({
        identity: owner,
        boardId: "b1",
        description: "x",
        isFirstClass: true,
        binding: { boardId: "b1", role: "read" },
      }),
    ).rejects.toBeInstanceOf(ReadOnlyError);
    expect(state.updates).toHaveLength(0);
  });

  it("refuses without writing when the account does not manage the board", async () => {
    state.boards.set("b1", {
      ownerUid: "someone-else",
      title: "Theirs",
      visibility: "private",
      editors: ["owner@x.io"],
      viewers: [],
    });
    await expect(call("x")).rejects.toBeInstanceOf(BoardEditDeniedError);
    expect(state.updates).toHaveLength(0);
  });
});

describe("renameBoardForBot", () => {
  const call = (title: string, boardId = "b1") =>
    renameBoardForBot({
      identity: owner,
      boardId,
      title,
      isFirstClass: true,
      binding: { boardId, role: "write" },
    });

  beforeEach(() => {
    state.boards.set("b1", {
      ownerUid: "u1",
      title: "Retro",
      visibility: "private",
      editors: [],
      viewers: [],
    });
  });

  it("writes the normalized title and reports the previous one", async () => {
    const result = await call("  Retro\n Q4 ");
    expect(result).toEqual({
      boardId: "b1",
      title: "Retro Q4",
      previousTitle: "Retro",
    });
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]).toMatchObject({
      collection: "boards",
      id: "b1",
      data: { title: "Retro Q4" },
    });
  });

  it("refuses an empty name without writing", async () => {
    await expect(call("   ")).rejects.toBeInstanceOf(BoardEditDeniedError);
    expect(state.updates).toHaveLength(0);
  });

  it("refuses without writing when the bot cannot reach the board", async () => {
    await expect(call("x", "missing")).rejects.toBeInstanceOf(
      BotAccessDeniedError,
    );
    expect(state.updates).toHaveLength(0);
  });

  it("refuses without writing when the account does not manage the board", async () => {
    state.boards.set("b1", {
      ownerUid: "someone-else",
      title: "Theirs",
      visibility: "private",
      editors: ["owner@x.io"],
      viewers: [],
    });
    await expect(call("x")).rejects.toBeInstanceOf(BoardEditDeniedError);
    expect(state.updates).toHaveLength(0);
  });
});
