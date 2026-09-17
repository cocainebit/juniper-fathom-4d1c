-- Pay per action, no balance. Invoices for credit top-ups become charges for one
-- action: the product, the SKU, what it is for, and the amount. The credit ledger
-- (balances and debits) is gone; prices and service clients stay.

alter table invoices rename to charges;
alter index invoices_pkey rename to charges_pkey;
alter index invoices_network_binding rename to charges_network_binding;
alter index invoices_org_created rename to charges_org_created;
alter index invoices_pending rename to charges_pending;
alter index invoices_open_expiry rename to charges_open_expiry;

alter table charges
  add column service text not null default 'platform' references service_clients (id),
  add column sku text not null default '',
  add column units bigint not null default 1 check (units > 0),
  -- The product's own reference for the action being paid for, e.g. publish:<project>:<revision>.
  add column subject text not null default '',
  add column description text not null default '',
  alter column organization_id drop not null,
  alter column created_by drop not null,
  -- Charges start at one cent, where top-ups started at one dollar.
  drop constraint invoices_amount_micro_check,
  add constraint charges_amount_micro_check check (amount_micro between 10000 and 1000000000);

-- One key per calling product, and a product can find the charge for a subject again.
alter table charges drop constraint invoices_organization_id_idempotency_key_key;
create unique index charges_service_idempotency_key on charges (service, idempotency_key);
create index charges_service_subject on charges (service, subject, created_at desc) where subject <> '';

drop table credit_entries;
drop table credit_accounts;
