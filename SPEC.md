# Platform service contract

Version 0 (2026-09-17). Local and testnet only. Consumers: Plotform, Cubicle, Floatlane.

## Concepts

- **User**: one person. Signs in with an Ethereum wallet (SIWE, EIP-4361), a Solana wallet (Sign In With Solana through `@solana/wallet-standard-util` `verifySignIn`), or an emailed one-time code. `sub` in every token is the user id.
- **Organization**: who owns a balance. Every user gets a personal organization on first sign-in; teams create more. Cubicle workspaces and Floatlane organizations map to one of these.
- **Linked wallet**: a `(chain_family, address)` pair proven by a signature, belonging to exactly one user. `chain_family` is `eip155` or `solana`. EVM addresses are EIP-55 checksummed; Solana addresses are base58 as given.
- **Credits**: an integer balance in micro-USDC per organization (1 USDC = 1,000,000). It never goes negative.
- **SKU**: a server-owned price key, lowercase dot-separated, e.g. `cubicle.minute.cpu2-mem4`, `plotform.generate.site`. Callers send SKUs and units, never amounts.
- **Service client**: a product calling the internal API with its own secret, allowed to debit only SKUs under its prefixes (`cubicle.*` for Cubicle).

## Identity for products

The service is an OAuth 2.1 and OpenID Connect provider (better-auth `@better-auth/oauth-provider` plus `jwt`).

- Discovery: `GET {issuer}/.well-known/openid-configuration`, where `{issuer}` is `http://127.0.0.1:8760/api/auth` locally.
- Signing keys: `GET /api/auth/jwks`.
- Products are registered as trusted confidential clients (no consent screen) with the admin CLI and use the authorization code flow with PKCE.
- Access tokens are JWTs with `iss`, `aud` (the product's resource URL), `sub` (user id), `sid`, `scope`, `exp`. Verify them with the JWKS (Cubicle: `security.identity()`), or use the ID token in a better-auth `generic-oauth` client (Plotform).
- Linking a product-local identity (a Cubicle Supabase user, a Floatlane principal) to `sub` is the product's job. Floatlane requires a wallet signature at link time and never derives a role from the link.

## Public API (user session)

Authentication: the better-auth session cookie, or `Authorization: Bearer <session token>`.

| Method and path | Purpose |
| --- | --- |
| `GET /v1/me` | User, linked wallets, organizations with the caller's role |
| `GET /v1/orgs/:orgId/credits` | Balance and the latest 50 ledger entries (members only) |
| `POST /v1/orgs/:orgId/invoices` | Create a top-up invoice. Header `Idempotency-Key`. Body `{ amountMicro, network }`. Owners and admins only |
| `GET /v1/invoices/:id` | Invoice state (org members only) |
| `POST /v1/invoices/:id/pay` | x402 v2 endpoint. Without `PAYMENT-SIGNATURE`: `402` with a `PAYMENT-REQUIRED` header. With it: persist, verify, settle, reconcile, credit. Payable by any standard x402 v2 client; the payer does not need an account |

Invoice networks: `eip155:84532` (Base Sepolia), `eip155:8453` (Base), `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` (devnet), `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` (mainnet), plus local chains in tests. Amount bounds: 1 to 1,000 USDC. Invoice lifetime: 30 minutes.

Invoice states: `open -> settlement_pending -> paid | failed`, and `open -> expired`. An invoice is credited once, under the ledger key `invoice:<id>`, and only after our own RPC confirms the transfer to `payTo` of exactly `amountMicro` of the configured USDC (EVM: an `AuthorizationUsed(payer, nonce)` and `Transfer(payer, payTo, amount)` in a receipt with enough confirmations; Solana: a finalized transaction with that SPL transfer). A lost response is recovered by the reconciler from the persisted payload.

## Internal API (service clients)

Authentication: `Authorization: Bearer <service secret>`. Server to server only; never exposed to browsers or to product API keys.

| Method and path | Purpose |
| --- | --- |
| `GET /internal/v1/prices` | Active SKUs this service may debit, with `unitPriceMicro` |
| `GET /internal/v1/orgs/:orgId/balance` | `{ organizationId, balanceMicro, asOf }`. Safe to cache briefly |
| `POST /internal/v1/usage` | One debit. Header `Idempotency-Key`. Body `{ organizationId, sku, units }` |
| `POST /internal/v1/usage/batch` | Up to 500 debits. Body `{ items: [{ idempotencyKey, organizationId, sku, units }] }` |
| `GET /internal/v1/users/:sub` | User, linked wallets, organizations (for account linking) |

Debit outcome per item:

- `applied`: charged `amountMicro` = `units * unitPriceMicro`; returns `balanceAfterMicro`.
- `replayed`: this service already used this key with the same `organizationId`, `sku` and `units`; the original result is returned and nothing is charged again.
- `conflict`: the key was used with different parameters. Nothing charged. HTTP 409 for the single form.
- `insufficient_funds`: the balance is lower than the cost. Nothing charged, nothing recorded. HTTP 402 for the single form.
- `unknown_sku`: the SKU is not active or not under this service's prefixes. HTTP 422 for the single form.

Idempotency keys are 1 to 200 characters, taken verbatim, unique per service client. A batch runs in one transaction with account rows locked in a fixed order; its items are decided independently, so one organization running out does not fail the others. On a server or network error the caller retries the whole batch with the same keys.

## Errors

JSON `{ "error": { "code": "...", "message": "..." } }`. Codes: `unauthorized`, `forbidden`, `not_found`, `invalid_request`, `conflict`, `insufficient_funds`, `unknown_sku`, `payment_required`, `invoice_expired`, `invoice_not_open`, `rate_limited`.

## Not in version 0

Trials (they move here from Cubicle next), subscriptions, refunds (manual transfers), events or webhooks to products (poll balance for now), agent API keys, hosted checkout UI beyond the sign-in page.
