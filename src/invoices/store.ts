import type { PaymentRequirements } from "@x402/core/types";
import type { Db, Tx } from "../db.js";

/**
 * SQL for the invoices table (migrations/002_invoices.sql). No business rules live here
 * beyond status guards in WHERE clauses; the service decides when each call is allowed.
 */

export type InvoiceStatus = "open" | "settlement_pending" | "paid" | "failed" | "expired";

export type InvoiceRow = {
  id: string;
  organizationId: string;
  createdBy: string;
  network: string;
  asset: string;
  payTo: string;
  amountMicro: number;
  status: InvoiceStatus;
  idempotencyKey: string;
  requirements: PaymentRequirements;
  paymentPayload: string | null;
  payloadDigest: string | null;
  payer: string | null;
  bindingId: string | null;
  checkpoint: string;
  reportedTx: string | null;
  facilitatorNote: string | null;
  settlementTx: string | null;
  failureReason: string | null;
  validBefore: Date | null;
  expiresAt: Date;
  submittedAt: Date | null;
  checkedAt: Date | null;
  paidAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type Queryable = Db | Tx;

const COLUMNS = `id, organization_id, created_by, network, asset, pay_to, amount_micro, status, idempotency_key, requirements,
  payment_payload, payload_digest, payer, binding_id, checkpoint, reported_tx, facilitator_note, settlement_tx, failure_reason,
  valid_before, expires_at, submitted_at, checked_at, paid_at, created_at, updated_at`;

function toRow(row: Record<string, unknown>): InvoiceRow {
  const amount = BigInt(row.amount_micro as string);
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    createdBy: row.created_by as string,
    network: row.network as string,
    asset: row.asset as string,
    payTo: row.pay_to as string,
    amountMicro: Number(amount),
    status: row.status as InvoiceStatus,
    idempotencyKey: row.idempotency_key as string,
    requirements: row.requirements as PaymentRequirements,
    paymentPayload: row.payment_payload as string | null,
    payloadDigest: row.payload_digest as string | null,
    payer: row.payer as string | null,
    bindingId: row.binding_id as string | null,
    checkpoint: row.checkpoint as string,
    reportedTx: row.reported_tx as string | null,
    facilitatorNote: row.facilitator_note as string | null,
    settlementTx: row.settlement_tx as string | null,
    failureReason: row.failure_reason as string | null,
    validBefore: row.valid_before as Date | null,
    expiresAt: row.expires_at as Date,
    submittedAt: row.submitted_at as Date | null,
    checkedAt: row.checked_at as Date | null,
    paidAt: row.paid_at as Date | null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

const first = (rows: Record<string, unknown>[]) => (rows[0] ? toRow(rows[0]) : null);

export type NewInvoice = {
  id: string;
  organizationId: string;
  createdBy: string;
  network: string;
  asset: string;
  payTo: string;
  amountMicro: number;
  idempotencyKey: string;
  requirements: PaymentRequirements;
  checkpoint: string;
  expiresAt: Date;
  at: Date;
};

/** Returns null when (organization_id, idempotency_key) already exists. */
export async function insertInvoice(db: Queryable, invoice: NewInvoice): Promise<InvoiceRow | null> {
  const { rows } = await db.query(
    `insert into invoices (id, organization_id, created_by, network, asset, pay_to, amount_micro, idempotency_key, requirements, checkpoint, expires_at, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
     on conflict (organization_id, idempotency_key) do nothing
     returning ${COLUMNS}`,
    [
      invoice.id,
      invoice.organizationId,
      invoice.createdBy,
      invoice.network,
      invoice.asset,
      invoice.payTo,
      invoice.amountMicro,
      invoice.idempotencyKey,
      JSON.stringify(invoice.requirements),
      invoice.checkpoint,
      invoice.expiresAt,
      invoice.at,
    ],
  );
  return first(rows);
}

export async function findInvoice(db: Queryable, id: string): Promise<InvoiceRow | null> {
  return first((await db.query(`select ${COLUMNS} from invoices where id = $1`, [id])).rows);
}

export async function findByIdempotencyKey(db: Queryable, organizationId: string, idempotencyKey: string): Promise<InvoiceRow | null> {
  return first((await db.query(`select ${COLUMNS} from invoices where organization_id = $1 and idempotency_key = $2`, [organizationId, idempotencyKey])).rows);
}

/** Row lock held until the transaction ends. Every invoice state change goes through it. */
export async function lockInvoice(tx: Tx, id: string): Promise<InvoiceRow | null> {
  return first((await tx.query(`select ${COLUMNS} from invoices where id = $1 for update`, [id])).rows);
}

export async function markSettlementPending(
  tx: Tx,
  id: string,
  fields: { paymentPayload: string; payloadDigest: string; payer: string; bindingId: string; validBefore: Date; at: Date },
): Promise<InvoiceRow> {
  const row = first(
    (
      await tx.query(
        `update invoices set status = 'settlement_pending', payment_payload = $2, payload_digest = $3, payer = $4, binding_id = $5,
           valid_before = $6, submitted_at = $7, updated_at = $7
         where id = $1 and status = 'open'
         returning ${COLUMNS}`,
        [id, fields.paymentPayload, fields.payloadDigest, fields.payer, fields.bindingId, fields.validBefore, fields.at],
      )
    ).rows,
  );
  if (!row) throw new Error(`invoice ${id} was not open when claimed`);
  return row;
}

/** The facilitator's claims, kept for recovery hints and operators. Only while settlement is pending. */
export async function recordFacilitatorOutcome(db: Queryable, id: string, outcome: { reportedTx?: string; note?: string }, at: Date): Promise<void> {
  await db.query(
    `update invoices set reported_tx = coalesce($2, reported_tx), facilitator_note = coalesce($3, facilitator_note), updated_at = $4
     where id = $1 and status = 'settlement_pending'`,
    [id, outcome.reportedTx ?? null, outcome.note ?? null, at],
  );
}

/** The signed payload is no longer needed once the outcome is final, so it is dropped. The digest stays for replays. */
export async function markPaid(tx: Tx, id: string, fields: { settlementTx: string; at: Date }): Promise<void> {
  await tx.query(
    `update invoices set status = 'paid', settlement_tx = $2, paid_at = $3, updated_at = $3, payment_payload = null, failure_reason = null
     where id = $1 and status = 'settlement_pending'`,
    [id, fields.settlementTx, fields.at],
  );
}

export async function markFailed(tx: Tx, id: string, fields: { reason: string; at: Date }): Promise<void> {
  await tx.query(
    `update invoices set status = 'failed', failure_reason = $2, updated_at = $3, payment_payload = null
     where id = $1 and status = 'settlement_pending'`,
    [id, fields.reason, fields.at],
  );
}

/** Expires one invoice if it is still open and past expiry. */
export async function expireIfDue(db: Queryable, id: string, at: Date): Promise<void> {
  await db.query(`update invoices set status = 'expired', updated_at = $2 where id = $1 and status = 'open' and expires_at <= $2`, [id, at]);
}

/**
 * Expires every open invoice past expiry. Under READ COMMITTED an UPDATE that meets a row
 * locked by a concurrent claim waits and re-checks `status = 'open'`, so a claimed invoice is skipped.
 */
export async function expireOpenInvoices(db: Queryable, at: Date): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `update invoices set status = 'expired', updated_at = $1 where status = 'open' and expires_at <= $1 returning id`,
    [at],
  );
  return rows.map((row) => row.id);
}

/** Least recently checked first, so one stuck invoice cannot starve the rest. */
export async function pendingInvoiceIds(db: Queryable, limit: number): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `select id from invoices where status = 'settlement_pending' order by checked_at asc nulls first, submitted_at asc limit $1`,
    [limit],
  );
  return rows.map((row) => row.id);
}

/** Stamps checked_at and returns the row, or null if it is no longer pending. */
export async function touchPending(db: Queryable, id: string, at: Date): Promise<InvoiceRow | null> {
  return first((await db.query(`update invoices set checked_at = $2 where id = $1 and status = 'settlement_pending' returning ${COLUMNS}`, [id, at])).rows);
}
