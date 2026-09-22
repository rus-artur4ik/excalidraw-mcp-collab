import { createHash, createHmac } from "crypto";
import { promises as fs } from "fs";
import os from "os";
import path from "path";

import express from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { AddressInfo } from "net";
import type { Server } from "http";

type ExportsModule = typeof import("../exports");

const SECRET = "exports-test-secret";
const BOARD = "board-alpha";
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const SVG_BYTES = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>', "utf8");

let dataDir: string;
let exports_: ExportsModule;

const exportsDir = (): string => path.join(dataDir, "exports");

// The module signs `id|boardId|format|exp`; re-deriving it here is what lets a
// test forge "same link, different board" and prove the binding holds.
const signature = (id: string, boardId: string, format: string, exp: number): string =>
  createHmac("sha256", SECRET).update(`${id}|${boardId}|${format}|${exp}`).digest("base64url");

const tokenParts = (token: string) => {
  const [id, format, exp, sig] = token.split(".");
  return { id, format, exp, sig, expSeconds: parseInt(exp, 36) };
};

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "excalidraw-exports-"));
  process.env.DATA_DIR = dataDir;
  process.env.INTERNAL_SECRET = SECRET;
  process.env.PUBLIC_BASE_URL = "";
  // config reads the environment at import time, so the module has to come in
  // after DATA_DIR is set.
  exports_ = await import("../exports");
});

afterAll(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("export storage", () => {
  it("round-trips the bytes and reports their digest", async () => {
    const stored = await exports_.storeExport({ boardId: BOARD, data: PNG_BYTES, format: "png" });

    expect(stored.bytes).toBe(PNG_BYTES.length);
    expect(stored.sha256).toBe(createHash("sha256").update(PNG_BYTES).digest("hex"));
    expect(stored.url).toBe(`/exports/${stored.token}`);
    expect(Date.parse(stored.expiresAt)).toBeGreaterThan(Date.now());

    const read = await exports_.readExport(stored.token);
    expect(read).not.toBeNull();
    expect(read!.data.equals(PNG_BYTES)).toBe(true);
    expect(read!.contentType).toBe("image/png");
    expect(createHash("sha256").update(read!.data).digest("hex")).toBe(stored.sha256);
  });

  it("serves svg exports as svg", async () => {
    const stored = await exports_.storeExport({ boardId: BOARD, data: SVG_BYTES, format: "svg" });
    const read = await exports_.readExport(stored.token);
    expect(read!.contentType).toBe("image/svg+xml; charset=utf-8");
    expect(read!.data.toString("utf8")).toBe(SVG_BYTES.toString("utf8"));
  });

  it("keeps the board id out of the link", async () => {
    const stored = await exports_.storeExport({ boardId: BOARD, data: PNG_BYTES, format: "png" });
    expect(stored.url).not.toContain(BOARD);
    expect(stored.token).not.toContain(BOARD);
  });

  it("defaults to a day and caps the ttl at a week", async () => {
    const now = Date.now();
    const byDefault = await exports_.storeExport({ boardId: BOARD, data: PNG_BYTES, format: "png" });
    const capped = await exports_.storeExport({
      boardId: BOARD,
      data: PNG_BYTES,
      format: "png",
      ttlSeconds: 90 * 24 * 60 * 60,
    });

    const dayFromNow = now + exports_.DEFAULT_TTL_SECONDS * 1000;
    expect(Math.abs(Date.parse(byDefault.expiresAt) - dayFromNow)).toBeLessThan(5_000);
    const weekFromNow = now + exports_.MAX_TTL_SECONDS * 1000;
    expect(Math.abs(Date.parse(capped.expiresAt) - weekFromNow)).toBeLessThan(5_000);
  });

  it("gives two exports of identical bytes separate links and separate files", async () => {
    const first = await exports_.storeExport({ boardId: BOARD, data: PNG_BYTES, format: "png" });
    const second = await exports_.storeExport({ boardId: BOARD, data: PNG_BYTES, format: "png" });

    expect(first.sha256).toBe(second.sha256);
    expect(first.token).not.toBe(second.token);
    expect(tokenParts(first.token).id).not.toBe(tokenParts(second.token).id);

    await fs.unlink(path.join(exportsDir(), tokenParts(first.token).id));
    expect(await exports_.readExport(first.token)).toBeNull();
    expect((await exports_.readExport(second.token))!.data.equals(PNG_BYTES)).toBe(true);
  });

  it("rejects an empty board id and an oversized payload", async () => {
    await expect(
      exports_.storeExport({ boardId: "  ", data: PNG_BYTES, format: "png" }),
    ).rejects.toMatchObject({ code: "invalid_args" });
    await expect(
      exports_.storeExport({
        boardId: BOARD,
        data: Buffer.alloc(exports_.MAX_EXPORT_BYTES + 1),
        format: "png",
      }),
    ).rejects.toMatchObject({ code: "too_large" });
  });
});

describe("export links expire", () => {
  it("reads as null once the ttl has passed", async () => {
    const stored = await exports_.storeExport({
      boardId: BOARD,
      data: PNG_BYTES,
      format: "png",
      ttlSeconds: 60,
    });

    expect(await exports_.readExport(stored.token)).not.toBeNull();
    expect(await exports_.readExport(stored.token, Date.now() + 61_000)).toBeNull();
  });
});

describe("export tokens are tamper-evident", () => {
  it("refuses a token that has been edited in any part", async () => {
    const stored = await exports_.storeExport({ boardId: BOARD, data: PNG_BYTES, format: "png" });
    const { id, format, exp, sig, expSeconds } = tokenParts(stored.token);

    // Sanity check that the test derives the same signature the module does.
    expect(signature(id, BOARD, format, expSeconds)).toBe(sig);

    const otherId = `${id.slice(0, -1)}${id.endsWith("A") ? "B" : "A"}`;
    expect(await exports_.readExport(`${otherId}.${format}.${exp}.${sig}`)).toBeNull();

    // Claimed format swapped.
    expect(await exports_.readExport(`${id}.svg.${exp}.${sig}`)).toBeNull();

    // Expiry pushed out.
    const later = expSeconds + 3600;
    expect(await exports_.readExport(`${id}.${format}.${later.toString(36)}.${sig}`)).toBeNull();
    expect(
      await exports_.readExport(
        `${id}.${format}.${later.toString(36)}.${signature(id, BOARD, format, later)}`,
      ),
    ).toBeNull();

    // Signature truncated, and a signature minted over a different board.
    expect(await exports_.readExport(`${id}.${format}.${exp}.${sig.slice(0, 20)}`)).toBeNull();
    expect(
      await exports_.readExport(
        `${id}.${format}.${exp}.${signature(id, "board-beta", format, expSeconds)}`,
      ),
    ).toBeNull();
  });

  it("refuses malformed tokens, including path traversal attempts", async () => {
    for (const token of [
      "",
      "nonsense",
      "..%2F..%2Fetc%2Fpasswd",
      "../../config.json.png.1.aaaaaaaaaaaaaaaaaaaa",
      "a.png.1.b",
      `${"x".repeat(600)}.png.1.aaaaaaaaaaaaaaaaaaaa`,
    ]) {
      expect(await exports_.readExport(token)).toBeNull();
    }
  });
});

describe("pruning", () => {
  it("removes expired exports and leaves everything else alone", async () => {
    const expired = await exports_.storeExport({
      boardId: BOARD,
      data: PNG_BYTES,
      format: "png",
      ttlSeconds: 60,
    });
    const live = await exports_.storeExport({
      boardId: BOARD,
      data: SVG_BYTES,
      format: "svg",
      ttlSeconds: 3600,
    });
    const foreign = path.join(exportsDir(), "not-an-export.txt");
    await fs.writeFile(foreign, "leave me alone");

    const removed = await exports_.pruneExports(Date.now() + 120_000);

    expect(removed).toBeGreaterThanOrEqual(1);
    const remaining = await fs.readdir(exportsDir());
    expect(remaining).not.toContain(tokenParts(expired.token).id);
    expect(remaining).toContain(tokenParts(live.token).id);
    expect(remaining).toContain("not-an-export.txt");
    expect((await exports_.readExport(live.token))!.data.equals(SVG_BYTES)).toBe(true);

    await fs.unlink(foreign);
  });

  it("counts nothing when there is nothing to remove", async () => {
    const live = await exports_.storeExport({ boardId: BOARD, data: PNG_BYTES, format: "png" });
    expect(await exports_.pruneExports(Date.now())).toBe(0);
    expect(await exports_.readExport(live.token)).not.toBeNull();
  });
});

describe("GET /exports/:token", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = express();
    app.get("/exports/:token", exports_.exportRoute);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("serves the bytes with an inline disposition and non-shared caching", async () => {
    const stored = await exports_.storeExport({ boardId: BOARD, data: PNG_BYTES, format: "png" });
    const response = await fetch(`${base}/exports/${stored.token}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-disposition")).toMatch(/^inline; filename="[^"]+\.png"$/);
    expect(response.headers.get("content-disposition")).not.toContain(BOARD);
    const cacheControl = response.headers.get("cache-control") ?? "";
    expect(cacheControl).toContain("private");
    expect(cacheControl).not.toContain("public");
    const maxAge = Number(/max-age=(\d+)/.exec(cacheControl)?.[1]);
    expect(maxAge).toBeGreaterThan(0);
    expect(maxAge).toBeLessThanOrEqual(exports_.DEFAULT_TTL_SECONDS);
    expect(Date.parse(response.headers.get("expires") ?? "")).toBeLessThanOrEqual(
      Date.parse(stored.expiresAt),
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("etag")).toBe(`"${stored.sha256}"`);

    const body = Buffer.from(await response.arrayBuffer());
    expect(body.equals(PNG_BYTES)).toBe(true);
  });

  it("serves svg with a content security policy that blocks scripts", async () => {
    const stored = await exports_.storeExport({ boardId: BOARD, data: SVG_BYTES, format: "svg" });
    const response = await fetch(`${base}/exports/${stored.token}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  it("404s an unknown, a tampered and an expired token alike", async () => {
    // A short ttl keeps the clock jump small, so the opportunistic prune it
    // triggers cannot reach any other test's export.
    const stored = await exports_.storeExport({
      boardId: BOARD,
      data: PNG_BYTES,
      format: "png",
      ttlSeconds: 60,
    });
    const { id, format, exp, sig } = tokenParts(stored.token);

    const unknown = await fetch(`${base}/exports/nonsense`);
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("cache-control")).toBe("no-store");

    const tampered = await fetch(`${base}/exports/${id}.${format}.${exp}.${sig.slice(0, 20)}`);
    expect(tampered.status).toBe(404);

    // Only Date is faked: the http server's own timers stay real.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse(stored.expiresAt) + 1_000);
    const expired = await fetch(`${base}/exports/${stored.token}`);
    vi.useRealTimers();
    expect(expired.status).toBe(404);
  });
});

describe("link shape", () => {
  it("prefixes PUBLIC_BASE_URL when one is configured", async () => {
    vi.resetModules();
    process.env.PUBLIC_BASE_URL = "https://boards.example.com/";
    const hosted = (await import("../exports")) as ExportsModule;
    try {
      const stored = await hosted.storeExport({ boardId: BOARD, data: PNG_BYTES, format: "png" });
      expect(stored.url).toBe(`https://boards.example.com/exports/${stored.token}`);
      // Same secret, same directory: the first module instance still reads it.
      expect(await exports_.readExport(stored.token)).not.toBeNull();
    } finally {
      process.env.PUBLIC_BASE_URL = "";
      vi.resetModules();
    }
  });

  it("falls back to a per-process secret when INTERNAL_SECRET is empty", async () => {
    vi.resetModules();
    process.env.INTERNAL_SECRET = "";
    const first = (await import("../exports")) as ExportsModule;
    try {
      const stored = await first.storeExport({ boardId: BOARD, data: PNG_BYTES, format: "png" });
      expect(await first.readExport(stored.token)).not.toBeNull();

      // A restart re-rolls the fallback secret, so the link stops working.
      vi.resetModules();
      const afterRestart = (await import("../exports")) as ExportsModule;
      expect(await afterRestart.readExport(stored.token)).toBeNull();
    } finally {
      process.env.INTERNAL_SECRET = SECRET;
      vi.resetModules();
    }
  });
});
