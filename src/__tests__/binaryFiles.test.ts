import {describe, expect, it} from "vitest";

import {
  decodeBinaryFile,
  encodeBinaryFile,
  FILE_UPLOAD_MAX_BYTES,
  fileIdForBytes,
  parseUploadData,
} from "../binaryFiles";

const ROOM_KEY = "dGVzdHRlc3R0ZXN0dGVzdA";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("binary file codec", () => {
  it("roundtrips dataURL and metadata through the frontend container format", async () => {
    const dataURL = `data:image/png;base64,${PNG_BASE64}`;
    const metadata = {
      id: "abc",
      mimeType: "image/png",
      created: 123,
      lastRetrieved: 123,
    };
    const encoded = await encodeBinaryFile(dataURL, metadata, ROOM_KEY);
    const decoded = await decodeBinaryFile(encoded, ROOM_KEY);
    expect(decoded.dataURL).toBe(dataURL);
    expect(decoded.metadata).toEqual(metadata);
  });

  it("writes the concatBuffers header the frontend expects", async () => {
    const encoded = await encodeBinaryFile(
      "data:image/png;base64,AA==",
      { id: "x", mimeType: "image/png", created: 1, lastRetrieved: 1 },
      ROOM_KEY,
    );
    const view = new DataView(encoded.buffer, encoded.byteOffset);
    expect(view.getUint32(0)).toBe(1);
    const firstChunkLength = view.getUint32(4);
    const fileInfo = JSON.parse(
      new TextDecoder().decode(encoded.slice(8, 8 + firstChunkLength)),
    );
    expect(fileInfo).toEqual({
      version: 2,
      compression: "pako@1",
      encryption: "AES-GCM",
    });
  });

  it("rejects decoding with a wrong key", async () => {
    const encoded = await encodeBinaryFile(
      "data:image/png;base64,AA==",
      { id: "x", mimeType: "image/png", created: 1, lastRetrieved: 1 },
      ROOM_KEY,
    );
    await expect(
      decodeBinaryFile(encoded, "d3JvbmdrZXl3cm9uZ2tleQ"),
    ).rejects.toThrow();
  });
});

describe("parseUploadData", () => {
  it("accepts a data URL and infers the mime type", () => {
    const { bytes, mimeType } = parseUploadData(
      `data:image/png;base64,${PNG_BASE64}`,
    );
    expect(mimeType).toBe("image/png");
    expect(bytes.length).toBeGreaterThan(0);
  });

  it("accepts bare base64 with an explicit mime type", () => {
    const { bytes, mimeType } = parseUploadData(PNG_BASE64, "image/png");
    expect(mimeType).toBe("image/png");
    expect(bytes.subarray(0, 4)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
  });

  it("prefers the explicit mime type over the data URL prefix", () => {
    const { mimeType } = parseUploadData(
      `data:image/png;base64,${PNG_BASE64}`,
      "image/webp",
    );
    expect(mimeType).toBe("image/webp");
  });

  it("rejects bare base64 without a mime type", () => {
    expect(() => parseUploadData(PNG_BASE64)).toThrow(/mimeType is required/);
  });

  it("rejects non-image mime types", () => {
    expect(() => parseUploadData(PNG_BASE64, "application/pdf")).toThrow(
      /unsupported mimeType/,
    );
  });

  it("rejects empty payloads", () => {
    expect(() => parseUploadData("", "image/png")).toThrow(/empty or invalid/);
  });

  it("rejects payloads over the size cap", () => {
    const big = Buffer.alloc(FILE_UPLOAD_MAX_BYTES + 1).toString("base64");
    expect(() => parseUploadData(big, "image/png")).toThrow(/file too large/);
  });
});

describe("fileIdForBytes", () => {
  it("is stable and matches sha1 hex", () => {
    const bytes = Buffer.from("hello");
    expect(fileIdForBytes(bytes)).toBe(
      "aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d",
    );
    expect(fileIdForBytes(bytes)).toBe(fileIdForBytes(Buffer.from("hello")));
  });
});
