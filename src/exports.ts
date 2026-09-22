import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import { promises as fs } from "fs";
import path from "path";

import { config } from "./config";
import { ToolError, invalidArgs } from "./engine/errors";
import { logError, logInfo, logWarn, opaqueRef } from "./logger";

import type { Request, RequestHandler, Response } from "express";

export type ExportFormat = "png" | "svg";

export type StoredExport = {
  url: string;
  expiresAt: string;
  sha256: string;
  bytes: number;
  token: string;
};

export const DEFAULT_TTL_SECONDS = 24 * 60 * 60;
export const MAX_TTL_SECONDS = 7 * 24 * 60 * 60;
export const MAX_EXPORT_BYTES = 32 * 1024 * 1024;

const ID_BYTES = 18; // 144 bits of entropy -> 24 base64url chars
const MAX_TOKEN_CHARS = 512;
const MAX_HEADER_BYTES = 4096;
const HEADER_PREFIX_BYTES = 4;
const TEMP_SUFFIX = ".part";
const TEMP_MAX_AGE_MS = 60 * 60_000;
const PRUNE_INTERVAL_MS = 60_000;

// Only base64url characters: a token segment can therefore never contain a
// path separator or a dot, which is what keeps `filePathFor` traversal-proof.
const ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const BASE36_PATTERN = /^[0-9a-z]{1,12}$/;

/**
 * Stored next to the bytes so a read can rebuild the signed string without a
 * database: the board a token is bound to is deliberately NOT in the URL.
 */
type ExportHeader = {
  v: 1;
  boardId: string;
  format: ExportFormat;
  exp: number; // unix seconds
  sha256: string;
  bytes: number;
  createdAt: number;
};

type LoadedExport = {
  data: Buffer;
  contentType: string;
  header: ExportHeader;
  id: string;
};

// Links must survive a restart, so the HMAC key has to outlive the process.
// With no INTERNAL_SECRET configured we fall back to a per-process key: every
// link minted before a restart then reads as 404 afterwards.
const ephemeralSecret = randomBytes(32).toString("hex");
let warnedAboutEphemeralSecret = false;

const signingSecret = (): string => {
  if (config.internalSecret) {
    return config.internalSecret;
  }
  if (!warnedAboutEphemeralSecret) {
    warnedAboutEphemeralSecret = true;
    logWarn("exports.secret.ephemeral", {
      hint: "set INTERNAL_SECRET so export links survive a restart",
    });
  }
  return ephemeralSecret;
};

const exportsDir = (): string => path.join(path.resolve(config.dataDir), "exports");

const filePathFor = (id: string): string => path.join(exportsDir(), id);

const contentTypeFor = (format: ExportFormat): string =>
  format === "png" ? "image/png" : "image/svg+xml; charset=utf-8";

const extensionFor = (format: ExportFormat): string => (format === "png" ? "png" : "svg");

const sign = (id: string, boardId: string, format: ExportFormat, exp: number): string =>
  createHmac("sha256", signingSecret())
    .update(`${id}|${boardId}|${format}|${exp}`)
    .digest("base64url");

const sameSignature = (expected: string, actual: string): boolean => {
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(actual, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
};

export const getExportUrl = (token: string): string =>
  config.publicBaseUrl
    ? `${config.publicBaseUrl.replace(/\/$/, "")}/exports/${token}`
    : `/exports/${token}`;

type ParsedToken = { id: string; format: ExportFormat; exp: number; signature: string };

const parseToken = (token: unknown): ParsedToken | null => {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_CHARS) {
    return null;
  }
  const parts = token.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const [id, format, expRaw, signature] = parts;
  if (!ID_PATTERN.test(id) || !SIGNATURE_PATTERN.test(signature)) {
    return null;
  }
  if (format !== "png" && format !== "svg") {
    return null;
  }
  if (!BASE36_PATTERN.test(expRaw)) {
    return null;
  }
  const exp = parseInt(expRaw, 36);
  // Canonical encoding only: two spellings of one expiry would be two links.
  if (!Number.isSafeInteger(exp) || exp <= 0 || exp.toString(36) !== expRaw) {
    return null;
  }
  return { id, format, exp, signature };
};

const parseHeader = (raw: Buffer): ExportHeader | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const header = parsed as Partial<ExportHeader>;
  if (
    header.v !== 1 ||
    typeof header.boardId !== "string" ||
    header.boardId.length === 0 ||
    (header.format !== "png" && header.format !== "svg") ||
    !Number.isSafeInteger(header.exp) ||
    !Number.isSafeInteger(header.bytes) ||
    typeof header.sha256 !== "string"
  ) {
    return null;
  }
  return header as ExportHeader;
};

const encodeRecord = (header: ExportHeader, data: Buffer): Buffer => {
  const headerJson = Buffer.from(JSON.stringify(header), "utf8");
  if (headerJson.length > MAX_HEADER_BYTES) {
    throw invalidArgs("export metadata is too large", { field: "boardId" });
  }
  const prefix = Buffer.alloc(HEADER_PREFIX_BYTES);
  prefix.writeUInt32BE(headerJson.length, 0);
  return Buffer.concat([prefix, headerJson, data]);
};

const decodeRecord = (raw: Buffer): { header: ExportHeader; data: Buffer } | null => {
  if (raw.length < HEADER_PREFIX_BYTES) {
    return null;
  }
  const headerLength = raw.readUInt32BE(0);
  if (
    headerLength <= 0 ||
    headerLength > MAX_HEADER_BYTES ||
    raw.length < HEADER_PREFIX_BYTES + headerLength
  ) {
    return null;
  }
  const header = parseHeader(raw.subarray(HEADER_PREFIX_BYTES, HEADER_PREFIX_BYTES + headerLength));
  if (!header) {
    return null;
  }
  return { header, data: raw.subarray(HEADER_PREFIX_BYTES + headerLength) };
};

// Prune only reads the head of each file: an export can be hundreds of KB and
// the sweep touches every one of them.
const readHeaderOnly = async (file: string): Promise<ExportHeader | null> => {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(file, "r");
  } catch {
    return null;
  }
  try {
    const prefix = Buffer.alloc(HEADER_PREFIX_BYTES);
    const prefixRead = await handle.read(prefix, 0, HEADER_PREFIX_BYTES, 0);
    if (prefixRead.bytesRead < HEADER_PREFIX_BYTES) {
      return null;
    }
    const headerLength = prefix.readUInt32BE(0);
    if (headerLength <= 0 || headerLength > MAX_HEADER_BYTES) {
      return null;
    }
    const buffer = Buffer.alloc(headerLength);
    const headerRead = await handle.read(buffer, 0, headerLength, HEADER_PREFIX_BYTES);
    if (headerRead.bytesRead < headerLength) {
      return null;
    }
    return parseHeader(buffer);
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
};

const clampTtl = (ttlSeconds: number | undefined): number => {
  if (ttlSeconds === undefined || !Number.isFinite(ttlSeconds)) {
    return DEFAULT_TTL_SECONDS;
  }
  return Math.min(MAX_TTL_SECONDS, Math.max(1, Math.floor(ttlSeconds)));
};

export const storeExport = async (input: {
  boardId: string;
  data: Buffer;
  format: ExportFormat;
  ttlSeconds?: number;
}): Promise<StoredExport> => {
  const { boardId, data, format } = input;
  if (typeof boardId !== "string" || boardId.trim() === "") {
    throw invalidArgs("boardId is required to mint an export link", { field: "boardId" });
  }
  if (format !== "png" && format !== "svg") {
    throw invalidArgs('format must be "png" or "svg"', { field: "format" });
  }
  if (!Buffer.isBuffer(data) || data.length === 0) {
    throw invalidArgs("nothing to export: data is empty", { field: "data" });
  }
  if (data.length > MAX_EXPORT_BYTES) {
    throw new ToolError("too_large", `export exceeds ${MAX_EXPORT_BYTES} bytes`, {
      details: {
        field: "data",
        bytes: data.length,
        limit: MAX_EXPORT_BYTES,
        hint: "render a smaller region or a lower scale",
      },
    });
  }

  const ttlSeconds = clampTtl(input.ttlSeconds);
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const id = randomBytes(ID_BYTES).toString("base64url");
  const sha256 = createHash("sha256").update(data).digest("hex");
  const header: ExportHeader = {
    v: 1,
    boardId,
    format,
    exp,
    sha256,
    bytes: data.length,
    createdAt: Date.now(),
  };

  const directory = exportsDir();
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const target = filePathFor(id);
  const temp = `${target}${TEMP_SUFFIX}`;
  try {
    // Write-then-rename so a reader never sees a half-written export.
    await fs.writeFile(temp, encodeRecord(header, data), { mode: 0o600 });
    await fs.rename(temp, target);
  } catch (error) {
    await fs.unlink(temp).catch(() => undefined);
    logError("exports.store_failed", error, { boardId, format });
    throw error;
  }

  const token = `${id}.${format}.${exp.toString(36)}.${sign(id, boardId, format, exp)}`;
  const expiresAt = new Date(exp * 1000).toISOString();
  logInfo("exports.stored", {
    boardId,
    format,
    bytes: data.length,
    expiresAt,
    ttlSeconds,
    tokenRef: opaqueRef(token),
  });
  return { url: getExportUrl(token), expiresAt, sha256, bytes: data.length, token };
};

const loadExport = async (token: string, now: number): Promise<LoadedExport | null> => {
  const parsed = parseToken(token);
  if (!parsed) {
    return null;
  }
  if (parsed.exp * 1000 <= now) {
    return null;
  }
  let raw: Buffer;
  try {
    raw = await fs.readFile(filePathFor(parsed.id));
  } catch {
    return null;
  }
  const record = decodeRecord(raw);
  if (!record) {
    return null;
  }
  const { header, data } = record;
  if (header.format !== parsed.format || header.exp !== parsed.exp || header.bytes !== data.length) {
    return null;
  }
  if (!sameSignature(sign(parsed.id, header.boardId, header.format, header.exp), parsed.signature)) {
    return null;
  }
  return { data, contentType: contentTypeFor(header.format), header, id: parsed.id };
};

/**
 * `now` exists for tests and for the route; a caller never has to pass it.
 * Anything wrong — unknown id, wrong signature, past expiry — is the same
 * `null`, so a caller cannot tell an expired link from one that never existed.
 */
export const readExport = async (
  token: string,
  now: number = Date.now(),
): Promise<{ data: Buffer; contentType: string } | null> => {
  maybePrune();
  const loaded = await loadExport(token, now);
  return loaded ? { data: loaded.data, contentType: loaded.contentType } : null;
};

export const pruneExports = async (now: number = Date.now()): Promise<number> => {
  lastPruneAt = Date.now();
  const directory = exportsDir();
  let entries: string[];
  try {
    entries = await fs.readdir(directory);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    const file = path.join(directory, entry);
    if (entry.endsWith(TEMP_SUFFIX)) {
      const stat = await fs.stat(file).catch(() => null);
      if (stat && now - stat.mtimeMs > TEMP_MAX_AGE_MS) {
        await fs.unlink(file).catch(() => undefined);
      }
      continue;
    }
    if (!ID_PATTERN.test(entry)) {
      continue;
    }
    const header = await readHeaderOnly(file);
    if (!header) {
      // Unreadable export: it can never be served again, so drop it once it is
      // older than the longest TTL we hand out.
      const stat = await fs.stat(file).catch(() => null);
      if (stat && now - stat.mtimeMs > MAX_TTL_SECONDS * 1000) {
        await fs.unlink(file).catch(() => undefined);
        removed += 1;
      }
      continue;
    }
    if (header.exp * 1000 > now) {
      continue;
    }
    await fs.unlink(file).catch(() => undefined);
    removed += 1;
  }
  if (removed > 0) {
    logInfo("exports.pruned", { removed });
  }
  return removed;
};

let lastPruneAt = Date.now();
let pruneInFlight = false;

// Opportunistic sweep: no cron in this process, so a read does the work at
// most once a minute and never blocks the response.
const maybePrune = (): void => {
  const now = Date.now();
  if (pruneInFlight || now - lastPruneAt < PRUNE_INTERVAL_MS) {
    return;
  }
  lastPruneAt = now;
  pruneInFlight = true;
  void pruneExports(now)
    .catch((error) => logError("exports.prune_failed", error))
    .finally(() => {
      pruneInFlight = false;
    });
};

const sendNotFound = (res: Response): void => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.status(404).type("text/plain").send("not found");
};

const handleExportRequest = async (req: Request, res: Response): Promise<void> => {
  const token = (req.params as { token?: string }).token ?? "";
  maybePrune();
  let loaded: LoadedExport | null;
  try {
    loaded = await loadExport(token, Date.now());
  } catch (error) {
    logError("exports.read_failed", error, { tokenRef: opaqueRef(token) });
    sendNotFound(res);
    return;
  }
  if (!loaded) {
    sendNotFound(res);
    return;
  }
  const { header, data } = loaded;
  const maxAge = Math.max(0, header.exp - Math.floor(Date.now() / 1000));
  res.setHeader("Content-Type", loaded.contentType);
  res.setHeader("Content-Length", String(data.length));
  // The token, not the board, names the file: the id must stay out of caches,
  // proxies and download folders.
  res.setHeader(
    "Content-Disposition",
    `inline; filename="excalidraw-${loaded.id.slice(0, 8)}.${extensionFor(header.format)}"`,
  );
  // `private` keeps shared caches out of it (the link is the only secret) and
  // max-age/Expires both stop at the moment the link dies.
  res.setHeader("Cache-Control", `private, max-age=${maxAge}, must-revalidate, no-transform`);
  res.setHeader("Expires", new Date(header.exp * 1000).toUTCString());
  res.setHeader("ETag", `"${header.sha256}"`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  // An SVG is a document: neutralise scripts and external loads on our origin.
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
  );
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  res.status(200).send(data);
};

export const exportRoute: RequestHandler = (req, res) => {
  void handleExportRequest(req, res);
};
