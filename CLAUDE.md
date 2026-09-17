# Working in this repo

`~/platform`: the shared account, credit and payment service for Cubicle
(`~/agent-desktop`), Floatlane (`~/ai-neobank`) and Plotform (`~/site-studio`).
Design and owner decisions: `~/status-reports/payments/PLAN.md`. API contract:
`SPEC.md` here. Other sessions build against SPEC.md, so change it deliberately
and tell them.

## Who is working on what

| instance | writes | mid-way through |
|---|---|---|
| _(achi-a5, claude: platform build)_ | everything in this repo | step 1 of PLAN.md: accounts, ledger, internal API, x402 invoices on local chains and testnets |

## Ports (owned block 8760 to 8789)

    8760 API        8761 test Anvil      8762 test facilitator
    8763 Postgres   8764 Mailpit SMTP    8765 Mailpit web
    8766-8785 test solana-test-validator (rpc 8766, ws 8767, faucet 8768, gossip 8769, dynamic 8770-8785)

`lsof -ti :<port>` before binding. Kill by PID only, never by pattern.

## Rules

**Nothing touches a mainnet or a real wallet without the owner saying so.** Local
chains and Base Sepolia / Solana devnet only. Receiving addresses on mainnet are the
owner's; no one in this repo generates or holds those keys.

**Never credit on a facilitator response alone.** An invoice is paid only after our
own RPC confirms the transfer (Cubicle constraint 5a in PLAN.md).

**Balances never go negative and idempotency keys are taken verbatim.** Callers
(Cubicle's worker) retry with the same key and rely on both.

**A linked account never grants a Floatlane role.** This service proves who someone
is; products decide what they may do.

**No invented numbers, no em dashes, no monospace UI fonts.** Owner rules.
