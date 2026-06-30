import {describe, expect, it} from "vitest";

import {evaluateAccess} from "../policy";
import type {BoardDoc, Identity, TeamDoc} from "../types";

const owner: Identity = { uid: "owner-uid", email: "owner@x.io" };
const member: Identity = { uid: "m-uid", email: "member@x.io" };
const stranger: Identity = { uid: "s-uid", email: "stranger@x.io" };
const anon: Identity = { uid: null, email: null };

const team: TeamDoc = {
  name: "T",
  admins: ["admin@x.io"],
  editorEmails: ["teameditor@x.io"],
  viewerEmails: ["teamviewer@x.io"],
};

const board = (extra: Partial<BoardDoc>): BoardDoc => ({
  ownerUid: "owner-uid",
  ownerEmail: "owner@x.io",
  ...extra,
});

const human = (i: Identity, b: BoardDoc | null, t: TeamDoc | null = null) =>
  evaluateAccess(i, b, t, false);

describe("evaluateAccess — new model", () => {
  it("private: owner writes, everyone else denied", () => {
    const b = board({ visibility: "private", editors: [], viewers: [] });
    expect(human(owner, b)).toEqual({ canRead: true, canWrite: true });
    expect(human(stranger, b)).toEqual({ canRead: false, canWrite: false });
  });

  it("private: invited editor writes, invited viewer reads only", () => {
    const b = board({
      visibility: "private",
      editors: ["member@x.io"],
      viewers: ["teamviewer@x.io"],
    });
    expect(human(member, b)).toEqual({ canRead: true, canWrite: true });
    expect(human({ uid: "v", email: "teamviewer@x.io" }, b)).toEqual({
      canRead: true,
      canWrite: false,
    });
  });

  it("link: anyone reads, nobody but owner/invited-editor writes", () => {
    const b = board({ visibility: "link", editors: [], viewers: [] });
    expect(human(stranger, b)).toEqual({ canRead: true, canWrite: false });
    expect(human(anon, b)).toEqual({ canRead: true, canWrite: false });
    expect(human(owner, b)).toEqual({ canRead: true, canWrite: true });
  });

  it("team: editors/admins write, viewers read, non-members denied", () => {
    const b = board({ visibility: "team", editors: [], viewers: [] });
    expect(human({ uid: "a", email: "admin@x.io" }, b, team)).toEqual({
      canRead: true,
      canWrite: true,
    });
    expect(human({ uid: "e", email: "teameditor@x.io" }, b, team)).toEqual({
      canRead: true,
      canWrite: true,
    });
    expect(human({ uid: "v", email: "teamviewer@x.io" }, b, team)).toEqual({
      canRead: true,
      canWrite: false,
    });
    expect(human(stranger, b, team)).toEqual({
      canRead: false,
      canWrite: false,
    });
  });
});

describe("evaluateAccess — missing board", () => {
  it("is open for humans (legacy link share) but denied for bots", () => {
    expect(evaluateAccess(stranger, null, null, false)).toEqual({
      canRead: true,
      canWrite: true,
    });
    expect(evaluateAccess(stranger, null, null, true)).toEqual({
      canRead: false,
      canWrite: false,
    });
  });
});

describe("evaluateAccess — bot policy capping", () => {
  const b = board({ visibility: "private", editors: ["member@x.io"] });
  it("none denies, read strips write, write keeps full", () => {
    expect(
      evaluateAccess(member, { ...b, botPolicy: "none" }, null, true),
    ).toEqual({ canRead: false, canWrite: false });
    expect(
      evaluateAccess(member, { ...b, botPolicy: "read" }, null, true),
    ).toEqual({ canRead: true, canWrite: false });
    expect(
      evaluateAccess(member, { ...b, botPolicy: "write" }, null, true),
    ).toEqual({ canRead: true, canWrite: true });
  });
});

describe("evaluateAccess — legacy boards (no visibility)", () => {
  it("readPolicy public grants read; writePolicy owner keeps writes owner-only", () => {
    const b = board({
      readPolicy: "public",
      writePolicy: "owner",
      editors: [],
    });
    expect(human(stranger, b)).toEqual({ canRead: true, canWrite: false });
    expect(human(owner, b)).toEqual({ canRead: true, canWrite: true });
  });

  it("legacy team editor cannot write an owner-only board", () => {
    const b = board({
      readPolicy: "members",
      writePolicy: "owner",
      teamId: "chats-team",
    });
    expect(human({ uid: "e", email: "teameditor@x.io" }, b, team)).toEqual({
      canRead: true,
      canWrite: false,
    });
  });

  it("legacy whitelist editor writes only under whitelist policy", () => {
    const b = board({ writePolicy: "whitelist", editors: ["member@x.io"] });
    expect(human(member, b)).toEqual({ canRead: true, canWrite: true });
  });
});
