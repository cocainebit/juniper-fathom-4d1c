import { randomBytes } from "node:crypto";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { isPaymentPayloadV2 } from "@x402/core/schemas";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequired, SettleResponse } from "@x402/core/types";
import { transaction, type Db } from "../db.js";
import { allowed, priceFor, type ServiceClient } from "../catalog.js";
import { canonicalJson, decryptPayload, encryptPayload, parsePayloadKey, payloadDigest } from "./crypto.js";
import { PaymentMismatchError, type Binding, type Confirmation, type Rail } from "./rail.js";
import * as store from "./store.js";
import type { ChargeRow, ChargeStatus } from "./store.js";

/**
 * x402 charges, one per paid action. Framework-free: the HTTP layer maps routes onto these calls.
 *
 *   const charges = createChargeService({ db, rails, facilitator, payloadKey, publicUrl });
 *
 *   charges.create({ organizationId, userId, network, amountMicro, idempotencyKey })
 *     POST /v1/orgs/:orgId/charges. Resolves { created, charge }: 201 when created, 200 on a replay.
 *     Throws ChargeError (use its httpStatus and code). Any other error means the chain RPC or
 *     the database failed and no charge was created (503 or 500).
 *   charges.get(id)
 *     GET /v1/charges/:id. Resolves ChargeView or null. The caller checks organization membership.
 *   charges.pay(id, paymentSignatureHeader?)
 *     POST /v1/charges/:id/pay. Resolves { status, headers, body }; send all three as they are.
 *     Needs no session: any standard x402 v2 client can pay. Expose PAYMENT-REQUIRED and
 *     PAYMENT-RESPONSE to browsers.
 *   charges.reconcile({ limit? })
 *     Run every few seconds from a worker. Expires open charges past expiry and finishes
 *     settlement_pending ones. Safe to run concurrently with pay() and with itself.
 *
 * Money rules, each marked "Rule N" where it is enforced:
 *   1. The encrypted payload, payer and binding are persisted before any facilitator call.
 *   2. Credit only when rail.confirm() says confirmed, over our own RPC. A facilitator's
 *      success is never enough.
 *   3. A charge is marked paid exactly once: under its row lock, only from settlement_pending.
 *   4. One authorization pays at most one charge: unique (network, binding_id).
 *   5. A settlement_pending charge never reopens. It fails only when the rail proves the
 *      payment can no longer land; a timeout or an error is never that proof.
 *
 * Paying from a standard x402 client (@x402/core/client and @x402/fetch 2.26.0): x402Client has
 * default spend controls that cap each payment in a known asset, which includes USDC on Base and
 * Base Sepolia, at DEFAULT_MAX_AMOUNT_PER_PAYMENT = "$1" (amount <= cap). Charges run from 1 to
 * 1,000 USDC, so every charge above 1 USDC is refused by the client before it signs, with
 * "All payment requirements were rejected by spendControls.maxAmountPerPayment". Payers raise it
 * with the `spendControls` option:
 *   client.setSpendControls({ maxAmountPerPayment: "$1000" })          // x402Client
 *   wrapFetchWithPaymentFromConfig(fetch, { schemes, spendControls: { maxAmountPerPayment: "$1000" } })
 * `spendControls: false` turns all spend controls off. A token x402 does not list (such as a
 * local test token) also needs spendControls.allowedAssets: [{ network, asset }].
 */

/** SPEC.md: 0.01 to 1,000 USDC, in micro-USDC. */
export const MIN_CHARGE_MICRO = 10_000;
export const MAX_CHARGE_MICRO = 1_000_000_000;
/** SPEC.md: default charge lifetime 30 minutes, and the range a product may ask for. */
export const CHARGE_LIFETIME_MS = 30 * 60 * 1000;
export const MIN_CHARGE_LIFETIME_SECONDS = 60;
export const MAX_CHARGE_LIFETIME_SECONDS = 24 * 60 * 60;
/** x402's resource server uses 300 seconds when a route sets no maxTimeoutSeconds. */
const DEFAULT_MAX_TIMEOUT_SECONDS = 300;
/** How long pay() keeps checking for confirmations before answering 202 and leaving the rest to reconcile(). */
const DEFAULT_CONFIRM_TIMEOUT_MS = 20_000;
const DEFAULT_CONFIRM_POLL_MS = 1_000;
/** Cubicle refuses PAYMENT-SIGNATURE headers longer than 24,000 characters. */
const MAX_PAYMENT_HEADER_CHARS = 24_000;

export type ChargeServiceOptions = {
  db: Db;
  /** Keyed by CAIP-2 network as stored (RailConfig.network). */
  rails: Map<string, Rail>;
  facilitator: FacilitatorClient;
  /** PAYLOAD_KEY: 32 bytes, base64. */
  payloadKey: string;
  /** PUBLIC_URL. Charge payment URLs are built from it. */
  publicUrl: string;
  now?: () => Date;
  maxTimeoutSeconds?: number;
  confirmTimeoutMs?: number;
  confirmPollMs?: number;
};

export type CreateChargeInput = {
  /** The product asking, authenticated by its service token. */
  client: ServiceClient;
  sku: string;
  units?: number;
  /** The product's own reference for the action being paid for, e.g. publish:<project>:<revision>. */
  subject: string;
  description?: string;
  /** Who is paying, when the product knows. Charges show on that user's account page. */
  userId?: string | null;
  organizationId?: string | null;
  network?: string;
  /**
   * How long the payer has, in seconds. Default 30 minutes, at most a day. A product
   * charging ahead of time (the next hour of a running desktop) asks for longer.
   */
  expiresInSeconds?: number;
  idempotencyKey: string;
};

/** An unpriced SKU is free: no charge is created and the product just does the work. */
export type CreateChargeResult = { free: true } | { free: false; created: boolean; charge: ChargeView };

export type ChargeView = {
  id: string;
  service: string;
  sku: string;
  units: number;
  subject: string;
  description: string;
  organizationId: string | null;
  createdBy: string | null;
  network: string;
  asset: string;
  payTo: string;
  amountMicro: number;
  /** An open charge past expiry already reads as expired. */
  status: ChargeStatus;
  paymentUrl: string;
  payer: string | null;
  settlementTx: string | null;
  failureReason: string | null;
  expiresAt: string;
  paidAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** What pay() shows. The pay route needs no session, so it leaves out who owns and created the charge. */
export type PublicChargeView = Omit<ChargeView, "organizationId" | "createdBy">;

export type PayResult = { status: number; headers: Record<string, string>; body: unknown };

export type ReconcileReport = { expired: number; paid: number; failed: number; pending: number; errors: number };

export type ChargeErrorCode = "invalid_request" | "not_found" | "conflict" | "unknown_sku";

export class ChargeError extends Error {
  constructor(
    readonly code: ChargeErrorCode,
    readonly httpStatus: number,
    message: string,
  ) {
    super(message);
  }
}

export type ChargeService = {
  create(input: CreateChargeInput): Promise<CreateChargeResult>;
  findBySubject(service: string, subject: string): Promise<ChargeView | null>;
  listForUser(userId: string, limit?: number): Promise<ChargeView[]>;
  get(id: string): Promise<ChargeView | null>;
  pay(id: string, paymentSignatureHeader?: string | null): Promise<PayResult>;
  reconcile(options?: { limit?: number }): Promise<ReconcileReport>;
};

export function createChargeService(options: ChargeServiceOptions): ChargeService {
  const { db, rails, facilitator } = options;
  const payloadKey = parsePayloadKey(options.payloadKey);
  const now = options.now ?? (() => new Date());
  const maxTimeoutSeconds = options.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS;
  const confirmTimeoutMs = options.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;
  const confirmPollMs = options.confirmPollMs ?? DEFAULT_CONFIRM_POLL_MS;
  const baseUrl = options.publicUrl.replace(/\/+$/, "");
  for (const [network, rail] of rails) {
    if (rail.config.network !== network) throw new Error(`rail for ${network} is configured for ${rail.config.network}`);
  }

  const paymentUrl = (id: string) => `${baseUrl}/v1/charges/${encodeURIComponent(id)}/pay`;
  const isPastExpiry = (row: ChargeRow) => row.expiresAt.getTime() <= now().getTime();

  function view(row: ChargeRow): ChargeView {
    return {
      id: row.id,
      service: row.service,
      sku: row.sku,
      units: row.units,
      subject: row.subject,
      description: row.description,
      organizationId: row.organizationId,
      createdBy: row.createdBy,
      network: row.network,
      asset: row.asset,
      payTo: row.payTo,
      amountMicro: row.amountMicro,
      status: row.status === "open" && isPastExpiry(row) ? "expired" : row.status,
      paymentUrl: paymentUrl(row.id),
      payer: row.payer,
      settlementTx: row.settlementTx,
      failureReason: row.failureReason,
      expiresAt: row.expiresAt.toISOString(),
      paidAt: row.paidAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  function publicView(row: ChargeRow): PublicChargeView {
    const { organizationId: _organizationId, createdBy: _createdBy, ...rest } = view(row);
    return rest;
  }

  // ---------------------------------------------------------------- create

  async function create(input: CreateChargeInput): Promise<CreateChargeResult> {
    const { client, sku, subject, idempotencyKey } = input;
    const units = input.units ?? 1;
    if (!boundedString(sku, 120) || !boundedString(subject, 200)) throw new ChargeError("invalid_request", 400, "sku and subject are required");
    if (!Number.isSafeInteger(units) || units < 1 || units > 1_000_000) throw new ChargeError("invalid_request", 400, "units must be a whole number from 1 to 1000000");
    if (!boundedString(idempotencyKey, 200)) throw new ChargeError("invalid_request", 400, "Idempotency-Key must be 1 to 200 characters");
    if (input.description !== undefined && !boundedString(input.description, 200)) throw new ChargeError("invalid_request", 400, "description must be at most 200 characters");
    const lifetimeSeconds = input.expiresInSeconds ?? CHARGE_LIFETIME_MS / 1000;
    if (!Number.isSafeInteger(lifetimeSeconds) || lifetimeSeconds < MIN_CHARGE_LIFETIME_SECONDS || lifetimeSeconds > MAX_CHARGE_LIFETIME_SECONDS) {
      throw new ChargeError("invalid_request", 400, `expiresInSeconds must be a whole number from ${MIN_CHARGE_LIFETIME_SECONDS} to ${MAX_CHARGE_LIFETIME_SECONDS}`);
    }

    // The same key always returns the same answer, including "this was free".
    const existing = await store.findByIdempotencyKey(db, client.id, idempotencyKey);
    if (existing) return replayCreate(existing, input, units);

    // A SKU outside this product's prefixes is a mistake (a typo, or another product's SKU),
    // not a free action: say so rather than silently doing the work for nothing.
    if (!allowed(client, sku)) throw new ChargeError("unknown_sku", 422, `${sku} is not a SKU ${client.id} may charge`);
    // Prices are the server's: an unpriced SKU means the action costs nothing.
    const price = await priceFor(db, client, sku);
    if (!price) return { free: true };
    const amountMicro = price.unitPriceMicro * units;
    if (!Number.isSafeInteger(amountMicro) || amountMicro < MIN_CHARGE_MICRO || amountMicro > MAX_CHARGE_MICRO) {
      throw new ChargeError("invalid_request", 400, `this charge would be ${amountMicro} micro-USDC; charges run from ${MIN_CHARGE_MICRO} to ${MAX_CHARGE_MICRO}`);
    }

    const network = input.network ?? defaultNetwork();
    const rail = rails.get(network);
    if (!rail) throw new ChargeError("invalid_request", 400, `network ${String(network)} is not enabled`);

    // The checkpoint is taken before the charge exists, so a recovery scan from it cannot miss the payment.
    const checkpoint = await rail.checkpoint();
    const at = now();
    const inserted = await store.insertCharge(db, {
      id: `chg_${randomBytes(16).toString("hex")}`,
      service: client.id,
      sku,
      units,
      subject,
      description: input.description ?? price.description,
      organizationId: input.organizationId ?? null,
      createdBy: input.userId ?? null,
      network,
      asset: rail.config.asset,
      payTo: rail.config.payTo,
      amountMicro,
      idempotencyKey,
      requirements: rail.requirements(BigInt(amountMicro), maxTimeoutSeconds),
      checkpoint,
      expiresAt: new Date(at.getTime() + lifetimeSeconds * 1000),
      at,
    });
    if (inserted) return { free: false, created: true, charge: view(inserted) };
    // A concurrent request with the same key won the insert; its row decides.
    const winner = await store.findByIdempotencyKey(db, client.id, idempotencyKey);
    if (!winner) throw new Error("charge insert conflicted but no charge holds the key");
    return replayCreate(winner, input, units);
  }

  function replayCreate(row: ChargeRow, input: CreateChargeInput, units: number): CreateChargeResult {
    if (row.sku !== input.sku || row.units !== units || row.subject !== input.subject) {
      throw new ChargeError("conflict", 409, "Idempotency-Key was already used for a different charge");
    }
    return { free: false, created: false, charge: view(row) };
  }

  /** With one network enabled, a product need not name it. With several, it must. */
  function defaultNetwork(): string {
    const [only] = [...rails.keys()];
    if (rails.size !== 1 || !only) throw new ChargeError("invalid_request", 400, `name the network: ${[...rails.keys()].join(", ") || "none is enabled"}`);
    return only;
  }

  /** The newest charge a product raised for one of its subjects. */
  async function findBySubject(service: string, subject: string): Promise<ChargeView | null> {
    const row = await store.findBySubject(db, service, subject);
    return row ? view(row) : null;
  }

  /** A user's charges, newest first, for the account page. */
  async function listForUser(userId: string, limit = 50): Promise<ChargeView[]> {
    return (await store.listForUser(db, userId, Math.min(Math.max(limit, 1), 200))).map(view);
  }

  // ---------------------------------------------------------------- pay

  async function pay(id: string, header?: string | null): Promise<PayResult> {
    const charge = await store.findCharge(db, id);
    if (!charge) return errorResult(404, "not_found", "Charge not found");
    if (!header || !header.trim()) return withoutPayment(charge);

    const payload = decodePayment(header);
    if (!payload) return errorResult(400, "invalid_request", "PAYMENT-SIGNATURE must be a base64 x402 v2 payment payload");
    const digest = payloadDigest(payload);
    if (isStoredPayment(charge, digest)) return replay(charge);
    const refusal = await refuseUnlessOpen(charge);
    if (refusal) return refusal;

    const rail = rails.get(charge.network);
    if (!rail) return errorResult(409, "charge_not_open", "Payments on this charge's network are no longer enabled; create a new charge");
    let binding: Binding;
    try {
      // The rail checks every field and the payer's signature before anything is written.
      binding = await rail.bind(payload, charge.requirements);
    } catch (error) {
      // A mismatch changes nothing: the charge stays open and the payer sees the requirements again.
      if (error instanceof PaymentMismatchError) return paymentRequired(charge, error.message);
      throw error;
    }

    const claim = await claimCharge(charge.id, payload, digest, binding);
    if (claim.kind === "replay") return replay(claim.row);
    if (claim.kind === "refused") return claim.result;
    return settle(claim.row, payload);
  }

  type Claim = { kind: "claimed"; row: ChargeRow } | { kind: "replay"; row: ChargeRow } | { kind: "refused"; result: PayResult };

  /** Rule 1: the payment is written down, under the row lock, before anyone else sees it. */
  async function claimCharge(id: string, payload: PaymentPayload, digest: string, binding: Binding): Promise<Claim> {
    try {
      return await transaction(db, async (tx): Promise<Claim> => {
        const row = await store.lockCharge(tx, id);
        if (!row) return { kind: "refused", result: errorResult(404, "not_found", "Charge not found") };
        if (isStoredPayment(row, digest)) return { kind: "replay", row };
        const at = now();
        if (row.status === "open" && row.expiresAt.getTime() <= at.getTime()) {
          await store.expireIfDue(tx, id, at);
          return { kind: "refused", result: errorResult(410, "charge_expired", "This charge has expired; create a new charge") };
        }
        if (row.status !== "open") return { kind: "refused", result: refuseNewPayment(row) };
        const claimed = await store.markSettlementPending(tx, id, {
          paymentPayload: encryptPayload(payloadKey, canonicalJson(payload), id),
          payloadDigest: digest,
          payer: binding.payer,
          bindingId: binding.bindingId,
          validBefore: validBeforeOf(binding),
          at,
        });
        return { kind: "claimed", row: claimed };
      });
    } catch (error) {
      // Rule 4: the unique (network, binding_id) index refuses an authorization bound to another charge.
      if (isUniqueViolation(error, "charges_network_binding")) {
        return { kind: "refused", result: errorResult(409, "conflict", "This payment authorization is already bound to another charge") };
      }
      throw error;
    }
  }

  /** Verify and settle through the facilitator, then confirm on our own RPC. */
  async function settle(row: ChargeRow, payload: PaymentPayload): Promise<PayResult> {
    try {
      const verified = await facilitator.verify(payload, row.requirements);
      if (!verified.isValid) {
        await store.recordFacilitatorOutcome(db, row.id, { note: `verify refused: ${verified.invalidReason ?? "invalid"}` }, now());
      } else {
        const settled = await facilitator.settle(payload, row.requirements);
        // The reported hash is only a hint for confirm(), even with success: true (Rule 2).
        const reportedTx = typeof settled.transaction === "string" && settled.transaction ? settled.transaction.slice(0, 200) : undefined;
        const note = settled.success ? undefined : `settle refused: ${settled.errorReason ?? "failed"}`;
        await store.recordFacilitatorOutcome(db, row.id, { reportedTx, note }, now());
      }
    } catch (error) {
      // Rule 5: a timeout or lost response is an unknown outcome. The authorization may already be on chain.
      await store.recordFacilitatorOutcome(db, row.id, { note: `facilitator error: ${describe(error)}` }, now()).catch(() => undefined);
    }
    // A refusal is not a failure either: the same authorization could already be settled (a replay after a
    // lost response), so the chain decides. Until it does, the charge stays pending.
    return confirmAndCredit(row.id, confirmTimeoutMs);
  }

  /** Checks the chain until the charge is final or waitMs passes, then reports the charge as it stands. */
  async function confirmAndCredit(id: string, waitMs: number): Promise<PayResult> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const row = await store.findCharge(db, id);
      if (!row) return errorResult(404, "not_found", "Charge not found");
      if (row.status !== "settlement_pending") return stateResult(row);
      let outcome: SettlementOutcome = "pending";
      try {
        outcome = await checkSettlement(row);
      } catch {
        outcome = "pending";
      }
      if (outcome !== "pending") continue;
      const left = deadline - Date.now();
      if (left <= 0) return stateResult(row);
      await sleep(Math.min(confirmPollMs, left));
    }
  }

  type SettlementOutcome = "paid" | "failed" | "pending";

  /** The persisted payload, if present and intact. A rail treats its absence as "cannot prove expiry". */
  function storedPayload(row: ChargeRow): PaymentPayload | undefined {
    if (!row.paymentPayload) return undefined;
    try {
      const payload = JSON.parse(decryptPayload(payloadKey, row.paymentPayload, row.id)) as PaymentPayload;
      return row.payloadDigest && payloadDigest(payload) === row.payloadDigest ? payload : undefined;
    } catch {
      return undefined;
    }
  }

  async function checkSettlement(row: ChargeRow): Promise<SettlementOutcome> {
    const rail = rails.get(row.network);
    if (!rail || !row.payer || !row.bindingId || !row.validBefore) return "pending";
    let confirmation: Confirmation;
    try {
      confirmation = await rail.confirm({
        requirements: row.requirements,
        binding: { payer: row.payer, bindingId: row.bindingId, validBefore: row.validBefore },
        checkpoint: row.checkpoint,
        transaction: row.reportedTx ?? undefined,
        validBefore: row.validBefore,
        payload: storedPayload(row),
      });
    } catch {
      // RPC trouble proves nothing either way.
      return "pending";
    }
    if (confirmation.state === "confirmed") return (await settlePaid(row.id, confirmation)) ? "paid" : "pending";
    if (confirmation.state === "failed") return (await fail(row.id, confirmation.reason)) ? "failed" : "pending";
    return "pending";
  }

  /** Rules 2 and 3. Returns true when the charge is paid, by this call or an earlier one. */
  async function settlePaid(id: string, confirmation: { transaction: string; payer: string }): Promise<boolean> {
    return transaction(db, async (tx) => {
      const row = await store.lockCharge(tx, id);
      if (!row) return false;
      if (row.status === "paid") return true;
      if (row.status !== "settlement_pending") return false;
      // The chain must have proven the payer this charge is bound to, not just any payer.
      if (confirmation.payer !== row.payer) throw new Error(`charge ${id}: the confirmed payer is not the bound payer`);
      await store.markPaid(tx, id, { settlementTx: confirmation.transaction, at: now() });
      return true;
    });
  }

  /** Rule 5: only called when the rail proved the payment can no longer land. */
  async function fail(id: string, reason: string): Promise<boolean> {
    return transaction(db, async (tx) => {
      const row = await store.lockCharge(tx, id);
      if (!row || row.status !== "settlement_pending") return row?.status === "failed";
      await store.markFailed(tx, id, { reason: reason.slice(0, 500), at: now() });
      return true;
    });
  }

  /**
   * The same payload again (a retry, a concurrent duplicate, or a client that lost our answer).
   * Never sent to the facilitator twice: a paid charge is reported as paid, and a pending one gets
   * one more look at the chain.
   */
  async function replay(row: ChargeRow): Promise<PayResult> {
    if (row.status === "settlement_pending") return confirmAndCredit(row.id, 0);
    return stateResult(row);
  }

  /** No PAYMENT-SIGNATURE: the challenge for an open charge, otherwise where the charge stands. */
  async function withoutPayment(row: ChargeRow): Promise<PayResult> {
    if (row.status === "open" && !isPastExpiry(row)) return paymentRequired(row);
    if (row.status === "open") await store.expireIfDue(db, row.id, now());
    return stateResult(row);
  }

  /** null when the charge can take a new payment now. Marks an open charge past expiry as expired. */
  async function refuseUnlessOpen(row: ChargeRow): Promise<PayResult | null> {
    if (row.status === "open" && !isPastExpiry(row)) return null;
    if (row.status === "open") await store.expireIfDue(db, row.id, now());
    return refuseNewPayment(row);
  }

  /** A payload other than the stored one, on an charge that is not open. Nothing about it is recorded. */
  function refuseNewPayment(row: ChargeRow): PayResult {
    switch (row.status) {
      case "paid":
        return errorResult(409, "charge_not_open", "This charge is already paid");
      case "settlement_pending":
        return errorResult(409, "charge_not_open", "Another payment for this charge is being confirmed; do not pay again");
      case "failed":
        return errorResult(409, "charge_not_open", `This charge's payment failed: ${row.failureReason ?? "unknown reason"}. Create a new charge.`);
      default:
        return errorResult(410, "charge_expired", "This charge has expired; create a new charge");
    }
  }

  /** Where an charge stands, for its own payer or a caller without a payment. */
  function stateResult(row: ChargeRow): PayResult {
    if (row.status === "paid") return paidResult(row);
    if (row.status === "settlement_pending") {
      return { status: 202, headers: noStore(), body: { charge: publicView(row), message: "Payment received and being confirmed on chain. Do not pay again." } };
    }
    if (row.status === "open" && !isPastExpiry(row)) return paymentRequired(row);
    return refuseNewPayment(row);
  }

  function paymentRequired(row: ChargeRow, error?: string): PayResult {
    const required: PaymentRequired = {
      x402Version: 2,
      ...(error ? { error } : {}),
      // What an agent's client shows its owner: this charge, not the service in general.
      resource: { url: paymentUrl(row.id), description: row.description || `${row.service} ${row.sku}`, mimeType: "application/json" },
      accepts: [row.requirements],
    };
    return {
      status: 402,
      headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required), ...noStore() },
      body: { error: { code: "payment_required", message: error ?? "Payment required" }, charge: publicView(row) },
    };
  }

  function paidResult(row: ChargeRow): PayResult {
    const settled: SettleResponse = {
      success: true,
      transaction: row.settlementTx ?? "",
      network: row.requirements.network,
      ...(row.payer ? { payer: row.payer } : {}),
    };
    return { status: 200, headers: { "PAYMENT-RESPONSE": encodePaymentResponseHeader(settled), ...noStore() }, body: { charge: publicView(row) } };
  }

  // ---------------------------------------------------------------- reconcile

  async function reconcile({ limit = 100 }: { limit?: number } = {}): Promise<ReconcileReport> {
    const report: ReconcileReport = { expired: 0, paid: 0, failed: 0, pending: 0, errors: 0 };
    report.expired = (await store.expireOpenCharges(db, now())).length;
    for (const id of await store.pendingChargeIds(db, limit)) {
      try {
        const row = await store.touchPending(db, id, now());
        if (!row) continue;
        // The persisted payload must still decrypt under this charge's id and match its digest.
        // A row that fails this was altered outside the service and is left for an operator.
        if (!row.paymentPayload || !row.payloadDigest || payloadDigest(JSON.parse(decryptPayload(payloadKey, row.paymentPayload, row.id))) !== row.payloadDigest) {
          report.errors++;
          continue;
        }
        report[await checkSettlement(row)]++;
      } catch {
        report.errors++;
      }
    }
    return report;
  }

  return {
    create,
    findBySubject,
    listForUser,
    get: async (id) => {
      const row = await store.findCharge(db, id);
      return row ? view(row) : null;
    },
    pay,
    reconcile,
  };
}

/** When the signed payment stops being valid, as the rail read it from the payload. confirm() relies on it. */
function validBeforeOf(binding: Binding): Date {
  if (!(binding.validBefore instanceof Date) || Number.isNaN(binding.validBefore.getTime())) {
    throw new Error("rail returned a binding without a valid validBefore");
  }
  return binding.validBefore;
}

function isStoredPayment(row: ChargeRow, digest: string): boolean {
  return row.payloadDigest === digest && (row.status === "paid" || row.status === "settlement_pending");
}

function decodePayment(header: string): PaymentPayload | null {
  const value = header.trim();
  if (value.length > MAX_PAYMENT_HEADER_CHARS) return null;
  try {
    const decoded: unknown = decodePaymentSignatureHeader(value);
    return isPaymentPayloadV2(decoded) ? (decoded as PaymentPayload) : null;
  } catch {
    return null;
  }
}

function errorResult(status: number, code: string, message: string): PayResult {
  return { status, headers: noStore(), body: { error: { code, message } } };
}

const noStore = () => ({ "Cache-Control": "no-store" });

const boundedString = (value: unknown, max: number): value is string => typeof value === "string" && value.length >= 1 && value.length <= max;

function isUniqueViolation(error: unknown, constraint: string): boolean {
  const pgError = error as { code?: string; constraint?: string };
  return pgError?.code === "23505" && pgError.constraint === constraint;
}

/** Error text for operators, without payload contents. */
function describe(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return message.slice(0, 300);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
