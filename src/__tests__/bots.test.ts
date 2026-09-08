import {beforeEach, describe, expect, it, vi} from "vitest";
import {
  bindingFor,
  decideBotBoardAccess,
  decideBotBoardCreation,
  getBot,
  getOwnedBot,
} from "../bots";
import {createToken, getToken, listTokens, revokeToken, touchToken,} from "../tokens";

const { store } = vi.hoisted(() => ({
  store: new Map<string, Map<string, Record<string, unknown>>>(),
}));

vi.mock("../firebase", () => {
  const col = (name: string) => {
    if (!store.has(name)) {
      store.set(name, new Map());
    }
    const documents = store.get(name)!;
    return {
      doc: (id: string) => ({
        set: async (data: Record<string, unknown>) => {
          documents.set(id, { ...data });
        },
        get: async () => ({
          exists: documents.has(id),
          data: () => documents.get(id),
        }),
        update: async (patch: Record<string, unknown>) => {
          if (!documents.has(id)) {
            throw new Error("No document to update");
          }
          documents.set(id, { ...documents.get(id), ...patch });
        },
      }),
      where: (field: string, _op: string, value: unknown) => ({
        get: async () => ({
          docs: [...documents.entries()]
            .filter(([, data]) => data[field] === value)
            .map(([id, data]) => ({ id, data: () => data })),
        }),
      }),
    };
  };
  return { db: () => ({ collection: col }) };
});

const seedBot = (id: string, data: Record<string, unknown>): void => {
  if (!store.has("bots")) {
    store.set("bots", new Map());
  }
  store.get("bots")!.set(id, data);
};

beforeEach(() => {
  store.clear();
});

describe("decideBotBoardAccess", () => {
  const rw = { canRead: true, canWrite: true };

  it("first-class bot: board not on allow-list → denied", () => {
    expect(decideBotBoardAccess(true, undefined, rw)).toEqual({
      allowed: false,
    });
  });

  it("first-class bot: read binding caps an editor board to viewer", () => {
    expect(
      decideBotBoardAccess(true, { boardId: "b", role: "read" }, rw),
    ).toEqual({ allowed: true, role: "viewer" });
  });

  it("first-class bot: write binding keeps editor when ACL allows write", () => {
    expect(
      decideBotBoardAccess(true, { boardId: "b", role: "write" }, rw),
    ).toEqual({ allowed: true, role: "editor" });
  });

  it("write binding still capped to viewer when ACL is read-only", () => {
    expect(
      decideBotBoardAccess(true, { boardId: "b", role: "write" }, {
        canRead: true,
        canWrite: false,
      }),
    ).toEqual({ allowed: true, role: "viewer" });
  });

  it("no read access → denied regardless of binding", () => {
    expect(
      decideBotBoardAccess(true, { boardId: "b", role: "write" }, {
        canRead: false,
        canWrite: false,
      }),
    ).toEqual({ allowed: false });
  });

  it("legacy token (not first-class): account-wide, no allow-list gate", () => {
    expect(decideBotBoardAccess(false, undefined, rw)).toEqual({
      allowed: true,
      role: "editor",
    });
  });
});

describe("decideBotBoardCreation", () => {
  const allowed = { ownerUid: "u", canCreateBoards: true };

  it("allows a bot whose owner granted the permission", () => {
    expect(decideBotBoardCreation(true, allowed)).toEqual({ allowed: true });
  });

  it("denies a bot without the permission, explaining how to grant it", () => {
    const decision = decideBotBoardCreation(true, { ownerUid: "u" });
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toContain(
      "Create boards",
    );
  });

  it("denies an explicit false and a disabled bot", () => {
    expect(
      decideBotBoardCreation(true, { ownerUid: "u", canCreateBoards: false }),
    ).toMatchObject({ allowed: false });
    expect(
      decideBotBoardCreation(true, { ...allowed, disabled: true }),
    ).toMatchObject({ allowed: false });
  });

  it("denies legacy account-wide tokens, which have no bot to configure", () => {
    expect(decideBotBoardCreation(false, null)).toMatchObject({
      allowed: false,
    });
    expect(decideBotBoardCreation(true, null)).toMatchObject({
      allowed: false,
    });
  });
});

describe("bindingFor", () => {
  const bot = {
    ownerUid: "u",
    boards: [
      { boardId: "b1", role: "write" as const },
      { boardId: "b2", role: "read" as const },
    ],
  };

  it("returns the matching binding", () => {
    expect(bindingFor(bot, "b2")).toEqual({ boardId: "b2", role: "read" });
  });

  it("returns undefined for an unlisted board or a null bot", () => {
    expect(bindingFor(bot, "b3")).toBeUndefined();
    expect(bindingFor(null, "b1")).toBeUndefined();
  });
});

describe("getBot / getOwnedBot", () => {
  it("loads an existing bot and enforces ownership", async () => {
    seedBot("bot1", { ownerUid: "owner", name: "Helper" });
    expect(await getBot("bot1")).toMatchObject({ ownerUid: "owner" });
    expect(await getOwnedBot("bot1", "owner")).toMatchObject({ name: "Helper" });
    expect(await getOwnedBot("bot1", "someone-else")).toBeNull();
    expect(await getOwnedBot("missing", "owner")).toBeNull();
  });
});

describe("tokens data layer", () => {
  it("createToken persists botId + name and omits them when absent", async () => {
    const scoped = await createToken({
      uid: "u",
      email: "u@x.io",
      botId: "bot1",
      name: "ci",
    });
    expect(scoped.doc).toMatchObject({
      uid: "u",
      botId: "bot1",
      name: "ci",
      revoked: false,
    });

    const bare = await createToken({ uid: "u", email: null });
    expect(bare.doc.botId).toBeUndefined();
    expect(bare.doc.name).toBeUndefined();
  });

  it("listTokens scopes to uid and filters by botId", async () => {
    await createToken({ uid: "u", email: null, botId: "bot1", name: "a" });
    await createToken({ uid: "u", email: null, botId: "bot2", name: "b" });
    await createToken({ uid: "other", email: null, botId: "bot1" });

    expect(await listTokens({ uid: "u" })).toHaveLength(2);
    const scoped = await listTokens({ uid: "u", botId: "bot1" });
    expect(scoped).toHaveLength(1);
    expect(scoped[0].doc.name).toBe("a");
  });

  it("revokeToken flips the revoked flag; touchToken sets lastUsedAt", async () => {
    const { token } = await createToken({
      uid: "u",
      email: null,
      botId: "bot1",
    });
    await revokeToken(token);
    expect((await getToken(token))?.revoked).toBe(true);

    await touchToken(token);
    expect(typeof (await getToken(token))?.lastUsedAt).toBe("number");
  });
});
