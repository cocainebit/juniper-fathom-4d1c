import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  authenticateService,
  balance,
  createServiceClient,
  debit,
  debitBatch,
  grant,
  pricesFor,
  recentEntries,
  setPrice,
  type ServiceClient,
} from "../src/ledger.js";
import type { Db } from "../src/db.js";
import { createTestDb, token } from "./helpers.js";

let db: Db;
let drop: () => Promise<void>;
const cubicle: ServiceClient = { id: "cubicle", skuPrefixes: ["cubicle"] };
const plotform: ServiceClient = { id: "plotform", skuPrefixes: ["plotform"] };
let n = 0;
const org = () => `org_${Date.now()}_${n++}`;

beforeAll(async () => {
  ({ db, drop } = await createTestDb());
  await setPrice(db, "cubicle.minute.cpu2-mem4", 3334, "Desktop minute, 2 CPU, 4 GiB");
  await setPrice(db, "plotform.generate.site", 250_000, "Generate a site");
  await setPrice(db, "cubicle.minute.retired", 1000, "", false);
});
afterAll(async () => drop());

describe("grants", () => {
  it("credits once per key and reports conflicts", async () => {
    const o = org();
    expect(await grant(db, { organizationId: o, amountMicro: 5_000_000, idempotencyKey: "invoice:a", reason: "test" })).toEqual({
      status: "applied",
      amountMicro: 5_000_000,
      balanceAfterMicro: 5_000_000,
    });
    expect((await grant(db, { organizationId: o, amountMicro: 5_000_000, idempotencyKey: "invoice:a", reason: "test" })).status).toBe("replayed");
    expect((await grant(db, { organizationId: o, amountMicro: 1, idempotencyKey: "invoice:a", reason: "test" })).status).toBe("conflict");
    expect(await balance(db, o)).toBe(5_000_000);
  });
});

describe("debits", () => {
  let o: string;
  beforeEach(async () => {
    o = org();
    await grant(db, { organizationId: o, amountMicro: 10_000, idempotencyKey: `seed:${o}`, reason: "seed" });
  });

  it("applies, replays verbatim keys, and flags a reused key with new parameters", async () => {
    const item = { idempotencyKey: "usage:computer-1:2026-09-17T13:20", organizationId: o, sku: "cubicle.minute.cpu2-mem4", units: 2 };
    expect(await debit(db, cubicle, item)).toEqual({ status: "applied", idempotencyKey: item.idempotencyKey, amountMicro: 6668, balanceAfterMicro: 3332 });
    expect(await debit(db, cubicle, item)).toEqual({ status: "replayed", idempotencyKey: item.idempotencyKey, amountMicro: 6668, balanceAfterMicro: 3332 });
    expect((await debit(db, cubicle, { ...item, units: 1 })).status).toBe("conflict");
    expect(await balance(db, o)).toBe(3332);
  });

  it("refuses without recording when the balance is short, and never goes negative", async () => {
    const outcome = await debit(db, cubicle, { idempotencyKey: "k-short", organizationId: o, sku: "cubicle.minute.cpu2-mem4", units: 4 });
    expect(outcome).toEqual({ status: "insufficient_funds", idempotencyKey: "k-short" });
    expect(await balance(db, o)).toBe(10_000);
    expect((await recentEntries(db, o)).filter((entry) => entry.kind === "debit")).toHaveLength(0);
    // The same key can succeed later once there is enough balance.
    await grant(db, { organizationId: o, amountMicro: 10_000, idempotencyKey: `top:${o}`, reason: "top" });
    expect((await debit(db, cubicle, { idempotencyKey: "k-short", organizationId: o, sku: "cubicle.minute.cpu2-mem4", units: 4 })).status).toBe("applied");
  });

  it("treats unknown, inactive, and other services' SKUs as unknown", async () => {
    expect((await debit(db, cubicle, { idempotencyKey: "u1", organizationId: o, sku: "cubicle.minute.nope", units: 1 })).status).toBe("unknown_sku");
    expect((await debit(db, cubicle, { idempotencyKey: "u2", organizationId: o, sku: "cubicle.minute.retired", units: 1 })).status).toBe("unknown_sku");
    expect((await debit(db, cubicle, { idempotencyKey: "u3", organizationId: o, sku: "plotform.generate.site", units: 1 })).status).toBe("unknown_sku");
    expect(await balance(db, o)).toBe(10_000);
  });

  it("scopes idempotency keys to the calling service", async () => {
    await grant(db, { organizationId: o, amountMicro: 500_000, idempotencyKey: `big:${o}`, reason: "top" });
    expect((await debit(db, cubicle, { idempotencyKey: "same", organizationId: o, sku: "cubicle.minute.cpu2-mem4", units: 1 })).status).toBe("applied");
    expect((await debit(db, plotform, { idempotencyKey: "same", organizationId: o, sku: "plotform.generate.site", units: 1 })).status).toBe("applied");
  });
});

describe("batches", () => {
  it("decides each item independently across organizations", async () => {
    const rich = org();
    const poor = org();
    await grant(db, { organizationId: rich, amountMicro: 100_000, idempotencyKey: `seed:${rich}`, reason: "seed" });
    await grant(db, { organizationId: poor, amountMicro: 5_000, idempotencyKey: `seed:${poor}`, reason: "seed" });
    const sku = "cubicle.minute.cpu2-mem4";
    const outcomes = await debitBatch(db, cubicle, [
      { idempotencyKey: "b:poor:1", organizationId: poor, sku, units: 1 },
      { idempotencyKey: "b:rich:1", organizationId: rich, sku, units: 1 },
      { idempotencyKey: "b:poor:2", organizationId: poor, sku, units: 1 },
      { idempotencyKey: "b:rich:2", organizationId: rich, sku, units: 1 },
      { idempotencyKey: "b:rich:1", organizationId: rich, sku, units: 1 },
      { idempotencyKey: "b:nobody", organizationId: org(), sku, units: 1 },
    ]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["applied", "applied", "insufficient_funds", "applied", "replayed", "insufficient_funds"]);
    expect(await balance(db, poor)).toBe(5_000 - 3334);
    expect(await balance(db, rich)).toBe(100_000 - 2 * 3334);
  });

  it("rejects batches over 500 items", async () => {
    const items = Array.from({ length: 501 }, (_, i) => ({ idempotencyKey: `x${i}`, organizationId: "o", sku: "cubicle.minute.cpu2-mem4", units: 1 }));
    await expect(debitBatch(db, cubicle, items)).rejects.toThrow(/500/);
  });
});

describe("concurrency", () => {
  it("lets exactly the affordable number of racing debits through", async () => {
    const o = org();
    await grant(db, { organizationId: o, amountMicro: 3334 * 7 + 100, idempotencyKey: `seed:${o}`, reason: "seed" });
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => debit(db, cubicle, { idempotencyKey: `race:${o}:${i}`, organizationId: o, sku: "cubicle.minute.cpu2-mem4", units: 1 })),
    );
    expect(results.filter((r) => r.status === "applied")).toHaveLength(7);
    expect(results.filter((r) => r.status === "insufficient_funds")).toHaveLength(13);
    expect(await balance(db, o)).toBe(100);
  });

  it("charges a key once when the same request races with itself", async () => {
    const o = org();
    await grant(db, { organizationId: o, amountMicro: 100_000, idempotencyKey: `seed:${o}`, reason: "seed" });
    const item = { idempotencyKey: `dup:${o}`, organizationId: o, sku: "cubicle.minute.cpu2-mem4", units: 3 };
    const results = await Promise.all(Array.from({ length: 10 }, () => debit(db, cubicle, item)));
    expect(results.filter((r) => r.status === "applied")).toHaveLength(1);
    expect(results.filter((r) => r.status === "replayed")).toHaveLength(9);
    expect(await balance(db, o)).toBe(100_000 - 3 * 3334);
  });

  it("charges a key once when the same key races for two different organizations", async () => {
    const a = org();
    const b = org();
    for (const o of [a, b]) await grant(db, { organizationId: o, amountMicro: 100_000, idempotencyKey: `seed:${o}`, reason: "seed" });
    const key = `cross:${a}`;
    const results = await Promise.all([
      debit(db, cubicle, { idempotencyKey: key, organizationId: a, sku: "cubicle.minute.cpu2-mem4", units: 1 }),
      debit(db, cubicle, { idempotencyKey: key, organizationId: b, sku: "cubicle.minute.cpu2-mem4", units: 1 }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["applied", "conflict"]);
    expect((await balance(db, a)) + (await balance(db, b))).toBe(200_000 - 3334);
  });
});

describe("service clients", () => {
  it("authenticates only current, full-length secrets and lists their prices", async () => {
    const secret = token();
    await createServiceClient(db, "cubicle", ["cubicle"], secret);
    expect(await authenticateService(db, secret)).toEqual({ id: "cubicle", skuPrefixes: ["cubicle"] });
    expect(await authenticateService(db, secret.slice(0, -1) + "x")).toBeNull();
    expect(await authenticateService(db, "short")).toBeNull();
    expect((await pricesFor(db, cubicle)).map((price) => price.sku)).toEqual(["cubicle.minute.cpu2-mem4"]);
    const rotated = token();
    await createServiceClient(db, "cubicle", ["cubicle"], rotated);
    expect(await authenticateService(db, secret)).toBeNull();
    expect(await authenticateService(db, rotated)).not.toBeNull();
  });
});
