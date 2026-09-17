import {beforeEach, describe, expect, it, vi} from "vitest";

import {
  createFolderForBot,
  decideBotFolderAccess,
  fileBoardInFolder,
  FolderPermissionDeniedError,
  getFolder,
  listFolders,
  MAX_FOLDERS_PER_OWNER,
  normalizeFolderName,
} from "../folders";

import type {BotDoc} from "../bots";

type FolderData = { name?: string; boardIds?: string[] };
type BatchOp = { path: string; data: Record<string, unknown> };

const { state } = vi.hoisted(() => ({
  state: {
    folders: new Map<string, { name?: string; boardIds?: string[] }>(),
    sets: [] as { path: string; data: Record<string, unknown> }[],
    ops: [] as { path: string; data: Record<string, unknown> }[],
    committed: 0,
    lastCollectionPath: "",
  },
}));

vi.mock("firebase-admin/firestore", () => ({
  FieldValue: {
    arrayUnion: (...items: unknown[]) => ({ __union: items }),
    arrayRemove: (...items: unknown[]) => ({ __remove: items }),
  },
}));

vi.mock("../firebase", () => {
  const folderRef = (path: string, id: string) => ({
    id,
    path: `${path}/${id}`,
    get: async () => ({
      exists: state.folders.has(id),
      data: () => state.folders.get(id),
    }),
    set: async (data: Record<string, unknown>) => {
      state.sets.push({ path: `${path}/${id}`, data });
      state.folders.set(id, data as FolderData);
    },
  });
  const foldersCollection = (path: string) => {
    state.lastCollectionPath = path;
    return {
      doc: (id?: string) => folderRef(path, id ?? "generated-id"),
      get: async () => ({
        docs: [...state.folders.entries()].map(([id, data]) => ({
          id,
          data: () => data,
        })),
      }),
    };
  };
  return {
    db: () => ({
      collection: (root: string) => ({
        doc: (uid: string) => ({
          collection: (sub: string) =>
            foldersCollection(`${root}/${uid}/${sub}`),
        }),
      }),
      batch: () => {
        const staged: BatchOp[] = [];
        return {
          update: (ref: { path: string }, data: Record<string, unknown>) => {
            staged.push({ path: ref.path, data });
          },
          commit: async () => {
            state.ops.push(...staged);
            state.committed += 1;
          },
        };
      },
    }),
  };
});

const identity = { uid: "u1", email: "u@x.io" } as any;

const bot = (patch: Partial<BotDoc> = {}): BotDoc => ({
  ownerUid: "u1",
  canCreateBoards: true,
  canCreateFolders: true,
  ...patch,
});

beforeEach(() => {
  state.folders = new Map();
  state.sets = [];
  state.ops = [];
  state.committed = 0;
});

describe("decideBotFolderAccess", () => {
  it("allows a bot with both the parent and the sub-permission", () => {
    expect(decideBotFolderAccess(true, bot())).toEqual({ allowed: true });
  });

  it("denies when the sub-permission is off", () => {
    const decision = decideBotFolderAccess(
      true,
      bot({ canCreateFolders: false }),
    );
    expect(decision.allowed).toBe(false);
    expect((decision as { reason: string }).reason).toContain("Create folders");
  });

  it("treats the sub-permission as off while 'Create boards' is off", () => {
    const decision = decideBotFolderAccess(
      true,
      bot({ canCreateBoards: false, canCreateFolders: true }),
    );
    expect(decision.allowed).toBe(false);
    expect((decision as { reason: string }).reason).toContain("Create boards");
  });

  it("denies disabled bots and tokens without a bot", () => {
    expect(decideBotFolderAccess(true, bot({ disabled: true })).allowed).toBe(
      false,
    );
    expect(decideBotFolderAccess(false, null).allowed).toBe(false);
  });
});

describe("normalizeFolderName", () => {
  it("collapses whitespace and caps the length at the rules' limit", () => {
    expect(normalizeFolderName("  Q4   planning ")).toBe("Q4 planning");
    expect(normalizeFolderName("x".repeat(200))).toHaveLength(60);
    expect(normalizeFolderName(undefined)).toBe("");
  });
});

describe("createFolderForBot", () => {
  it("writes exactly the rule-approved keys under the owner's subcollection", async () => {
    const created = await createFolderForBot({
      identity,
      botId: "bot1",
      name: "  Backend ",
    });
    expect(created).toEqual({
      folderId: "generated-id",
      name: "Backend",
      created: true,
    });
    expect(state.sets).toHaveLength(1);
    expect(state.sets[0].path).toBe("users/u1/folders/generated-id");
    expect(Object.keys(state.sets[0].data).sort()).toEqual([
      "boardIds",
      "createdAt",
      "name",
      "updatedAt",
    ]);
    expect(state.sets[0].data.boardIds).toEqual([]);
  });

  it("reuses an existing folder with the same name, ignoring case", async () => {
    state.folders.set("f1", { name: "Backend", boardIds: ["b"] });
    const created = await createFolderForBot({
      identity,
      botId: "bot1",
      name: "backend",
    });
    expect(created).toEqual({ folderId: "f1", name: "Backend", created: false });
    expect(state.sets).toHaveLength(0);
  });

  it("rejects an empty name and an account that is already full", async () => {
    await expect(
      createFolderForBot({ identity, botId: "bot1", name: "   " }),
    ).rejects.toBeInstanceOf(FolderPermissionDeniedError);

    for (let index = 0; index < MAX_FOLDERS_PER_OWNER; index++) {
      state.folders.set(`f${index}`, { name: `Folder ${index}` });
    }
    await expect(
      createFolderForBot({ identity, botId: "bot1", name: "One more" }),
    ).rejects.toThrow(/already has/);
    expect(state.sets).toHaveLength(0);
  });

  it("refuses a token with no account", async () => {
    await expect(
      createFolderForBot({
        identity: { uid: null, email: null } as any,
        botId: "bot1",
        name: "X",
      }),
    ).rejects.toBeInstanceOf(FolderPermissionDeniedError);
  });
});

describe("listFolders / getFolder", () => {
  it("lists sorted summaries with defaults filled in", async () => {
    state.folders.set("f2", { name: "zeta", boardIds: ["b2"] });
    state.folders.set("f1", { name: "Alpha" });
    expect(await listFolders(identity)).toEqual([
      { folderId: "f1", name: "Alpha", boardIds: [] },
      { folderId: "f2", name: "zeta", boardIds: ["b2"] },
    ]);
  });

  it("returns null for a folder id the account does not have", async () => {
    state.folders.set("f1", { name: "Alpha" });
    expect(await getFolder(identity, "nope")).toBeNull();
    expect(await getFolder(identity, "f1")).toMatchObject({ name: "Alpha" });
  });
});

describe("fileBoardInFolder", () => {
  it("adds to the target and pulls the board out of other folders atomically", async () => {
    state.folders.set("f1", { name: "A", boardIds: ["b1"] });
    state.folders.set("f2", { name: "B", boardIds: [] });
    state.folders.set("f3", { name: "C", boardIds: ["other"] });

    await fileBoardInFolder(identity, "f2", "b1");

    expect(state.committed).toBe(1);
    expect(
      state.ops.map((op) => [op.path, op.data.boardIds]),
    ).toEqual([
      ["users/u1/folders/f1", { __remove: ["b1"] }],
      ["users/u1/folders/f2", { __union: ["b1"] }],
    ]);
  });
});
