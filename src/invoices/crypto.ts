import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Encryption at rest for persisted x402 payment payloads.
 *
 * A signed payload is a bearer instrument until it settles: anyone holding an EIP-3009
 * authorization can submit it. So it is stored only as AES-256-GCM ciphertext under
 * PAYLOAD_KEY, with a random 12-byte IV per payload and the 16-byte auth tag. The invoice
 * id is bound in as additional authenticated data, so a ciphertext copied onto another
 * invoice row fails to decrypt.
 *
 * Sealed format: `v1.<iv>.<tag>.<ciphertext>`, each part base64url.
 */

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Decodes PAYLOAD_KEY (base64) and insists on exactly 32 bytes. */
export function parsePayloadKey(base64: string): Buffer {
  const key = Buffer.from(base64, "base64");
  if (key.length !== 32) throw new Error("PAYLOAD_KEY must be 32 bytes, base64");
  return key;
}

export function encryptPayload(key: Buffer, plaintext: string, context: string): string {
  if (key.length !== 32) throw new Error("payload key must be 32 bytes");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(context, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

/** Throws if the key, context or any byte of the sealed value is wrong. */
export function decryptPayload(key: Buffer, sealed: string, context: string): string {
  if (key.length !== 32) throw new Error("payload key must be 32 bytes");
  const [version, ivPart, tagPart, bodyPart, ...rest] = sealed.split(".");
  if (version !== VERSION || ivPart === undefined || tagPart === undefined || bodyPart === undefined || rest.length > 0) {
    throw new Error("sealed payload has an unknown format");
  }
  const iv = Buffer.from(ivPart, "base64url");
  const tag = Buffer.from(tagPart, "base64url");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error("sealed payload has an unknown format");
  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(context, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(bodyPart, "base64url")), decipher.final()]).toString("utf8");
}

/** JSON with object keys sorted at every level, so equal payloads serialize identically. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** SHA-256 hex of the canonical JSON. Recognizes a replayed payload however its header was encoded. */
export function payloadDigest(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}
