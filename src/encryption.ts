const ENCRYPTION_KEY_BITS = 128;
export const IV_LENGTH_BYTES = 12;

const subtle = globalThis.crypto.subtle;

const createIV = (): Uint8Array => {
  return globalThis.crypto.getRandomValues(new Uint8Array(IV_LENGTH_BYTES));
};

const getCryptoKey = (key: string, usage: KeyUsage): Promise<CryptoKey> =>
  subtle.importKey(
    "jwk",
    {
      alg: "A128GCM",
      ext: true,
      k: key,
      key_ops: ["encrypt", "decrypt"],
      kty: "oct",
    },
    {
      name: "AES-GCM",
      length: ENCRYPTION_KEY_BITS,
    },
    false,
    [usage],
  );

export const encryptData = async (
  key: string,
  data: Uint8Array | string,
): Promise<{ encryptedBuffer: ArrayBuffer; iv: Uint8Array }> => {
  const importedKey = await getCryptoKey(key, "encrypt");
  const iv = createIV();
  const buffer =
    typeof data === "string" ? new TextEncoder().encode(data) : data;

  const encryptedBuffer = await subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    importedKey,
    buffer as BufferSource,
  );

  return { encryptedBuffer, iv };
};

export const decryptData = async (
  iv: Uint8Array,
  encrypted: Uint8Array | ArrayBuffer,
  privateKey: string,
): Promise<ArrayBuffer> => {
  const key = await getCryptoKey(privateKey, "decrypt");
  return subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    encrypted as BufferSource,
  );
};

export const encryptJSON = async (
  key: string,
  value: unknown,
): Promise<{ ciphertext: Uint8Array; iv: Uint8Array }> => {
  const json = JSON.stringify(value);
  const { encryptedBuffer, iv } = await encryptData(key, json);
  return { ciphertext: new Uint8Array(encryptedBuffer), iv };
};

export const decryptJSON = async <T>(
  key: string,
  ciphertext: Uint8Array,
  iv: Uint8Array,
): Promise<T> => {
  const decrypted = await decryptData(iv, ciphertext, key);
  const decoded = new TextDecoder("utf-8").decode(new Uint8Array(decrypted));
  return JSON.parse(decoded) as T;
};
