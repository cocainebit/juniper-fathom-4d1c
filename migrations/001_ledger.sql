-- Credits: integer micro-USDC per organization. A balance never goes negative.

create table credit_accounts (
  organization_id text primary key,
  balance_micro bigint not null default 0 check (balance_micro >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Server-owned prices. Callers send a SKU and units, never an amount.
create table price_catalog (
  sku text primary key check (sku ~ '^[a-z0-9]+(\.[a-z0-9-]+)+$' and length(sku) <= 120),
  unit_price_micro bigint not null check (unit_price_micro > 0),
  description text not null default '',
  active boolean not null default true,
  updated_at timestamptz not null default now()
);

-- Products calling the internal API. Only a SHA-256 of each secret is stored.
create table service_clients (
  id text primary key check (id ~ '^[a-z][a-z0-9-]{1,39}$'),
  token_hash bytea not null unique,
  sku_prefixes text[] not null check (cardinality(sku_prefixes) > 0),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

-- Every balance change. (service, idempotency_key) is the replay guard.
-- service is a service client id, or "platform" for invoices and operator adjustments.
create table credit_entries (
  id bigserial primary key,
  organization_id text not null references credit_accounts (organization_id),
  service text not null,
  idempotency_key text not null check (length(idempotency_key) between 1 and 200),
  kind text not null check (kind in ('grant', 'debit')),
  sku text,
  units bigint check (units > 0),
  unit_price_micro bigint,
  amount_micro bigint not null check (amount_micro > 0),
  balance_after_micro bigint not null check (balance_after_micro >= 0),
  reason text not null,
  request_hash text not null,
  created_at timestamptz not null default now(),
  unique (service, idempotency_key)
);

create index credit_entries_org_created on credit_entries (organization_id, created_at desc, id desc);
