-- x402 top-up invoices. States: open -> settlement_pending -> paid | failed, and open -> expired.
-- An invoice is credited once, under the ledger key invoice:<id>, only after our own RPC
-- confirms the transfer. See src/invoices/service.ts.

create table invoices (
  id text primary key,
  organization_id text not null,
  created_by text not null,
  -- CAIP-2 network as stored and shown (RailConfig.network).
  network text not null,
  asset text not null,
  pay_to text not null,
  -- 1 to 1,000 USDC in micro-USDC (SPEC.md).
  amount_micro bigint not null check (amount_micro between 1000000 and 1000000000),
  status text not null default 'open' check (status in ('open', 'settlement_pending', 'paid', 'failed', 'expired')),
  idempotency_key text not null check (length(idempotency_key) between 1 and 200),
  -- The x402 v2 PaymentRequirements offered for this invoice. Immutable after insert.
  requirements jsonb not null,
  -- AES-256-GCM ciphertext of the payment payload (src/invoices/crypto.ts). Written before any
  -- facilitator call so a lost response can be recovered; cleared once the invoice is paid or failed.
  payment_payload text,
  -- SHA-256 of the canonical payload JSON. Kept after paid so a replayed payload is recognized.
  payload_digest text,
  payer text,
  -- EVM: the EIP-3009 authorization nonce. Solana: the payer's transaction signature.
  binding_id text,
  -- Chain position captured before insert (EVM block number, Solana slot): recovery scans start here.
  checkpoint text not null,
  -- What the facilitator said it broadcast. Unverified; never a reason to credit.
  reported_tx text,
  -- Why the facilitator did not settle, for operators. Never a reason to credit or to fail.
  facilitator_note text,
  -- The transaction our own RPC confirmed.
  settlement_tx text,
  failure_reason text,
  valid_before timestamptz,
  expires_at timestamptz not null,
  submitted_at timestamptz,
  checked_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, idempotency_key),
  check (status in ('open', 'expired') or (payer is not null and binding_id is not null and payload_digest is not null)),
  check (status <> 'paid' or (settlement_tx is not null and paid_at is not null))
);

-- One authorization can never pay two invoices.
create unique index invoices_network_binding on invoices (network, binding_id) where binding_id is not null;

create index invoices_org_created on invoices (organization_id, created_at desc);
create index invoices_pending on invoices (checked_at nulls first) where status = 'settlement_pending';
create index invoices_open_expiry on invoices (expires_at) where status = 'open';
