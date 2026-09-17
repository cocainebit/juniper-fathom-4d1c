# Platform service contract

Version 0.2.1 (2026-09-17). Local and testnet only. Consumers: Plotform, Cubicle, Floatlane.

Running locally at `http://127.0.0.1:8760`. Operator commands: `pnpm admin` (service tokens, prices, OAuth clients) and `pnpm dev:token --resource <product API url> [--wallet]`, which mints a real access token for a throwaway account so a product can test its own token verification.

**Pay per action, no balance.** A product asks for a charge when someone does something that costs money, the payer pays that charge, and the product does the work. Nothing is stored up, nothing carries between products, and a payment for one action never pays for another. Every product opens the same payment sheet, so the prompt is the same everywhere. Version 0.1 had a shared credit balance; it was removed on the owner's instruction.

## Concepts

- **User**: one person. Signs in with an Ethereum wallet (SIWE, EIP-4361), a Solana wallet (Sign In With Solana through `@solana/wallet-standard-util` `verifySignIn`), or an emailed one-time code. `sub` in every token is the user id. One account across every product; a wallet belongs to exactly one account.
- **Organization**: a workspace a user belongs to. Charges are recorded against it so a team can see what its people paid for. Every user gets a personal one at sign-up, slug `personal-<user id>`, created once and not recreated; match that slug rather than the first entry in the list. A product may map several of its own workspaces onto one organization: the service records what it is told and does not enforce a one-to-one mapping.
- **Charge**: one payable action. It carries the product, the SKU, what it is for (`subject`, the product's own reference), the amount, and its state. `open -> settlement_pending -> paid`, or `open -> expired`, or `settlement_pending -> failed`. A charge is paid once, by exactly one payment.
- **SKU**: a server-owned price key, lowercase dot-separated, e.g. `plotform.publish`, `cubicle.hour.cpu2-mem4`, `instance.second.cpu1-mem2`. The product owns its own naming under its prefixes; the examples here follow what each product actually charges. Products send a SKU and units, never an amount. A SKU with no price means the action is free: the product does the work without asking for payment.
- **Service client**: a product calling the internal API with its own secret, allowed to charge only SKUs under its prefixes (`plotform.*` for Plotform).

## Identity for products

The service is an OAuth 2.1 and OpenID Connect provider (better-auth `@better-auth/oauth-provider` plus `jwt`).

- Discovery: `GET {issuer}/.well-known/openid-configuration`, where `{issuer}` is `http://127.0.0.1:8760/api/auth` locally. Signing keys: `GET /api/auth/jwks`.
- Products register with `pnpm admin client create <name> <redirect-uri> [resource-url]` as trusted confidential clients (no consent screen) and use the authorization code flow with PKCE. Local loopback redirects register as native clients; deployed ones must be https. Signed-in users cannot register clients.
- A product API that verifies access tokens (Cubicle) must be listed as a resource: start the service with `OAUTH_RESOURCES=<its URL>` and register its client with that resource URL, which becomes the token's `aud`.
- A product that exchanges its authorization code **in the browser** registers with `--public`: no client secret, PKCE alone. Never put a confidential client's secret in browser code to make the exchange work there. Its origin must also be in `TRUSTED_ORIGINS`, which is what allows it to read `/api/auth/oauth2/token`, `/revoke`, `/userinfo`, `/jwks` and discovery cross-origin. Those six paths are the only ones that answer another origin, they never allow credentials, and everything else on the service stays same-origin. A product that exchanges its code on its own server needs none of this.
- better-auth products use the `generic-oauth` plugin with `discoveryUrl` and sign in through `/sign-in/social` with `provider: "<providerId>"`; the callback is `{product}/api/auth/callback/<providerId>` (Plotform's is `http://127.0.0.1:5173/api/auth/callback/platform`).
- Pages: `/sign-in` (Ethereum wallet, Solana wallet, or emailed code), `/account` (linked wallets and payment history), `/pay/:chargeId` (the payment sheet).

## Paying for an action

1. Someone does something that costs money in a product.
2. The product's server calls `POST /internal/v1/charges` with the SKU, units, its own `subject` and an `Idempotency-Key`. An unpriced SKU comes back `{ free: true }` and the product just does the work.
3. The product answers its own client with `402` and the charge's `payUrl`, or opens `payUrl` directly. A person pays on the payment sheet; an AI agent pays `paymentUrl` over x402 with no UI.
4. The product re-checks with `GET /internal/v1/charges/:id` (or retries its own request, which re-checks by `subject`) and does the work once the charge is `paid`.

A server with no payment networks configured, which is how every product's development machine runs today, still answers `{ free: true }` for an unpriced SKU: free actions do not depend on payments being set up. Asking it for a priced SKU answers `503`, because that action genuinely cannot be paid for there, and a SKU outside the product's prefixes answers `422 unknown_sku` either way.

A charge is paid only after our own RPC confirms the exact transfer to the receiving address, never on a facilitator's word. Paying the same charge twice is refused. A charge expires 30 minutes after it is created, or after `expiresInSeconds` (60 to 86,400) when the product asks for a different window. A product charging ahead of time, such as the next hour of a running desktop, uses a longer one. Expired charges are inert and can never be paid; raising another for the same subject is normal and is not abuse.

## Internal API (service clients)

Authentication: `Authorization: Bearer <service secret>`. Server to server only; never exposed to browsers or to product API keys.

| Method and path | Purpose |
| --- | --- |
| `GET /internal/v1/prices` | `{ prices: [{ sku, unitPriceMicro, description }] }` for the SKUs this product may charge |
| `POST /internal/v1/charges` | Create or replay a charge. Header `Idempotency-Key`. Body `{ sku, units?, subject, description?, userId?, organizationId?, network?, expiresInSeconds? }`. Returns `{ free: true }` for an unpriced SKU, else `{ charge, payUrl, paymentUrl, created }` |
| `GET /internal/v1/charges/:id` | `{ charge, payUrl }`, the charge as the product sees it, including `status`. Another product's charge reads as 404 |
| `GET /internal/v1/charges?subject=` | `{ charge, payUrl }` for the newest charge this product raised for that subject, or `{ charge: null, payUrl: null }`. A retried request uses this to find an existing payment |
| `GET /internal/v1/users/:sub` | User, linked wallets, organizations `{ id, name, slug, role }` (for account linking) |

Charge fields: `id`, `service`, `sku`, `units`, `subject`, `description`, `amountMicro`, `network`, `asset`, `payTo`, `status`, `createdBy` (the paying user when the product knows one, else null), `organizationId` (same), `payer` (the wallet that paid), `paymentUrl` (the x402 endpoint), `settlementTx`, `failureReason`, `expiresAt`, `paidAt`, `createdAt`, `updatedAt`.

`userId` and `organizationId` are optional on create. A charge without a user is fine and is paid the same way; it simply does not appear in anyone's payment history at `/v1/payments`. Send them whenever the product knows who is acting, which is what lets a person see what they paid for.

The payment sheet for any charge is `{PUBLIC_URL}/pay/{chargeId}`, which is what `payUrl` holds; `paymentUrl` is the machine endpoint an x402 client pays.

Idempotency keys are 1 to 200 characters, taken verbatim, unique per service client. The same key returns the same charge. A different key for the same `subject` creates a second charge, which is legitimate (a second publish of the same revision, say), so products key by the action they are paying for.

## Public API

| Method and path | Purpose |
| --- | --- |
| `GET /v1/me` | User, linked wallets, organizations with the caller's role (session) |
| `GET /v1/payment-options` | Networks a charge can be paid on: `{ options: [{ network, chainFamily, label, asset, payTo }] }`. Empty until payments are configured |
| `GET /v1/charges/:id` | Public view of a charge (no session needed, so a payer can be anyone) |
| `GET /v1/payments` | The signed-in user's charges, newest first (session) |
| `POST /v1/charges/:id/pay` | x402 v2, and no account is needed: whoever holds the charge id and a funded wallet can pay it, which is how an agent pays without a browser session. Without `PAYMENT-SIGNATURE`: `402` with a `PAYMENT-REQUIRED` header. With it: bind (including a signature check), persist, verify, settle, confirm on our own RPC, mark paid. `200 { charge, message }` with `PAYMENT-RESPONSE`; `202 { charge, message }` while confirming (do not pay again); `402 { error, charge }` on a mismatch |

Networks: `eip155:84532` (Base Sepolia), `eip155:8453` (Base), `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` (devnet), `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` (mainnet), plus local chains in tests. Amounts run from 0.01 to 1,000 USDC. Standard x402 clients cap USDC at $1 per payment by default: raise `spendControls.maxAmountPerPayment` to pay more.

## Errors

JSON `{ "error": { "code": "...", "message": "..." } }`. Codes: `unauthorized`, `forbidden`, `not_found`, `invalid_request`, `conflict`, `unknown_sku`, `payment_required`, `charge_expired`, `charge_not_open`, `rate_limited`.

## Not in version 0.2

Refunds (manual transfers), subscriptions or anything recurring, webhooks to products (poll the charge), agent API keys, in-browser Solana checkout (Solana charges are payable from x402 clients), smart-contract wallet signatures (ERC-1271), and holder trials (still in Cubicle).
