import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { allowed, authenticateService, createServiceClient, priceFor, pricesFor, setPrice, type ServiceClient } from "../src/catalog.js";
import type { Db } from "../src/db.js";
import { createTestDb, token } from "./helpers.js";

let db: Db;
let drop: () => Promise<void>;
const cubicle: ServiceClient = { id: "cubicle", skuPrefixes: ["cubicle"] };
const plotform: ServiceClient = { id: "plotform", skuPrefixes: ["plotform"] };

beforeAll(async () => {
  ({ db, drop } = await createTestDb());
  await setPrice(db, "cubicle.minute.cpu2-mem4", 3334, "Desktop minute, 2 CPU, 4 GiB");
  await setPrice(db, "plotform.publish", 250_000, "Publish a site");
  await setPrice(db, "cubicle.minute.retired", 1000, "", false);
});
afterAll(async () => drop());

describe("prices", () => {
  it("lists and reads only the SKUs a product may charge", async () => {
    expect((await pricesFor(db, cubicle)).map((price) => price.sku)).toEqual(["cubicle.minute.cpu2-mem4"]);
    expect(await priceFor(db, cubicle, "cubicle.minute.cpu2-mem4")).toEqual({ sku: "cubicle.minute.cpu2-mem4", unitPriceMicro: 3334, description: "Desktop minute, 2 CPU, 4 GiB" });
    // Another product's SKU, an inactive one, and an unknown one all read as free.
    expect(await priceFor(db, cubicle, "plotform.publish")).toBeNull();
    expect(await priceFor(db, cubicle, "cubicle.minute.retired")).toBeNull();
    expect(await priceFor(db, cubicle, "cubicle.minute.nothing")).toBeNull();
    expect(await priceFor(db, plotform, "plotform.publish")).not.toBeNull();
  });

  it("matches a prefix only at a dot boundary", () => {
    expect(allowed(plotform, "plotform.publish")).toBe(true);
    expect(allowed(plotform, "plotform")).toBe(true);
    expect(allowed(plotform, "plotformer.publish")).toBe(false);
    expect(allowed(plotform, "cubicle.minute")).toBe(false);
  });

  it("updates a price in place", async () => {
    await setPrice(db, "plotform.publish", 300_000, "Publish a site");
    expect((await priceFor(db, plotform, "plotform.publish"))!.unitPriceMicro).toBe(300_000);
    await setPrice(db, "plotform.publish", 250_000, "Publish a site");
  });
});

describe("service clients", () => {
  it("authenticates only current, full-length secrets, and rotation revokes the old one", async () => {
    const secret = token();
    await createServiceClient(db, "cubicle", ["cubicle"], secret);
    expect(await authenticateService(db, secret)).toEqual({ id: "cubicle", skuPrefixes: ["cubicle"] });
    expect(await authenticateService(db, secret.slice(0, -1) + "x")).toBeNull();
    expect(await authenticateService(db, "short")).toBeNull();
    const rotated = token();
    await createServiceClient(db, "cubicle", ["cubicle"], rotated);
    expect(await authenticateService(db, secret)).toBeNull();
    expect(await authenticateService(db, rotated)).not.toBeNull();
  });

  it("refuses a token that is too short to be a secret", async () => {
    await expect(createServiceClient(db, "tiny", ["tiny"], "not-long-enough")).rejects.toThrow(/32 characters/);
  });
});
