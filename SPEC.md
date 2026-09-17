# Platform service contract

Version 0.2 (2026-09-17). Local and testnet only. Consumers: Plotform, Cubicle, Floatlane.

Running locally at `http://127.0.0.1:8760`. Operator commands: `pnpm admin` (service tokens, prices, OAuth clients).

**Pay per action, no balance.** A product asks for a charge when someone does something that costs money, the payer pays that charge, and the product does the work. Nothing is stored up, nothing carries between products, and a payment for one action never pays for another. Every product opens the same payment sheet, so the prompt is the same everywhere. Version 0.1 had a shared credit balance; it was removed on the owner's instruction.

## Concepts

- **User**: one person. Signs in with an Ethereum wallet (SIWE, EIP-4361), a Solana wallet (Sign In With Solana through `@solana/wallet-standard-util` `verifySignIn`), or an emailed one-time code. `sub` in every token is the user id. One account across every product; a wallet belongs to exactly one account.
- **Organization**: a workspace a user belongs to. Charges are recorded against it so a team can see what its people paid for. Every user gets a personal one.
- **Charge**: one payable action. It carries the product, the SKU, what it is for (`subject`, the product's own reference), the amount, and its state. `open -> settlement_pending -> paid`, or `open -> expired`, or `settlement_pending -> failed`. A charge is paid once, by exactly one payment.
- **SKU**: a server-owned price key, lowercase dot-separated, e.g. `plotform.publish`, `cubicle.minute.cpu2-mem4`. Products send a SKU and units, never an amount. A SKU with no price means the action is free: the product does the work without asking for payment.
- **Service client**: a product calling the internal API with its own secret, allowed to charge only SKUs under its prefixes (`plotform.*` for Plotform).

## Identity for products

The service is an OAuth 2.1 and OpenID Connect provider (better-auth `@better-auth/oauth-provider` plus `jwt`).

- Discovery: `GET {issuer}/.well-known/openid-configuration`, where `{issuer}` is `http://127.0.0.1:8760/api/auth` locally. Signing keys: `GET /api/auth/jwks`.
- Products register with `pnpm admin client create <name> <redirect-uri> [resource-url]` as trusted confidential clients (no consent screen) and use the authorization code flow with PKCE. Local loopback redirects register as native clients; deployed ones must be https. Signed-in users cannot register clients.
- A product API that verifies access tokens (Cubicle) must be listed as a resource: start the service with `OAUTH_RESOURCES=<its URL>` and register its client with that resource URL, which becomes the token's `aud`.
- better-auth products use the `generic-oauth` plugin with `discoveryUrl` and sign in through `/sign-in/social` with `provider: "<providerId>"`; the callback is `{product}/api/auth/callback/<providerId>` (Plotform's is `http://127.0.0.1:5173/api/auth/callback/platform`).
- Pages: `/sign-in` (Ethereum wallet, Solana wallet, or emailed code), `/account` (linked wallets and payment history), `/pay/:chargeId` (the payment sheet).

## Paying for an action

1. Someone does something that costs money in a product.
2. The product's server calls `POST /internal/v1/charges` with the SKU, units, its own `subject` and an `Idempotency-Key`. An unpriced SKU comes back `{ free: true }` and the product just does the work.
3. The product answers its own client with `402` and the charge's `payUrl`, or opens `payUrl` directly. A person pays on the payment sheet; an AI agent pays `paymentUrl` over x402 with no UI.
4. The product re-checks with `GET /internal/v1/charges/:id` (or retries its own request, which re-checks by `subject`) and does the work once the charge is `paid`.

A charge is paid only after our own RPC confirms the exact transfer to the receiving address, never on a facilitator's word. Paying the same charge twice is refused. A charge expires 30 minutes after it is created; expired charges are never paid, and the product asks for a new one.

## Internal API (service clients)

Authentication: `Authorization: Bearer <service secret>`. Server to server only; never exposed to browsers or to product API keys.

| Method and path | Purpose |
| --- | --- |
| `GET /internal/v1/prices` | Active SKUs this product may charge, with `unitPriceMicro` |
| `POST /internal/v1/charges` | Create or replay a charge. Header `Idempotency-Key`. Body `{ sku, units?, subject, description?, userId?, organizationId?, network? }`. Returns `{ free: true }` for an unpriced SKU, else `{ charge, payUrl, paymentUrl, created }` |
| `GET /internal/v1/charges/:id` | The charge as the product sees it, including `status` |
| `GET /internal/v1/charges?service=&subject=` | The latest charge for one of this product's subjects, so a retried request finds an existing payment |
| `GET /internal/v1/users/:sub` | User, linked wallets, organizations (for account linking) |

Charge fields: `id`, `service`, `sku`, `units`, `subject`, `description`, `amountMicro`, `network`, `asset`, `payTo`, `status`, `userId`, `organizationId`, `payer`, `settlementTx`, `failureReason`, `expiresAt`, `paidAt`, `createdAt`.

Idempotency keys are 1 to 200 characters, taken verbatim, unique per service client. The same key returns the same charge. A different key for the same `subject` creates a second charge, which is legitimate (a second publish of the same revision, say), so products key by the action they are paying for.

## Public API

| Method and path | Purpose |
| --- | --- |
| `GET /v1/me` | User, linked wallets, organizations with the caller's role (session) |
| `GET /v1/payment-options` | Networks a charge can be paid on: `{ options: [{ network, chainFamily, label, asset, payTo }] }`. Empty until payments are configured |
| `GET /v1/charges/:id` | Public view of a charge (no session needed, so a payer can be anyone) |
| `GET /v1/payments` | The signed-in user's charges, newest first (session) |
| `POST /v1/charges/:id/pay` | x402 v2. Without `PAYMENT-SIGNATURE`: `402` with a `PAYMENT-REQUIRED` header. With it: bind (including a signature check), persist, verify, settle, confirm on our own RPC, mark paid. `200 { charge, message }` with `PAYMENT-RESPONSE`; `202 { charge, message }` while confirming (do not pay again); `402 { error, charge }` on a mismatch |

Networks: `eip155:84532` (Base Sepolia), `eip155:8453` (Base), `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` (devnet), `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` (mainnet), plus local chains in tests. Amounts run from 0.01 to 1,000 USDC. Standard x402 clients cap USDC at $1 per payment by default: raise `spendControls.maxAmountPerPayment` to pay more.

## Errors

JSON `{ "error": { "code": "...", "message": "..." } }`. Codes: `unauthorized`, `forbidden`, `not_found`, `invalid_request`, `conflict`, `unknown_sku`, `payment_required`, `charge_expired`, `charge_not_open`, `rate_limited`.

## Not in version 0.2

Refunds (manual transfers), subscriptions or anything recurring, webhooks to products (poll the charge), agent API keys, in-browser Solana checkout (Solana charges are payable from x402 clients), smart-contract wallet signatures (ERC-1271), and holder trials (still in Cubicle).
