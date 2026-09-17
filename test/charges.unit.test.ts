import { randomBytes } from "node:crypto";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { describe, expect, it } from "vitest";
import { canonicalJson, decryptPayload, encryptPayload, parsePayloadKey, payloadDigest } from "../src/charges/crypto.js";
import { createFacilitatorClient } from "../src/charges/facilitator.js";

describe("payload encryption", () => {
  const key = randomBytes(32);
  const plaintext = JSON.stringify({ payload: { signature: "0xabc", authorization: { nonce: "0x01" } } });

  it("round-trips with a fresh IV each time", () => {
    const one = encryptPayload(key, plaintext, "inv_1");
    const two = encryptPayload(key, plaintext, "inv_1");
    expect(one).not.toBe(two);
    expect(one.startsWith("v1.")).toBe(true);
    expect(one).not.toContain("signature");
    expect(decryptPayload(key, one, "inv_1")).toBe(plaintext);
  });

  it("refuses another invoice's ciphertext, a wrong key, and any tampering", () => {
    const sealed = encryptPayload(key, plaintext, "inv_1");
    expect(() => decryptPayload(key, sealed, "inv_2")).toThrow();
    expect(() => decryptPayload(randomBytes(32), sealed, "inv_1")).toThrow();
    const [version, iv, tag, body] = sealed.split(".") as [string, string, string, string];
    const flip = (part: string) => {
      const bytes = Buffer.from(part, "base64url");
      bytes[0] = bytes[0]! ^ 1;
      return bytes.toString("base64url");
    };
    expect(() => decryptPayload(key, [version, flip(iv), tag, body].join("."), "inv_1")).toThrow();
    expect(() => decryptPayload(key, [version, iv, flip(tag), body].join("."), "inv_1")).toThrow();
    expect(() => decryptPayload(key, [version, iv, tag, flip(body)].join("."), "inv_1")).toThrow();
    expect(() => decryptPayload(key, `v2.${iv}.${tag}.${body}`, "inv_1")).toThrow(/format/);
  });

  it("accepts only a 32-byte PAYLOAD_KEY", () => {
    expect(parsePayloadKey(key.toString("base64"))).toEqual(key);
    expect(() => parsePayloadKey(randomBytes(16).toString("base64"))).toThrow(/32 bytes/);
  });
});

describe("payload digests", () => {
  it("ignore key order and undefined fields", () => {
    const a = { x402Version: 2, accepted: { amount: "1", payTo: "0x1" }, payload: { signature: "0x2" } };
    const b = { payload: { signature: "0x2" }, accepted: { payTo: "0x1", amount: "1", extra: undefined }, x402Version: 2 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(payloadDigest(a)).toBe(payloadDigest(b));
    expect(payloadDigest(a)).not.toBe(payloadDigest({ ...a, x402Version: 1 }));
  });
});

describe("facilitator configuration", () => {
  const none = { CDP_API_KEY_ID: undefined, CDP_API_KEY_SECRET: undefined };

  it("builds the CDP facilitator only with both key parts, without calling it", () => {
    expect(() => createFacilitatorClient({ FACILITATOR: "cdp", ...none })).toThrow(/CDP_API_KEY_ID/);
    const client = createFacilitatorClient({ FACILITATOR: "cdp", CDP_API_KEY_ID: "placeholder-id", CDP_API_KEY_SECRET: "placeholder-secret" });
    expect(client).toBeInstanceOf(HTTPFacilitatorClient);
    expect((client as HTTPFacilitatorClient).url).toMatch(/^https:\/\/api\.cdp\.coinbase\.com\//);
  });

  it("accepts an https facilitator URL, or http on loopback only", () => {
    expect((createFacilitatorClient({ FACILITATOR: "https://facilitator.example.test/x402/", ...none }) as HTTPFacilitatorClient).url).toBe("https://facilitator.example.test/x402");
    expect((createFacilitatorClient({ FACILITATOR: "http://127.0.0.1:8762", ...none }) as HTTPFacilitatorClient).url).toBe("http://127.0.0.1:8762");
    expect(() => createFacilitatorClient({ FACILITATOR: "http://facilitator.example.test", ...none })).toThrow(/https/);
    expect(() => createFacilitatorClient({ FACILITATOR: "https://user:pass@facilitator.example.test", ...none })).toThrow(/credentials/);
    expect(() => createFacilitatorClient({ FACILITATOR: "not a url", ...none })).toThrow(/cdp or an http/);
    expect(() => createFacilitatorClient({ FACILITATOR: undefined, ...none })).toThrow(/not configured/);
  });
});
