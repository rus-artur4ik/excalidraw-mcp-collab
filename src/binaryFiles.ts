import { createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { deflateSync, inflateSync } from "zlib";

import { config } from "./config";
import { decryptData, encryptData } from "./encryption";

export const FILE_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;

export const IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/x-icon",
  "image/svg+xml",
]);

export type BinaryFileMetadata = {
  id: string;
  mimeType: string;
  created: number;
  lastRetrieved: number;
};

// Matches the frontend's concatBuffers wire format (packages/excalidraw/data/encode.ts):
// [4-byte version][4-byte length][chunk]... with big-endian uint32 fields.
const CONCAT_BUFFERS_VERSION = 1;
const UINT32_BYTES = 4;

const concatBuffers = (...buffers: Uint8Array[]): Uint8Array => {
  const total =
    UINT32_BYTES +
    buffers.reduce((acc, buffer) => acc + UINT32_BYTES + buffer.byteLength, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let cursor = 0;
  view.setUint32(cursor, CONCAT_BUFFERS_VERSION);
  cursor += UINT32_BYTES;
  for (const buffer of buffers) {
    view.setUint32(cursor, buffer.byteLength);
    cursor += UINT32_BYTES;
    out.set(buffer, cursor);
    cursor += buffer.byteLength;
  }
  return out;
};

const splitBuffers = (concatenated: Uint8Array): Uint8Array[] => {
  const view = new DataView(
    concatenated.buffer,
    concatenated.byteOffset,
    concatenated.byteLength,
  );
  const version = view.getUint32(0);
  if (version > CONCAT_BUFFERS_VERSION) {
    throw new Error(`invalid buffer version ${version}`);
  }
  const buffers: Uint8Array[] = [];
  let cursor = UINT32_BYTES;
  while (cursor < concatenated.byteLength) {
    const chunkSize = view.getUint32(cursor);
    cursor += UINT32_BYTES;
    buffers.push(concatenated.slice(cursor, cursor + chunkSize));
    cursor += chunkSize;
  }
  return buffers;
};

const utf8 = (value: unknown): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(value));

export const encodeBinaryFile = async (
  dataURL: string,
  metadata: BinaryFileMetadata,
  encryptionKey: string,
): Promise<Uint8Array> => {
  const fileInfo = { version: 2, compression: "pako@1", encryption: "AES-GCM" };
  const payload = concatBuffers(
    utf8(metadata),
    new TextEncoder().encode(dataURL),
  );
  const { encryptedBuffer, iv } = await encryptData(
    encryptionKey,
    deflateSync(payload),
  );
  return concatBuffers(utf8(fileInfo), iv, new Uint8Array(encryptedBuffer));
};

export const decodeBinaryFile = async (
  encoded: Uint8Array,
  decryptionKey: string,
): Promise<{ metadata: BinaryFileMetadata; dataURL: string }> => {
  const [, iv, ciphertext] = splitBuffers(encoded);
  const decrypted = new Uint8Array(
    await decryptData(iv, ciphertext, decryptionKey),
  );
  const [metadataBuffer, dataBuffer] = splitBuffers(inflateSync(decrypted));
  return {
    metadata: JSON.parse(
      new TextDecoder().decode(metadataBuffer),
    ) as BinaryFileMetadata,
    dataURL: new TextDecoder().decode(dataBuffer),
  };
};

const DATA_URL_PATTERN = /^data:([^;,]+);base64,(.*)$/s;

export const parseUploadData = (
  data: string,
  mimeType?: string,
): { bytes: Buffer; mimeType: string } => {
  const match = DATA_URL_PATTERN.exec(data.trim());
  const base64 = match ? match[2] : data.trim();
  const resolvedMime = mimeType ?? match?.[1];
  if (!resolvedMime) {
    throw new Error("mimeType is required when `data` is not a data URL");
  }
  if (!IMAGE_MIME_TYPES.has(resolvedMime)) {
    throw new Error(
      `unsupported mimeType ${resolvedMime}; allowed: ${[...IMAGE_MIME_TYPES].join(", ")}`,
    );
  }
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length === 0) {
    throw new Error("empty or invalid base64 data");
  }
  if (bytes.length > FILE_UPLOAD_MAX_BYTES) {
    throw new Error(
      `file too large: ${bytes.length} bytes, max ${FILE_UPLOAD_MAX_BYTES}`,
    );
  }
  return { bytes, mimeType: resolvedMime };
};

// Same id scheme as the frontend (generateIdFromFile): SHA-1 hex of the raw bytes.
export const fileIdForBytes = (bytes: Buffer): string =>
  createHash("sha1").update(bytes).digest("hex");

export const roomFilePath = (roomId: string, fileId: string): string =>
  path.join(path.resolve(config.dataDir), "files", "rooms", roomId, fileId);

export const writeRoomFile = async (
  roomId: string,
  fileId: string,
  encoded: Uint8Array,
): Promise<{ reused: boolean }> => {
  const absolute = roomFilePath(roomId, fileId);
  try {
    await fs.access(absolute);
    return { reused: true };
  } catch {
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, encoded);
    return { reused: false };
  }
};
