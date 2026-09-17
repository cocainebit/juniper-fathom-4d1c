import { randomBytes } from "node:crypto";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { wrapFetchWithPayment } from "@x402/fetch";
import { getAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db.js";
import { createEvmRail, type EvmRail } from "../src/invoices/evm.js";
import type { Rail } from "../src/invoices/rail.js";
import { createInvoiceService, INVOICE_LIFETIME_MS, type InvoiceService, type InvoiceServiceOptions, type PayResult } from "../src/invoices/service.js";
import { balance, recentEntries } from "../src/ledger.js";
import {
  LOCAL_CHAIN_ID,
  LOCAL_NETWORK,
  RPC_URL,
  TOKEN_DOMAIN,
  advanceChainTime,
  countingFacilitator,
  createLocalFacilitator,
  deployUsdc,
  funded,
  payerClient,
  publicClient,
  signPayment,
  startAnvil,
  type Anvil,
  type Token,
} from "./fixtures/evm/chain.js";
import { createTestDb } from "./helpers.js";

const PUBLIC_URL = "http://127.0.0.1:8760";
const MAX_TIMEOUT_SECONDS = 300;
const SLOW = 60_000;

let anvil: Anvil | undefined;
let db: Db;
let drop: (() => Promise<void>) | undefined;
let token: Token;
let payer: PrivateKeyAccount;
let payTo: Address;
let rail: EvmRail;
let local: FacilitatorClient;
let payloadKey: string;
let service: InvoiceService;

beforeAll(async () => {
  anvil = await startAnvil();
  ({ db, drop } = await createTestDb());
  token = await deployUsdc();
  payer = (await funded()).account;
  await token.mint(payer.address, 500_000_000n);
  payTo = privateKeyToAccount(generatePrivateKey()).address;
  local = await createLocalFacilitator();
  rail = createEvmRail(
    { network: LOCAL_NETWORK, wireNetwork: LOCAL_NETWORK, asset: token.address, payTo, rpcUrl: RPC_URL, extra: { ...TOKEN_DOMAIN } },
    { confirmations: 2, client: publicClient() },
  );
  payloadKey = randomBytes(32).toString("base64");
  service = makeService();
});
afterAll(async () => {
  await drop?.();
  await anvil?.stop();
});

function makeService(overrides: Partial<InvoiceServiceOptions> = {}): InvoiceService {
  return createInvoiceService({
    db,
    rails: new Map<string, Rail>([[LOCAL_NETWORK, rail]]),
    facilitator: local,
    payloadKey,
    publicUrl: PUBLIC_URL,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    confirmTimeoutMs: 20_000,
    confirmPollMs: 200,
    ...overrides,
  });
}

let counter = 0;
const newOrg = () => `org_invoice_${Date.now()}_${counter++}`;

async function newInvoice(svc: InvoiceService, amountMicro: number) {
  const organizationId = newOrg();
  const { invoice } = await svc.create({ organizationId, userId: "user_test", network: LOCAL_NETWORK, amountMicro, idempotencyKey: `topup-${organizationId}` });
  return invoice;
}

const row = async (id: string) => (await db.query("select * from invoices where id = $1", [id])).rows[0];
const grants = async (organizationId: string) => (await recentEntries(db, organizationId)).filter((entry) => entry.kind === "grant");
const errorCode = (result: PayResult) => (result.body as { error?: { code: string } }).error?.code;

function requirementsOf(challenge: PayResult): PaymentRequirements {
  expect(challenge.status).toBe(402);
  return decodePaymentRequiredHeader(challenge.headers["PAYMENT-REQUIRED"]!).accepts[0]!;
}

async function headerFor(requirements: PaymentRequirements): Promise<string> {
  return encodePaymentSignatureHeader(await signPayment(payer, requirements));
}

async function reconcileUntil(svc: InvoiceService, id: string, status: string, ms = 20_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    await svc.reconcile();
    const current = (await svc.get(id))!.status;
    if (current === status) return;
    if (Date.now() > deadline) throw new Error(`invoice ${id} is ${current}, not ${status}, after ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Filled by the happy path and reused by later tests. */
const happy = { invoiceId: "", organizationId: "", header: "", settlementTx: "", requirements: undefined as PaymentRequirements | undefined };
/** An invoice a lying facilitator claimed to settle; failed at the end of the file. */
const lied = { invoiceId: "", organizationId: "", header: "" };

describe("creating invoices", () => {
  it("validates bounds and network, and replays the idempotency key", async () => {
    const organizationId = newOrg();
    const input = { organizationId, userId: "user_test", network: LOCAL_NETWORK, amountMicro: 1_000_000, idempotencyKey: "same-key" };
    await expect(service.create({ ...input, amountMicro: 999_999 })).rejects.toMatchObject({ code: "invalid_request", httpStatus: 400 });
    await expect(service.create({ ...input, amountMicro: 1_000_000_001 })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(service.create({ ...input, amountMicro: 1_500_000.5 })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(service.create({ ...input, network: "eip155:8453" })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(service.create({ ...input, idempotencyKey: "" })).rejects.toMatchObject({ code: "invalid_request" });

    const first = await service.create(input);
    expect(first.created).toBe(true);
    expect(first.invoice).toMatchObject({ status: "open", amountMicro: 1_000_000, network: LOCAL_NETWORK, payTo: getAddress(payTo), paymentUrl: `${PUBLIC_URL}/v1/invoices/${first.invoice.id}/pay` });
    expect(new Date(first.invoice.expiresAt).getTime() - new Date(first.invoice.createdAt).getTime()).toBe(INVOICE_LIFETIME_MS);
    const stored = await row(first.invoice.id);
    expect(BigInt(stored.checkpoint)).toBeGreaterThan(0n);

    const again = await service.create(input);
    expect(again).toEqual({ created: false, invoice: first.invoice });
    await expect(service.create({ ...input, amountMicro: 2_000_000 })).rejects.toMatchObject({ code: "conflict", httpStatus: 409 });

    const raced = await Promise.all(Array.from({ length: 5 }, () => service.create({ ...input, idempotencyKey: "raced-key" })));
    expect(new Set(raced.map((result) => result.invoice.id)).size).toBe(1);
    expect(raced.filter((result) => result.created)).toHaveLength(1);
  });
});

describe("paying invoices", () => {
  it(
    "1. is paid end to end by a standard x402 v2 client and credits the organization",
    async () => {
      const invoice = await newInvoice(service, 5_000_000);
      const payToBefore = await token.balanceOf(payTo);

      const challenge = await service.pay(invoice.id);
      expect(challenge.status).toBe(402);
      const required = decodePaymentRequiredHeader(challenge.headers["PAYMENT-REQUIRED"]!);
      expect(required.x402Version).toBe(2);
      expect(required.resource.url).toBe(invoice.paymentUrl);
      // The pay route needs no session, so its body does not say who owns or created the invoice.
      expect(challenge.body).toMatchObject({ invoice: { id: invoice.id, status: "open", amountMicro: 5_000_000 } });
      expect(challenge.body).not.toHaveProperty("invoice.organizationId");
      expect(challenge.body).not.toHaveProperty("invoice.createdBy");
      expect(required.accepts).toEqual([
        { scheme: "exact", network: LOCAL_NETWORK, asset: getAddress(token.address), amount: "5000000", payTo: getAddress(payTo), maxTimeoutSeconds: MAX_TIMEOUT_SECONDS, extra: { name: "USDC", version: "2" } },
      ]);

      // The HTTP layer, reduced to the one route, so @x402/fetch drives the whole exchange.
      const sentHeaders: string[] = [];
      const serviceFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const request = input instanceof Request ? input : new Request(input, init);
        const match = /^\/v1\/invoices\/([^/]+)\/pay$/.exec(new URL(request.url).pathname);
        if (request.method !== "POST" || !match) return new Response("not found", { status: 404 });
        const header = request.headers.get("PAYMENT-SIGNATURE");
        if (header) sentHeaders.push(header);
        const result = await service.pay(decodeURIComponent(match[1]!), header);
        return new Response(JSON.stringify(result.body), { status: result.status, headers: { "content-type": "application/json", ...result.headers } });
      };
      const paidFetch = wrapFetchWithPayment(serviceFetch as typeof fetch, payerClient(payer, token.address));
      const response = await paidFetch(invoice.paymentUrl, { method: "POST" });

      expect(response.status).toBe(200);
      const settled = decodePaymentResponseHeader(response.headers.get("PAYMENT-RESPONSE")!);
      expect(settled).toMatchObject({ success: true, network: LOCAL_NETWORK, payer: getAddress(payer.address) });
      expect(settled.transaction).toMatch(/^0x[0-9a-f]{64}$/);
      expect(sentHeaders).toHaveLength(1);

      const paid = await service.get(invoice.id);
      expect(paid).toMatchObject({ status: "paid", settlementTx: settled.transaction, payer: getAddress(payer.address) });
      expect(await balance(db, invoice.organizationId)).toBe(5_000_000);
      expect(await grants(invoice.organizationId)).toMatchObject([{ amountMicro: 5_000_000, reason: "x402 top-up" }]);
      expect(await token.balanceOf(payTo)).toBe(payToBefore + 5_000_000n);
      expect((await row(invoice.id)).payment_payload).toBeNull();

      Object.assign(happy, { invoiceId: invoice.id, organizationId: invoice.organizationId, header: sentHeaders[0], settlementTx: settled.transaction, requirements: required.accepts[0] });
    },
    SLOW,
  );

  it("2. replays the same payload idempotently: one transfer, one credit", async () => {
    expect(happy.header).not.toBe("");
    const payToBefore = await token.balanceOf(payTo);
    for (let i = 0; i < 3; i++) {
      const replay = await service.pay(happy.invoiceId, happy.header);
      expect(replay.status).toBe(200);
      expect(decodePaymentResponseHeader(replay.headers["PAYMENT-RESPONSE"]!).transaction).toBe(happy.settlementTx);
    }
    await service.reconcile();
    // Without a payment the invoice still reports itself paid.
    expect((await service.pay(happy.invoiceId)).status).toBe(200);
    // A fresh authorization for a paid invoice is refused and never sent anywhere.
    const fresh = await service.pay(happy.invoiceId, await headerFor(happy.requirements!));
    expect([fresh.status, errorCode(fresh)]).toEqual([409, "invoice_not_open"]);

    expect(await balance(db, happy.organizationId)).toBe(5_000_000);
    expect(await grants(happy.organizationId)).toHaveLength(1);
    expect(await token.balanceOf(payTo)).toBe(payToBefore);
  });

  it(
    "3. never lets one authorization pay two invoices",
    async () => {
      const a = await newInvoice(service, 3_000_000);
      const b = await newInvoice(service, 3_000_000);
      const header = await headerFor(requirementsOf(await service.pay(a.id)));
      expect((await service.pay(a.id, header)).status).toBe(200);

      const second = await service.pay(b.id, header);
      expect([second.status, errorCode(second)]).toEqual([409, "conflict"]);
      expect(await row(b.id)).toMatchObject({ status: "open", payer: null, binding_id: null, payment_payload: null, payload_digest: null });
      expect(await balance(db, a.organizationId)).toBe(3_000_000);
      expect(await balance(db, b.organizationId)).toBe(0);

      // The same race, concurrently: exactly one invoice takes the authorization.
      const c = await newInvoice(service, 3_000_000);
      const d = await newInvoice(service, 3_000_000);
      const shared = await headerFor(requirementsOf(await service.pay(c.id)));
      const results = await Promise.all([service.pay(c.id, shared), service.pay(d.id, shared)]);
      expect(results.filter((result) => errorCode(result) === "conflict")).toHaveLength(1);
      const winner = results[0]!.status === 409 ? d : c;
      await reconcileUntil(service, winner.id, "paid");
      expect((await balance(db, c.organizationId)) + (await balance(db, d.organizationId))).toBe(3_000_000);
    },
    SLOW,
  );

  it("4. rejects mismatched or unsigned payments before any facilitator call, changing nothing", async () => {
    const counting = countingFacilitator(local);
    const svc = makeService({ facilitator: counting.client });
    const invoice = await newInvoice(svc, 2_000_000);
    const requirements = requirementsOf(await svc.pay(invoice.id));
    const stranger = privateKeyToAccount(generatePrivateKey()).address;
    const before = await row(invoice.id);

    const wrong: [string, PaymentPayload, RegExp][] = [
      ["amount", await signPayment(payer, { ...requirements, amount: "1000000" }), /amount/],
      ["payTo", await signPayment(payer, { ...requirements, payTo: stranger }), /payTo/],
      ["asset", await signPayment(payer, { ...requirements, asset: stranger }), /asset/],
      ["network", await signPayment(payer, { ...requirements, network: "eip155:84532" }), /network/],
      ["validBefore", await expiredAuthorization(requirements), /expired/],
      // Griefing: well-formed payloads that match every field but that `from` did not sign cannot lock the invoice.
      ["corrupted signature", await corruptedSignature(requirements), /signature/],
      ["signed by another key", await signedByAnotherKey(requirements), /signature/],
    ];
    for (const [field, payload, reason] of wrong) {
      const result = await svc.pay(invoice.id, encodePaymentSignatureHeader(payload));
      expect(result.status, field).toBe(402);
      const challenge = decodePaymentRequiredHeader(result.headers["PAYMENT-REQUIRED"]!);
      expect(challenge.error, field).toMatch(reason);
      expect(challenge.accepts, field).toEqual([requirements]);
    }
    const garbage = await svc.pay(invoice.id, "not base64 json!");
    expect([garbage.status, errorCode(garbage)]).toEqual([400, "invalid_request"]);

    expect(counting.calls).toEqual({ verify: 0, settle: 0 });
    expect(await row(invoice.id)).toEqual(before);
    expect((await svc.get(invoice.id))!.status).toBe("open");
    expect(await balance(db, invoice.organizationId)).toBe(0);

    // The invoice is still payable by its real payer afterwards.
    const paid = await svc.pay(invoice.id, await headerFor(requirements));
    expect(paid.status).toBe(200);
    expect(await balance(db, invoice.organizationId)).toBe(2_000_000);
  }, SLOW);

  it(
    "5. recovers a lost facilitator response: the reconciler credits exactly once",
    async () => {
      // The facilitator broadcasts and then its response is lost; our RPC is unreachable while pay() runs.
      let rpcDown = true;
      const flakyRail: Rail = {
        config: rail.config,
        requirements: rail.requirements,
        bind: rail.bind,
        checkpoint: rail.checkpoint,
        confirm: (input) => (rpcDown ? Promise.reject(new Error("RPC unreachable")) : rail.confirm(input)),
      };
      let broadcast = "";
      const lossy: FacilitatorClient = {
        verify: local.verify,
        settle: async (payload, requirements) => {
          const result = await local.settle(payload, requirements);
          broadcast = result.transaction;
          throw new Error("socket hang up");
        },
        getSupported: local.getSupported,
      };
      const svc = makeService({ facilitator: lossy, rails: new Map([[LOCAL_NETWORK, flakyRail]]), confirmTimeoutMs: 1_000 });
      const invoice = await newInvoice(svc, 4_000_000);
      const header = await headerFor(requirementsOf(await svc.pay(invoice.id)));
      const payToBefore = await token.balanceOf(payTo);

      const result = await svc.pay(invoice.id, header);
      expect(result.status).toBe(202);
      expect(broadcast).toMatch(/^0x[0-9a-f]{64}$/);
      const pending = await row(invoice.id);
      expect(pending).toMatchObject({ status: "settlement_pending", reported_tx: null, payer: getAddress(payer.address) });
      expect(pending.facilitator_note).toMatch(/socket hang up/);
      // Persisted encrypted: the signature is not readable at rest.
      const signature = (JSON.parse(Buffer.from(header, "base64").toString()) as { payload: { signature: string } }).payload.signature;
      expect(pending.payment_payload).toMatch(/^v1\./);
      expect(pending.payment_payload).not.toContain(signature.slice(2, 20));
      // The money moved, but nothing is credited without our own confirmation.
      expect(await token.balanceOf(payTo)).toBe(payToBefore + 4_000_000n);
      expect(await balance(db, invoice.organizationId)).toBe(0);

      rpcDown = false;
      await reconcileUntil(svc, invoice.id, "paid");
      expect(await row(invoice.id)).toMatchObject({ status: "paid", settlement_tx: broadcast, payment_payload: null });
      expect(await balance(db, invoice.organizationId)).toBe(4_000_000);
      expect(await grants(invoice.organizationId)).toHaveLength(1);

      const settledRow = await row(invoice.id);
      await svc.reconcile();
      expect(await row(invoice.id)).toEqual(settledRow);
      expect(await balance(db, invoice.organizationId)).toBe(4_000_000);
      expect(await grants(invoice.organizationId)).toHaveLength(1);
    },
    SLOW,
  );

  it(
    "6. does not credit a facilitator that reports success without a real transfer",
    async () => {
      expect(happy.settlementTx).not.toBe("");
      // It points at a real transaction that paid payTo the same amount from the same payer: the happy path's.
      const liar: FacilitatorClient = {
        verify: async () => ({ isValid: true, payer: getAddress(payer.address) }),
        settle: async (_payload, requirements) => ({ success: true, transaction: happy.settlementTx, network: requirements.network, payer: getAddress(payer.address) }),
        getSupported: local.getSupported,
      };
      const svc = makeService({ facilitator: liar, confirmTimeoutMs: 3_000 });
      const invoice = await newInvoice(svc, 5_000_000);
      const header = await headerFor(requirementsOf(await svc.pay(invoice.id)));
      const payToBefore = await token.balanceOf(payTo);

      const result = await svc.pay(invoice.id, header);
      expect(result.status).toBe(202);
      expect(await row(invoice.id)).toMatchObject({ status: "settlement_pending", reported_tx: happy.settlementTx, settlement_tx: null });
      await svc.reconcile();
      await svc.reconcile();
      expect((await svc.get(invoice.id))!.status).toBe("settlement_pending");
      expect(await balance(db, invoice.organizationId)).toBe(0);
      expect(await token.balanceOf(payTo)).toBe(payToBefore);
      Object.assign(lied, { invoiceId: invoice.id, organizationId: invoice.organizationId, header });
    },
    SLOW,
  );

  it("7. expires an open invoice past its lifetime and refuses payments on it", async () => {
    const counting = countingFacilitator(local);
    const svc = makeService({ facilitator: counting.client });
    const past = makeService({ now: () => new Date(Date.now() - INVOICE_LIFETIME_MS - 60_000) });
    const a = await newInvoice(past, 1_000_000);
    const b = await newInvoice(past, 1_000_000);
    const header = await headerFor((await row(a.id)).requirements);
    expect((await svc.get(a.id))!.status).toBe("expired");

    // Paying before the reconciler runs is refused, and the invoice is marked on the way.
    const refused = await svc.pay(a.id, header);
    expect([refused.status, errorCode(refused)]).toEqual([410, "invoice_expired"]);
    expect((await row(a.id)).status).toBe("expired");

    const report = await svc.reconcile();
    expect(report.expired).toBeGreaterThanOrEqual(1);
    expect((await row(b.id)).status).toBe("expired");
    expect((await svc.pay(b.id)).status).toBe(410);
    expect((await svc.pay(b.id, header)).status).toBe(410);

    expect(counting.calls).toEqual({ verify: 0, settle: 0 });
    expect(await balance(db, a.organizationId)).toBe(0);
    expect(await balance(db, b.organizationId)).toBe(0);
  });

  it(
    "8. credits once when the same payload is paid concurrently, and binds only one of two racing authorizations",
    async () => {
      const counting = countingFacilitator(local);
      const svc = makeService({ facilitator: counting.client });
      const invoice = await newInvoice(svc, 6_000_000);
      const header = await headerFor(requirementsOf(await svc.pay(invoice.id)));
      const payToBefore = await token.balanceOf(payTo);

      const results = await Promise.all(Array.from({ length: 8 }, () => svc.pay(invoice.id, header)));
      for (const result of results) expect([200, 202]).toContain(result.status);
      expect(counting.calls).toEqual({ verify: 1, settle: 1 });
      await reconcileUntil(svc, invoice.id, "paid");
      expect(await balance(db, invoice.organizationId)).toBe(6_000_000);
      expect(await grants(invoice.organizationId)).toHaveLength(1);
      expect(await token.balanceOf(payTo)).toBe(payToBefore + 6_000_000n);

      const other = await newInvoice(svc, 7_000_000);
      const requirements = requirementsOf(await svc.pay(other.id));
      const [first, second] = await Promise.all([svc.pay(other.id, await headerFor(requirements)), svc.pay(other.id, await headerFor(requirements))]);
      expect([first!.status, second!.status].filter((status) => status === 409)).toHaveLength(1);
      await reconcileUntil(svc, other.id, "paid");
      expect(await balance(db, other.organizationId)).toBe(7_000_000);
      expect(await token.balanceOf(payTo)).toBe(payToBefore + 13_000_000n);
    },
    SLOW,
  );
});

// Moves chain time forward, so it runs after every other test in this file.
describe("unsettled authorizations", () => {
  it(
    "fail only once a finalized block passes validBefore, and are never credited",
    async () => {
      expect(lied.invoiceId).not.toBe("");
      const svc = makeService();
      expect((await svc.reconcile()).failed).toBe(0);
      await advanceChainTime(MAX_TIMEOUT_SECONDS + 100);
      await reconcileUntil(svc, lied.invoiceId, "failed");
      const failed = await row(lied.invoiceId);
      expect(failed).toMatchObject({ status: "failed", payment_payload: null, settlement_tx: null });
      expect(failed.failure_reason).toMatch(/expired without being used/);
      expect(await balance(db, lied.organizationId)).toBe(0);
      const again = await svc.pay(lied.invoiceId, lied.header);
      expect([again.status, errorCode(again)]).toEqual([409, "invoice_not_open"]);
    },
    SLOW,
  );
});

/** Signs an EIP-3009 authorization over MockUSDC's domain on the local chain. */
async function signAuthorization(signer: PrivateKeyAccount, authorization: Record<string, string>): Promise<Hex> {
  return signer.signTypedData({
    domain: { ...TOKEN_DOMAIN, chainId: LOCAL_CHAIN_ID, verifyingContract: getAddress(token.address) },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from: authorization.from as Address,
      to: authorization.to as Address,
      value: BigInt(authorization.value!),
      validAfter: BigInt(authorization.validAfter!),
      validBefore: BigInt(authorization.validBefore!),
      nonce: authorization.nonce as Hex,
    },
  });
}

const authorizationOf = (payload: PaymentPayload) => ({ ...(payload.payload as { authorization: Record<string, string> }).authorization });

/** A correctly signed authorization whose validBefore has already passed. */
async function expiredAuthorization(requirements: PaymentRequirements): Promise<PaymentPayload> {
  const payload = await signPayment(payer, requirements);
  const authorization = { ...authorizationOf(payload), validBefore: String(Math.floor(Date.now() / 1000) - 60) };
  return { ...payload, payload: { authorization, signature: await signAuthorization(payer, authorization) } };
}

/** The payer's real payment with one byte of the signature flipped. */
async function corruptedSignature(requirements: PaymentRequirements): Promise<PaymentPayload> {
  const payload = await signPayment(payer, requirements);
  const signature = Buffer.from((payload.payload as { signature: string }).signature.slice(2), "hex");
  signature[5] = signature[5]! ^ 0xff;
  return { ...payload, payload: { authorization: authorizationOf(payload), signature: `0x${signature.toString("hex")}` } };
}

/** An authorization naming the payer as `from`, signed by someone else. */
async function signedByAnotherKey(requirements: PaymentRequirements): Promise<PaymentPayload> {
  const payload = await signPayment(payer, requirements);
  const authorization = authorizationOf(payload);
  return { ...payload, payload: { authorization, signature: await signAuthorization(privateKeyToAccount(generatePrivateKey()), authorization) } };
}
