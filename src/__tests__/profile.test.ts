import {beforeEach, describe, expect, it, vi} from "vitest";

import {
  DEFAULT_PROFILE,
  fontSizeFor,
  isOnTypeScale,
  loadProfile,
  nearestScaleSize,
  profileScopeId,
  resolveProfile,
  saveProfile,
  typeScaleSizes,
  validateProfile,
  type BoardProfile,
} from "../profile";
import {ToolError} from "../engine/errors";

const { state } = vi.hoisted(() => ({
  state: {
    docs: new Map<string, Record<string, unknown>>(),
    sets: [] as { id: string; data: Record<string, unknown> }[],
    collections: [] as string[],
  },
}));

vi.mock("../firebase", () => ({
  db: () => ({
    collection: (name: string) => {
      state.collections.push(name);
      return {
        doc: (id: string) => ({
          id,
          get: async () => ({
            exists: state.docs.has(id),
            data: () => state.docs.get(id),
          }),
          set: async (data: Record<string, unknown>) => {
            state.sets.push({ id, data });
            state.docs.set(id, data);
          },
        }),
      };
    },
  }),
}));

beforeEach(() => {
  state.docs.clear();
  state.sets.length = 0;
  state.collections.length = 0;
});

const expectInvalidArgs = (run: () => unknown): ToolError => {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ToolError);
  expect((caught as ToolError).code).toBe("invalid_args");
  return caught as ToolError;
};

describe("profileScopeId", () => {
  it("names a board scope, a folder scope, and prefers the board", () => {
    expect(profileScopeId({ boardId: "b1" })).toBe("board:b1");
    expect(profileScopeId({ folderId: "f1" })).toBe("folder:f1");
    expect(profileScopeId({ boardId: "b1", folderId: "f1" })).toBe("board:b1");
  });

  it("rejects an empty scope", () => {
    expectInvalidArgs(() => profileScopeId({}));
  });
});

describe("validateProfile", () => {
  it("accepts the shape from the guide", () => {
    const profile = validateProfile({
      roles: { accent: { tag: "[YOU]" }, process: { tag: "[SDK]", meaning: "the SDK" } },
      strokeStyles: { dashed: "[planned]" },
      typeScale: { title: 36, colHeader: 20, body: 16 },
      spacing: { unit: 8, cellPadding: 12 },
      nowrap: ["auto-\\w+ · \\d+"],
    });
    expect(profile.roles?.accent.tag).toBe("[YOU]");
    expect(profile.typeScale).toEqual({ title: 36, colHeader: 20, body: 16 });
  });

  it("rejects font sizes outside 8..72", () => {
    expect(expectInvalidArgs(() => validateProfile({ typeScale: { body: 4 } })).details?.field).toBe("typeScale.body");
    expectInvalidArgs(() => validateProfile({ typeScale: { title: 100 } }));
  });

  it("rejects negative spacing", () => {
    expect(expectInvalidArgs(() => validateProfile({ spacing: { unit: -1 } })).details?.field).toBe("spacing.unit");
  });

  it("rejects a nowrap entry that is not a regex", () => {
    expect(expectInvalidArgs(() => validateProfile({ nowrap: ["auto-("] })).details?.field).toBe("nowrap[0]");
  });

  it("rejects a role name that is not in the palette", () => {
    const error = expectInvalidArgs(() => validateProfile({ roles: { sdk: { tag: "[SDK]" } } }));
    expect(error.message).toContain("unknown role");
  });

  it("rejects an unknown strokeStyle and an unknown top-level field", () => {
    expectInvalidArgs(() => validateProfile({ strokeStyles: { wavy: "[maybe]" } }));
    expectInvalidArgs(() => validateProfile({ typeScale: { subtitle: 20 } }));
    expectInvalidArgs(() => validateProfile({ palette: {} }));
  });
});

describe("saveProfile / loadProfile", () => {
  it("round-trips a profile through its own collection", async () => {
    const saved = await saveProfile({ boardId: "b1" }, { typeScale: { body: 18 } });
    expect(state.collections).toContain("boardProfiles");
    expect(state.sets[0].id).toBe("board:b1");
    expect(saved.typeScale).toEqual({ body: 18 });
    expect(saved.updatedAt).toBeTypeOf("number");
    await expect(loadProfile({ boardId: "b1" })).resolves.toMatchObject({ typeScale: { body: 18 } });
  });

  it("merges: a second save changes only what it passes", async () => {
    await saveProfile(
      { boardId: "b1" },
      { typeScale: { colHeader: 20, body: 16 }, roles: { accent: { tag: "[YOU]" } }, nowrap: ["a·b"] },
    );
    const merged = await saveProfile(
      { boardId: "b1" },
      { typeScale: { body: 18 }, roles: { process: { tag: "[SDK]" } } },
    );
    expect(merged.typeScale).toEqual({ colHeader: 20, body: 18 });
    expect(merged.roles).toEqual({ accent: { tag: "[YOU]" }, process: { tag: "[SDK]" } });
    expect(merged.nowrap).toEqual(["a·b"]);
  });

  it("replaces nowrap as a whole, because it is one ordered list", async () => {
    await saveProfile({ boardId: "b1" }, { nowrap: ["one", "two"] });
    const merged = await saveProfile({ boardId: "b1" }, { nowrap: ["three"] });
    expect(merged.nowrap).toEqual(["three"]);
  });

  it("does not write anything when the patch is invalid", async () => {
    await expect(saveProfile({ boardId: "b1" }, { spacing: { unit: -5 } } as BoardProfile)).rejects.toBeInstanceOf(
      ToolError,
    );
    expect(state.sets).toEqual([]);
  });

  it("falls back to the folder profile, and prefers the board's own", async () => {
    await saveProfile({ folderId: "f1" }, { typeScale: { body: 14 } });
    await expect(loadProfile({ boardId: "b1", folderId: "f1" })).resolves.toMatchObject({
      typeScale: { body: 14 },
    });
    await saveProfile({ boardId: "b1" }, { typeScale: { body: 20 } });
    await expect(loadProfile({ boardId: "b1", folderId: "f1" })).resolves.toMatchObject({
      typeScale: { body: 20 },
    });
  });

  it("returns null without a folder to fall back to", async () => {
    await saveProfile({ folderId: "f1" }, { typeScale: { body: 14 } });
    await expect(loadProfile({ boardId: "b1" })).resolves.toBeNull();
    await expect(loadProfile({ boardId: "b1", folderId: "other" })).resolves.toBeNull();
  });
});

describe("resolveProfile and the type scale", () => {
  it("fills in every default", () => {
    const resolved = resolveProfile(null);
    expect(resolved.typeScale).toEqual(DEFAULT_PROFILE.typeScale);
    expect(resolved.spacing).toEqual(DEFAULT_PROFILE.spacing);
    expect(resolved.roles).toEqual({});
    expect(resolved.nowrap).toEqual([]);
  });

  it("keeps the profile's own steps and defaults the rest", () => {
    const resolved = resolveProfile({ typeScale: { body: 18 } });
    expect(resolved.typeScale.body).toBe(18);
    expect(resolved.typeScale.colHeader).toBe(DEFAULT_PROFILE.typeScale.colHeader);
  });

  it("fontSizeFor falls back to the defaults", () => {
    expect(fontSizeFor(null, "body")).toBe(16);
    expect(fontSizeFor({ typeScale: { colHeader: 22 } }, "colHeader")).toBe(22);
    expect(fontSizeFor({ typeScale: { colHeader: 22 } }, "body")).toBe(16);
  });

  it("lists distinct sizes ascending and finds the nearest step", () => {
    const profile: BoardProfile = { typeScale: { title: 36, colHeader: 20, body: 16, caption: 14, code: 14 } };
    expect(typeScaleSizes(profile)).toEqual([14, 16, 20, 36]);
    expect(nearestScaleSize(profile, 18)).toBe(20); // a tie goes to the larger step
    expect(nearestScaleSize(profile, 17)).toBe(16);
    expect(nearestScaleSize({}, 17)).toBeUndefined();
  });

  it("tolerates 1px off a step, but not 2", () => {
    const profile: BoardProfile = { typeScale: { body: 16 } };
    expect(isOnTypeScale(profile, 16)).toBe(true);
    expect(isOnTypeScale(profile, 17)).toBe(true);
    expect(isOnTypeScale(profile, 18)).toBe(false);
    // A profile that pins no sizes constrains nothing.
    expect(isOnTypeScale({}, 18)).toBe(true);
  });
});
