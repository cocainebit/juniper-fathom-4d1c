import { createHash } from "node:crypto";
import type { Db } from "./db.js";

/**
 * Prices and the products allowed to charge them. Prices are owned by the server:
 * products send a SKU and units, never an amount. A SKU with no active price means
 * the action is free, so nothing is charged until an operator sets a price.
 */

export type ServiceClient = { id: string; skuPrefixes: string[] };

export type Price = { sku: string; unitPriceMicro: number; description: string };

export type Quote = { kind: "unknown" } | { kind: "free" } | { kind: "priced"; price: Price };

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const hashToken = (token: string) => createHash("sha256").update(token).digest();
const toNumber = (value: bigint | string) => {
  const big = BigInt(value);
  if (big > MAX_SAFE) throw new Error("amount exceeds the safe integer range");
  return Number(big);
};

export async function authenticateService(db: Db, token: string): Promise<ServiceClient | null> {
  if (token.length < 32 || token.length > 200) return null;
  const { rows } = await db.query<{ id: string; sku_prefixes: string[] }>(
    "select id, sku_prefixes from service_clients where token_hash = $1 and revoked_at is null",
    [hashToken(token)],
  );
  const row = rows[0];
  return row ? { id: row.id, skuPrefixes: row.sku_prefixes } : null;
}

export async function createServiceClient(db: Db, id: string, skuPrefixes: string[], token: string): Promise<void> {
  if (token.length < 32) throw new Error("service token must be at least 32 characters");
  await db.query(
    `insert into service_clients (id, token_hash, sku_prefixes) values ($1, $2, $3)
     on conflict (id) do update set token_hash = excluded.token_hash, sku_prefixes = excluded.sku_prefixes, revoked_at = null`,
    [id, hashToken(token), skuPrefixes],
  );
}

/** A product may charge a SKU under one of its prefixes, and only that. */
export const allowed = (client: ServiceClient, sku: string) =>
  client.skuPrefixes.some((prefix) => sku === prefix || sku.startsWith(prefix.endsWith(".") ? prefix : `${prefix}.`));

export async function setPrice(db: Db, sku: string, unitPriceMicro: number, description = "", active = true): Promise<void> {
  await db.query(
    `insert into price_catalog (sku, unit_price_micro, description, active) values ($1, $2, $3, $4)
     on conflict (sku) do update set unit_price_micro = excluded.unit_price_micro, description = excluded.description, active = excluded.active, updated_at = now()`,
    [sku, unitPriceMicro, description, active],
  );
}

export async function pricesFor(db: Db, client: ServiceClient): Promise<Price[]> {
  const { rows } = await db.query<{ sku: string; unit_price_micro: string; description: string }>(
    "select sku, unit_price_micro, description from price_catalog where active order by sku",
  );
  return rows.filter((row) => allowed(client, row.sku)).map((row) => ({ sku: row.sku, unitPriceMicro: toNumber(row.unit_price_micro), description: row.description }));
}

/** The wording for a SKU a product may not charge, kept the same wherever it is refused. */
export const unknownSkuMessage = (client: ServiceClient, sku: string) => `${sku} is not a SKU ${client.id} may charge`;

/**
 * What this SKU costs this product, decided before any payment rail is involved, so a
 * server with no payments configured can still answer that an action is free. A SKU
 * outside the product's prefixes is a mistake rather than a free action, so it gets its
 * own answer.
 */
export async function quote(db: Db, client: ServiceClient, sku: string): Promise<Quote> {
  if (!allowed(client, sku)) return { kind: "unknown" };
  const price = await priceFor(db, client, sku);
  return price ? { kind: "priced", price } : { kind: "free" };
}

/** The active price for one SKU this product may charge, or null when the action is free. */
export async function priceFor(db: Db, client: ServiceClient, sku: string): Promise<Price | null> {
  if (!allowed(client, sku)) return null;
  const { rows } = await db.query<{ sku: string; unit_price_micro: string; description: string }>(
    "select sku, unit_price_micro, description from price_catalog where active and sku = $1",
    [sku],
  );
  const row = rows[0];
  return row ? { sku: row.sku, unitPriceMicro: toNumber(row.unit_price_micro), description: row.description } : null;
}
