import { randomBytes } from "node:crypto";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { isPaymentPayloadV2 } from "@x402/core/schemas";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequired, SettleResponse } from "@x402/core/types";
import { transaction, type Db } from "../db.js";
import { grant } from "../ledger.js";
import { canonicalJson, decryptPayload, encryptPayload, parsePayloadKey, payloadDigest } from "./crypto.js";
import { PaymentMismatchError, type Binding, type Confirmation, type Rail } from "./rail.js";
import * as store from "./store.js";
import type { InvoiceRow, InvoiceStatus } from "./store.js";

/**
 * x402 top-up invoices. Framework-free: the HTTP layer maps routes onto these calls.
 *
 *   const invoices = createInvoiceService({ db, rails, facilitator, payloadKey, publicUrl });
 *
 *   invoices.create({ organizationId, userId, network, amountMicro, idempotencyKey })
 *     POST /v1/orgs/:orgId/invoices. Resolves { created, invoice }: 201 when created, 200 on a replay.
 *     Throws InvoiceError (use its httpStatus and code). Any other error means the chain RPC or
 *     the database failed and no invoice was created (503 or 500).
 *   invoices.get(id)
 *     GET /v1/invoices/:id. Resolves InvoiceView or null. The caller checks organization membership.
 *   invoices.pay(id, paymentSignatureHeader?)
 *     POST /v1/invoices/:id/pay. Resolves { status, headers, body }; send all three as they are.
 *     Needs no session: any standard x402 v2 client can pay. Expose PAYMENT-REQUIRED and
 *     PAYMENT-RESPONSE to browsers.
 *   invoices.reconcile({ limit? })
 *     Run every few seconds from a worker. Expires open invoices past expiry and finishes
 *     settlement_pending ones. Safe to run concurrently with pay() and with itself.
 *
 * Money rules, each marked "Rule N" where it is enforced:
 *   1. The encrypted payload, payer and binding are persisted before any facilitator call.
 *   2. Credit only when rail.confirm() says confirmed, over our own RPC. A facilitator's
 *      success is never enough.
 *   3. Credit exactly once: under the invoice row lock, only from settlement_pending, with
 *      grant() keyed invoice:<id>, in the same transaction that marks the invoice paid.
 *   4. One authorization pays at most one invoice: unique (network, binding_id).
 *   5. A settlement_pending invoice never reopens. It fails only when the rail proves the
 *      payment can no longer land; a timeout or an error is never that proof.
 */

/** SPEC.md: 1 to 1,000 USDC, in micro-USDC. */
export const MIN_INVOICE_MICRO = 1_000_000;
export const MAX_INVOICE_MICRO = 1_000_000_000;
/** SPEC.md: invoice lifetime 30 minutes. */
export const INVOICE_LIFETIME_MS = 30 * 60 * 1000;
/** x402's resource server uses 300 seconds when a route sets no maxTimeoutSeconds. */
const DEFAULT_MAX_TIMEOUT_SECONDS = 300;
/** How long pay() keeps checking for confirmations before answering 202 and leaving the rest to reconcile(). */
const DEFAULT_CONFIRM_TIMEOUT_MS = 20_000;
const DEFAULT_CONFIRM_POLL_MS = 1_000;
/** Cubicle refuses PAYMENT-SIGNATURE headers longer than 24,000 characters. */
const MAX_PAYMENT_HEADER_CHARS = 24_000;
/** Payer clock drift allowance, used only for a rail whose binding does not report validBefore. */
const FALLBACK_CLOCK_SKEW_SECONDS = 30;

export type InvoiceServiceOptions = {
  db: Db;
  /** Keyed by CAIP-2 network as stored (RailConfig.network). */
  rails: Map<string, Rail>;
  facilitator: FacilitatorClient;
  /** PAYLOAD_KEY: 32 bytes, base64. */
  payloadKey: string;
  /** PUBLIC_URL. Invoice payment URLs are built from it. */
  publicUrl: string;
  now?: () => Date;
  maxTimeoutSeconds?: number;
  confirmTimeoutMs?: number;
  confirmPollMs?: number;
};

export type CreateInvoiceInput = {
  organizationId: string;
  userId: string;
  network: string;
  amountMicro: number;
  idempotencyKey: string;
};

export type InvoiceView = {
  id: string;
  organizationId: string;
  createdBy: string;
  network: string;
  asset: string;
  payTo: string;
  amountMicro: number;
  /** An open invoice past expiry already reads as expired. */
  status: InvoiceStatus;
  paymentUrl: string;
  payer: string | null;
  settlementTx: string | null;
  failureReason: string | null;
  expiresAt: string;
  paidAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** What pay() shows. The pay route needs no session, so it leaves out who owns and created the invoice. */
export type PublicInvoiceView = Omit<InvoiceView, "organizationId" | "createdBy">;

export type PayResult = { status: number; headers: Record<string, string>; body: unknown };

export type ReconcileReport = { expired: number; paid: number; failed: number; pending: number; errors: number };

export type InvoiceErrorCode = "invalid_request" | "not_found" | "conflict";

export class InvoiceError extends Error {
  constructor(
    readonly code: InvoiceErrorCode,
    readonly httpStatus: number,
    message: string,
  ) {
    super(message);
  }
}

export type InvoiceService = {
  create(input: CreateInvoiceInput): Promise<{ created: boolean; invoice: InvoiceView }>;
  get(id: string): Promise<InvoiceView | null>;
  pay(id: string, paymentSignatureHeader?: string | null): Promise<PayResult>;
  reconcile(options?: { limit?: number }): Promise<ReconcileReport>;
};

export function createInvoiceService(options: InvoiceServiceOptions): InvoiceService {
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

  const paymentUrl = (id: string) => `${baseUrl}/v1/invoices/${encodeURIComponent(id)}/pay`;
  const isPastExpiry = (row: InvoiceRow) => row.expiresAt.getTime() <= now().getTime();

  function view(row: InvoiceRow): InvoiceView {
    return {
      id: row.id,
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

  function publicView(row: InvoiceRow): PublicInvoiceView {
    const { organizationId: _organizationId, createdBy: _createdBy, ...rest } = view(row);
    return rest;
  }

  // ---------------------------------------------------------------- create

  async function create(input: CreateInvoiceInput) {
    const { organizationId, userId, network, amountMicro, idempotencyKey } = input;
    if (!boundedString(organizationId, 100) || !boundedString(userId, 200)) {
      throw new InvoiceError("invalid_request", 400, "organizationId and userId are required");
    }
    if (!Number.isSafeInteger(amountMicro) || amountMicro < MIN_INVOICE_MICRO || amountMicro > MAX_INVOICE_MICRO) {
      throw new InvoiceError("invalid_request", 400, "amountMicro must be a whole number from 1000000 to 1000000000 (1 to 1,000 USDC)");
    }
    if (!boundedString(idempotencyKey, 200)) throw new InvoiceError("invalid_request", 400, "Idempotency-Key must be 1 to 200 characters");
    const rail = rails.get(network);
    if (!rail) throw new InvoiceError("invalid_request", 400, `network ${String(network)} is not enabled`);

    const existing = await store.findByIdempotencyKey(db, organizationId, idempotencyKey);
    if (existing) return replayCreate(existing, input);

    // The checkpoint is taken before the invoice exists, so a recovery scan from it cannot miss the payment.
    const checkpoint = await rail.checkpoint();
    const at = now();
    const inserted = await store.insertInvoice(db, {
      id: `inv_${randomBytes(16).toString("hex")}`,
      organizationId,
      createdBy: userId,
      network,
      asset: rail.config.asset,
      payTo: rail.config.payTo,
      amountMicro,
      idempotencyKey,
      requirements: rail.requirements(BigInt(amountMicro), maxTimeoutSeconds),
      checkpoint,
      expiresAt: new Date(at.getTime() + INVOICE_LIFETIME_MS),
      at,
    });
    if (inserted) return { created: true, invoice: view(inserted) };
    // A concurrent request with the same key won the insert; its row decides.
    const winner = await store.findByIdempotencyKey(db, organizationId, idempotencyKey);
    if (!winner) throw new Error("invoice insert conflicted but no invoice holds the key");
    return replayCreate(winner, input);
  }

  function replayCreate(row: InvoiceRow, input: CreateInvoiceInput) {
    if (row.amountMicro !== input.amountMicro || row.network !== input.network) {
      throw new InvoiceError("conflict", 409, "Idempotency-Key was already used for a different invoice");
    }
    return { created: false, invoice: view(row) };
  }

  // ---------------------------------------------------------------- pay

  async function pay(id: string, header?: string | null): Promise<PayResult> {
    const invoice = await store.findInvoice(db, id);
    if (!invoice) return errorResult(404, "not_found", "Invoice not found");
    if (!header || !header.trim()) return withoutPayment(invoice);

    const payload = decodePayment(header);
    if (!payload) return errorResult(400, "invalid_request", "PAYMENT-SIGNATURE must be a base64 x402 v2 payment payload");
    const digest = payloadDigest(payload);
    if (isStoredPayment(invoice, digest)) return replay(invoice);
    const refusal = await refuseUnlessOpen(invoice);
    if (refusal) return refusal;

    const rail = rails.get(invoice.network);
    if (!rail) return errorResult(409, "invoice_not_open", "Payments on this invoice's network are no longer enabled; create a new invoice");
    let binding: Binding;
    try {
      binding = rail.bind(payload, invoice.requirements);
    } catch (error) {
      // A mismatch changes nothing: the invoice stays open and the payer sees the requirements again.
      if (error instanceof PaymentMismatchError) return paymentRequired(invoice, error.message);
      throw error;
    }

    const claim = await claimInvoice(invoice.id, payload, digest, binding);
    if (claim.kind === "replay") return replay(claim.row);
    if (claim.kind === "refused") return claim.result;
    return settle(claim.row, payload);
  }

  type Claim = { kind: "claimed"; row: InvoiceRow } | { kind: "replay"; row: InvoiceRow } | { kind: "refused"; result: PayResult };

  /** Rule 1: the payment is written down, under the row lock, before anyone else sees it. */
  async function claimInvoice(id: string, payload: PaymentPayload, digest: string, binding: Binding): Promise<Claim> {
    try {
      return await transaction(db, async (tx): Promise<Claim> => {
        const row = await store.lockInvoice(tx, id);
        if (!row) return { kind: "refused", result: errorResult(404, "not_found", "Invoice not found") };
        if (isStoredPayment(row, digest)) return { kind: "replay", row };
        const at = now();
        if (row.status === "open" && row.expiresAt.getTime() <= at.getTime()) {
          await store.expireIfDue(tx, id, at);
          return { kind: "refused", result: errorResult(410, "invoice_expired", "This invoice has expired; create a new invoice") };
        }
        if (row.status !== "open") return { kind: "refused", result: refuseNewPayment(row) };
        const claimed = await store.markSettlementPending(tx, id, {
          paymentPayload: encryptPayload(payloadKey, canonicalJson(payload), id),
          payloadDigest: digest,
          payer: binding.payer,
          bindingId: binding.bindingId,
          validBefore: validBeforeOf(binding, row, at),
          at,
        });
        return { kind: "claimed", row: claimed };
      });
    } catch (error) {
      // Rule 4: the unique (network, binding_id) index refuses an authorization bound to another invoice.
      if (isUniqueViolation(error, "invoices_network_binding")) {
        return { kind: "refused", result: errorResult(409, "conflict", "This payment authorization is already bound to another invoice") };
      }
      throw error;
    }
  }

  /** Verify and settle through the facilitator, then confirm on our own RPC. */
  async function settle(row: InvoiceRow, payload: PaymentPayload): Promise<PayResult> {
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
    // lost response), so the chain decides. Until it does, the invoice stays pending.
    return confirmAndCredit(row.id, confirmTimeoutMs);
  }

  /** Checks the chain until the invoice is final or waitMs passes, then reports the invoice as it stands. */
  async function confirmAndCredit(id: string, waitMs: number): Promise<PayResult> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const row = await store.findInvoice(db, id);
      if (!row) return errorResult(404, "not_found", "Invoice not found");
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

  async function checkSettlement(row: InvoiceRow): Promise<SettlementOutcome> {
    const rail = rails.get(row.network);
    if (!rail || !row.payer || !row.bindingId || !row.validBefore) return "pending";
    let confirmation: Confirmation;
    try {
      confirmation = await rail.confirm({
        requirements: row.requirements,
        binding: { payer: row.payer, bindingId: row.bindingId },
        checkpoint: row.checkpoint,
        transaction: row.reportedTx ?? undefined,
        validBefore: row.validBefore,
      });
    } catch {
      // RPC trouble proves nothing either way.
      return "pending";
    }
    if (confirmation.state === "confirmed") return (await credit(row.id, confirmation)) ? "paid" : "pending";
    if (confirmation.state === "failed") return (await fail(row.id, confirmation.reason)) ? "failed" : "pending";
    return "pending";
  }

  /** Rules 2 and 3. Returns true when the invoice is paid, by this call or an earlier one. */
  async function credit(id: string, confirmation: { transaction: string; payer: string }): Promise<boolean> {
    return transaction(db, async (tx) => {
      const row = await store.lockInvoice(tx, id);
      if (!row) return false;
      if (row.status === "paid") return true;
      if (row.status !== "settlement_pending") return false;
      // The chain must have proven the payer this invoice is bound to, not just any payer.
      if (confirmation.payer !== row.payer) throw new Error(`invoice ${id}: the confirmed payer is not the bound payer`);
      const outcome = await grant(tx, { organizationId: row.organizationId, amountMicro: row.amountMicro, idempotencyKey: `invoice:${id}`, reason: "x402 top-up" });
      if (outcome.status === "conflict") throw new Error(`invoice ${id}: ledger key invoice:${id} already holds a different grant`);
      await store.markPaid(tx, id, { settlementTx: confirmation.transaction, at: now() });
      return true;
    });
  }

  /** Rule 5: only called when the rail proved the payment can no longer land. */
  async function fail(id: string, reason: string): Promise<boolean> {
    return transaction(db, async (tx) => {
      const row = await store.lockInvoice(tx, id);
      if (!row || row.status !== "settlement_pending") return row?.status === "failed";
      await store.markFailed(tx, id, { reason: reason.slice(0, 500), at: now() });
      return true;
    });
  }

  /**
   * The same payload again (a retry, a concurrent duplicate, or a client that lost our answer).
   * Never sent to the facilitator twice: a paid invoice is reported as paid, and a pending one gets
   * one more look at the chain.
   */
  async function replay(row: InvoiceRow): Promise<PayResult> {
    if (row.status === "settlement_pending") return confirmAndCredit(row.id, 0);
    return stateResult(row);
  }

  /** No PAYMENT-SIGNATURE: the challenge for an open invoice, otherwise where the invoice stands. */
  async function withoutPayment(row: InvoiceRow): Promise<PayResult> {
    if (row.status === "open" && !isPastExpiry(row)) return paymentRequired(row);
    if (row.status === "open") await store.expireIfDue(db, row.id, now());
    return stateResult(row);
  }

  /** null when the invoice can take a new payment now. Marks an open invoice past expiry as expired. */
  async function refuseUnlessOpen(row: InvoiceRow): Promise<PayResult | null> {
    if (row.status === "open" && !isPastExpiry(row)) return null;
    if (row.status === "open") await store.expireIfDue(db, row.id, now());
    return refuseNewPayment(row);
  }

  /** A payload other than the stored one, on an invoice that is not open. Nothing about it is recorded. */
  function refuseNewPayment(row: InvoiceRow): PayResult {
    switch (row.status) {
      case "paid":
        return errorResult(409, "invoice_not_open", "This invoice is already paid");
      case "settlement_pending":
        return errorResult(409, "invoice_not_open", "Another payment for this invoice is being confirmed; do not pay again");
      case "failed":
        return errorResult(409, "invoice_not_open", `This invoice's payment failed: ${row.failureReason ?? "unknown reason"}. Create a new invoice.`);
      default:
        return errorResult(410, "invoice_expired", "This invoice has expired; create a new invoice");
    }
  }

  /** Where an invoice stands, for its own payer or a caller without a payment. */
  function stateResult(row: InvoiceRow): PayResult {
    if (row.status === "paid") return paidResult(row);
    if (row.status === "settlement_pending") {
      return { status: 202, headers: noStore(), body: { invoice: publicView(row), message: "Payment received and being confirmed on chain. Do not pay again." } };
    }
    if (row.status === "open" && !isPastExpiry(row)) return paymentRequired(row);
    return refuseNewPayment(row);
  }

  function paymentRequired(row: InvoiceRow, error?: string): PayResult {
    const required: PaymentRequired = {
      x402Version: 2,
      ...(error ? { error } : {}),
      resource: { url: paymentUrl(row.id), description: "Platform credits top-up", mimeType: "application/json" },
      accepts: [row.requirements],
    };
    return {
      status: 402,
      headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required), ...noStore() },
      body: { error: { code: "payment_required", message: error ?? "Payment required" }, invoice: publicView(row) },
    };
  }

  function paidResult(row: InvoiceRow): PayResult {
    const settled: SettleResponse = {
      success: true,
      transaction: row.settlementTx ?? "",
      network: row.requirements.network,
      ...(row.payer ? { payer: row.payer } : {}),
    };
    return { status: 200, headers: { "PAYMENT-RESPONSE": encodePaymentResponseHeader(settled), ...noStore() }, body: { invoice: publicView(row) } };
  }

  // ---------------------------------------------------------------- reconcile

  async function reconcile({ limit = 100 }: { limit?: number } = {}): Promise<ReconcileReport> {
    const report: ReconcileReport = { expired: 0, paid: 0, failed: 0, pending: 0, errors: 0 };
    report.expired = (await store.expireOpenInvoices(db, now())).length;
    for (const id of await store.pendingInvoiceIds(db, limit)) {
      try {
        const row = await store.touchPending(db, id, now());
        if (!row) continue;
        // The persisted payload must still decrypt under this invoice's id and match its digest.
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
    get: async (id) => {
      const row = await store.findInvoice(db, id);
      return row ? view(row) : null;
    },
    pay,
    reconcile,
  };
}

/**
 * When the payment can no longer land. The EVM rail reports the authorization's own validBefore on
 * its binding. rail.ts's Binding has no such field, so for a rail that does not report one, use the
 * latest time a payload signed now could be valid until: now + maxTimeoutSeconds + clock skew.
 */
function validBeforeOf(binding: Binding, row: InvoiceRow, at: Date): Date {
  const reported = (binding as Binding & { validBefore?: unknown }).validBefore;
  if (reported instanceof Date && !Number.isNaN(reported.getTime())) return reported;
  return new Date(at.getTime() + (row.requirements.maxTimeoutSeconds + FALLBACK_CLOCK_SKEW_SECONDS) * 1000);
}

function isStoredPayment(row: InvoiceRow, digest: string): boolean {
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
