import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendTransactionMessageInstruction,
  appendTransactionMessageInstructions,
  compileTransaction,
  createSolanaRpc,
  createTransactionMessage,
  decompileTransactionMessage,
  generateKeyPairSigner,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  lamports,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type ReadonlyUint8Array,
  type Signature,
} from "@solana/kit";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToCheckedInstruction,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { x402Facilitator } from "@x402/core/facilitator";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { FacilitatorClient } from "@x402/core/server";
import type { Network, PaymentPayload, PaymentRequired, PaymentRequirements, SupportedResponse } from "@x402/core/types";
import { wrapFetchWithPayment } from "@x402/fetch";
import { toFacilitatorSvmSigner, SOLANA_DEVNET_CAIP2, SOLANA_TESTNET_CAIP2 } from "@x402/svm";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { registerExactSvmScheme } from "@x402/svm/exact/facilitator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PaymentMismatchError, type Binding, type Confirmation, type Rail } from "../src/invoices/rail.js";
import { createInvoiceService, type InvoiceServiceOptions } from "../src/invoices/service.js";
import { createSolanaRail, solanaNetworks, type SolanaConfirmInput, type SolanaRail } from "../src/invoices/solana.js";
import { balance } from "../src/ledger.js";
import { createTestDb } from "./helpers.js";

// This repo's test validator ports (CLAUDE.md). solana-test-validator refuses a dynamic range
// narrower than 25 ports, so the range runs to 8795.
const RPC_PORT = 8766;
const PORTS = { rpc: RPC_PORT, ws: RPC_PORT + 1, faucet: 8768, gossip: 8769, dynamicFrom: 8770, dynamicTo: 8795 };
const RPC_URL = `http://127.0.0.1:${RPC_PORT}`;
const USDC = 1_000_000n;
const INVOICE_TIMEOUT_SECONDS = 1800;

const rpc = createSolanaRpc(RPC_URL);

let validator: ChildProcess | undefined;
let ledger: string | undefined;
let rail: SolanaRail;
let facilitator: x402Facilitator;
let wireNetwork: string;
let mint: Address;
let otherMint: Address;
let authority: KeyPairSigner;
let feePayer: KeyPairSigner;
let payer: KeyPairSigner;
let otherPayer: KeyPairSigner;
let receiver: KeyPairSigner;
let attacker: KeyPairSigner;

/** A payload signed during setup and never submitted, for the expiry tests. */
let unsent: { payload: PaymentPayload; requirements: PaymentRequirements; binding: Binding; checkpoint: string };

/** One Postgres schema and payload key for every invoice service built in this file, created on first use. */
let serviceDb: Awaited<ReturnType<typeof createTestDb>> | undefined;
const payloadKey = randomBytes(32).toString("base64");
/** An invoice claimed through the service whose payment is never broadcast; failed at the end of the file. */
const stranded = { invoiceId: "", organizationId: "" };

describe("Solana rail on a local validator", () => {
  beforeAll(async () => {
    const busy = portRange(PORTS.rpc, PORTS.dynamicTo).filter(portInUse);
    if (busy.length > 0) throw new Error(`ports ${busy.join(", ")} are in use; the Solana rail test owns 8766 to 8795`);
    ledger = mkdtempSync(join(tmpdir(), "platform-solana-rail-"));
    validator = spawn(
      "solana-test-validator",
      [
        "--rpc-port", String(PORTS.rpc),
        "--faucet-port", String(PORTS.faucet),
        "--gossip-port", String(PORTS.gossip),
        "--dynamic-port-range", `${PORTS.dynamicFrom}-${PORTS.dynamicTo}`,
        "--bind-address", "127.0.0.1",
        "--ledger", ledger,
        "--reset",
        "--quiet",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    validator.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    await waitFor(async () => {
      if (validator?.exitCode !== null) throw new Error(`solana-test-validator exited: ${stderr}`);
      return (await fetch(RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }) }).then((r) => r.json()).catch(() => null))?.result === "ok";
    }, 60_000);

    authority = await generateKeyPairSigner();
    feePayer = await generateKeyPairSigner();
    payer = await generateKeyPairSigner();
    otherPayer = await generateKeyPairSigner();
    receiver = await generateKeyPairSigner();
    attacker = await generateKeyPairSigner();
    for (const signer of [authority, feePayer, payer, otherPayer]) await airdrop(signer.address, 5n * 1_000_000_000n);

    mint = await createMint(6);
    otherMint = await createMint(6);
    await send(authority, [
      getCreateAssociatedTokenIdempotentInstruction({ payer: authority, ata: await ata(payer.address), owner: payer.address, mint }),
      getCreateAssociatedTokenIdempotentInstruction({ payer: authority, ata: await ata(otherPayer.address), owner: otherPayer.address, mint }),
      getCreateAssociatedTokenIdempotentInstruction({ payer: authority, ata: await ata(receiver.address), owner: receiver.address, mint }),
      getCreateAssociatedTokenIdempotentInstruction({ payer: authority, ata: await ata(attacker.address), owner: attacker.address, mint }),
    ]);
    await send(authority, [
      getMintToCheckedInstruction({ mint, token: await ata(payer.address), mintAuthority: authority, amount: 50n * USDC, decimals: 6 }),
      getMintToCheckedInstruction({ mint, token: await ata(otherPayer.address), mintAuthority: authority, amount: 50n * USDC, decimals: 6 }),
    ]);

    // A local validator has its own genesis, so it is stored under its own id and sent as devnet.
    const networks = await solanaNetworks(RPC_URL);
    wireNetwork = networks.wireNetwork;
    expect(wireNetwork).toBe(SOLANA_DEVNET_CAIP2);
    expect(networks.network).not.toBe(SOLANA_DEVNET_CAIP2);

    facilitator = new x402Facilitator();
    registerExactSvmScheme(facilitator, { signer: toFacilitatorSvmSigner(feePayer, { defaultRpcUrl: RPC_URL }), networks: [wireNetwork as Network] });
    rail = createSolanaRail({ network: networks.network, wireNetwork, asset: mint, payTo: receiver.address, rpcUrl: RPC_URL, extra: { feePayer: feePayer.address } });

    const checkpoint = await rail.checkpoint();
    const requirements = rail.requirements(3n * USDC, INVOICE_TIMEOUT_SECONDS);
    const payload = await signPayment(requirements, payer);
    unsent = { payload, requirements, binding: await rail.bind(payload, requirements), checkpoint };
  }, 180_000);

  afterAll(async () => {
    if (validator && validator.exitCode === null) {
      const exited = new Promise<void>((resolve) => validator!.once("exit", () => resolve()));
      process.kill(validator.pid!, "SIGTERM");
      const stopped = await Promise.race([exited.then(() => true), sleep(15_000).then(() => false)]);
      if (!stopped && validator.exitCode === null) {
        process.kill(validator.pid!, "SIGKILL");
        await exited;
      }
    }
    if (ledger) rmSync(ledger, { recursive: true, force: true });
    await serviceDb?.drop();
  }, 30_000);

  it("keeps a signed but unsubmitted payment pending while its blockhash is valid", async () => {
    const blockhash = recentBlockhash(unsent.payload);
    expect((await rpc.isBlockhashValid(blockhash, { commitment: "processed" }).send()).value).toBe(true);
    expect(await rail.confirm({ ...confirmInput(unsent), payload: unsent.payload })).toEqual({ state: "pending" });
    expect(await rail.confirm(confirmInput(unsent))).toEqual({ state: "pending" });
  }, 60_000);

  it("claims a Solana invoice through the service with a payment the facilitator never broadcasts", async () => {
    // A facilitator that checks the payment and then loses it: settle fails before anything is sent.
    const lossy: FacilitatorClient = {
      verify: (payload, requirements) => facilitator.verify(payload, requirements),
      settle: async () => {
        throw new Error("facilitator connection reset");
      },
      getSupported: async () => facilitator.getSupported() as unknown as SupportedResponse,
    };
    const { db, service } = await invoiceService(lossy, { confirmTimeoutMs: 0 });
    const organizationId = `org_solana_stranded_${Date.now()}`;
    const { invoice } = await service.create({ organizationId, userId: "user_test", network: rail.config.network, amountMicro: 6_000_000, idempotencyKey: `topup-${organizationId}` });

    const challenge = await service.pay(invoice.id);
    expect(challenge.status).toBe(402);
    const required = decodePaymentRequiredHeader(challenge.headers["PAYMENT-REQUIRED"]!);
    const client = new x402Client().setSpendControls(false).register(wireNetwork as Network, new ExactSvmScheme(payer, { rpcUrl: RPC_URL }));
    const payload = await new x402HTTPClient(client).createPaymentPayload(required);
    const paid = await service.pay(invoice.id, encodePaymentSignatureHeader(payload));
    expect(paid.status).toBe(202);
    expect(await service.get(invoice.id)).toMatchObject({ status: "settlement_pending", payer: payer.address });

    // While the blockhash is usable the chain proves nothing, so reconcile leaves it pending.
    expect(await service.reconcile()).toMatchObject({ pending: 1, failed: 0, paid: 0, errors: 0 });
    expect(await service.get(invoice.id)).toMatchObject({ status: "settlement_pending" });
    expect(await balance(db, organizationId)).toBe(0);
    Object.assign(stranded, { invoiceId: invoice.id, organizationId });
  }, 60_000);

  it("pays through a real x402 client and facilitator, binds by the payer's signature, and confirms once finalized", async () => {
    const checkpoint = await rail.checkpoint();
    const requirements = rail.requirements(2n * USDC, INVOICE_TIMEOUT_SECONDS);
    expect(requirements).toEqual({
      scheme: "exact",
      network: SOLANA_DEVNET_CAIP2,
      asset: mint,
      amount: "2000000",
      payTo: receiver.address,
      maxTimeoutSeconds: INVOICE_TIMEOUT_SECONDS,
      extra: { feePayer: feePayer.address },
    });
    const [receiverAta] = await findAssociatedTokenPda({ mint, owner: receiver.address, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    expect(rail.payToTokenAccount).toBe(receiverAta);

    const payload = await signPayment(requirements, payer);
    const boundAt = Date.now();
    const binding = await rail.bind(payload, requirements);
    expect(binding.payer).toBe(payer.address);
    // An estimate past the blockhash's roughly one-minute life, bounded by maxTimeoutSeconds plus 151 slots.
    expect(binding.validBefore.getTime()).toBeGreaterThan(boundAt + 60_000);
    expect(binding.validBefore.getTime()).toBeLessThanOrEqual(Date.now() + INVOICE_TIMEOUT_SECONDS * 1000 + 151 * 400);
    const signed =getTransactionDecoder().decode(getBase64Encoder().encode(payload.payload.transaction as string));
    expect(signed.signatures[feePayer.address]).toBeNull();
    expect(binding.bindingId).toBe(base58Signature(signed.signatures[payer.address]!));

    const verified = await facilitator.verify(payload, requirements);
    expect(verified).toMatchObject({ isValid: true, payer: payer.address });
    const settled = await facilitator.settle(payload, requirements);
    expect(settled.success).toBe(true);
    const transaction = settled.transaction;

    // Settled at confirmed commitment is not enough.
    expect(await rail.confirm({ requirements, binding, checkpoint, transaction, validBefore: new Date() })).toEqual({ state: "pending" });

    const confirmation = await confirmEventually({ requirements, binding, checkpoint, transaction, validBefore: new Date() });
    expect(confirmation).toEqual({ state: "confirmed", transaction, payer: payer.address });
    const landed = await rpc.getTransaction(transaction as Signature, { commitment: "finalized", encoding: "json", maxSupportedTransactionVersion: 0 }).send();
    expect(landed?.transaction.signatures).toContain(binding.bindingId);
    expect((await rpc.getTokenAccountBalance(receiverAta, { commitment: "finalized" }).send()).value.amount).toBe("2000000");
  }, 120_000);

  it("recovers a lost settlement response by scanning from the checkpoint", async () => {
    const checkpoint = await rail.checkpoint();
    const requirements = rail.requirements(1_250_000n, INVOICE_TIMEOUT_SECONDS);
    const payload = await signPayment(requirements, payer);
    const binding = await rail.bind(payload, requirements);
    const settled = await facilitator.settle(payload, requirements);
    expect(settled.success).toBe(true);

    // The service never saw the response: no transaction id, only the binding and checkpoint.
    const confirmation = await confirmEventually({ requirements, binding, checkpoint, validBefore: new Date(), payload });
    expect(confirmation).toEqual({ state: "confirmed", transaction: settled.transaction, payer: payer.address });

    // A wrong hint does not mislead it either.
    const hinted = await rail.confirm({ requirements, binding, checkpoint, transaction: "1".repeat(64), validBefore: new Date() });
    expect(hinted).toEqual({ state: "confirmed", transaction: settled.transaction, payer: payer.address });
  }, 120_000);

  it("refuses payloads that do not pay exactly the invoice", async () => {
    const requirements = rail.requirements(4n * USDC, INVOICE_TIMEOUT_SECONDS);
    const honest = await signPayment(requirements, payer);
    expect((await rail.bind(honest, requirements)).payer).toBe(payer.address);

    // Each payload below is signed for other terms and then claims to accept the invoice's.
    const claiming = (payload: PaymentPayload): PaymentPayload => ({ ...payload, accepted: requirements });

    const wrongAmount = claiming(await signPayment({ ...requirements, amount: "4000001" }, payer));
    expect(await reasonOf(() => rail.bind(wrongAmount, requirements))).toMatch(/moves 4000001, not 4000000/);

    const wrongRecipient = claiming(await signPayment({ ...requirements, payTo: attacker.address }, payer));
    expect(await reasonOf(() => rail.bind(wrongRecipient, requirements))).toMatch(/not payTo's token account/);

    const wrongMint = claiming(await signPayment({ ...requirements, asset: otherMint }, payer));
    expect(await reasonOf(() => rail.bind(wrongMint, requirements))).toMatch(new RegExp(`moves mint ${otherMint}`));

    const wrongFeePayer = claiming(await signPayment({ ...requirements, extra: { feePayer: attacker.address } }, payer));
    expect(await reasonOf(() => rail.bind(wrongFeePayer, requirements))).toMatch(/fee payer is .*, not the facilitator's/);

    const wrongNetwork: PaymentPayload = { ...honest, accepted: { ...requirements, network: SOLANA_TESTNET_CAIP2 } };
    expect(await reasonOf(() => rail.bind(wrongNetwork, requirements))).toMatch(/differ from the invoice's in network/);
    expect(await reasonOf(() => rail.bind(honest, { ...requirements, network: SOLANA_TESTNET_CAIP2 }))).toMatch(/different chain or mint/);

    const wrongAccepted: PaymentPayload = { ...honest, accepted: { ...requirements, amount: "1" } };
    expect(await reasonOf(() => rail.bind(wrongAccepted, requirements))).toMatch(/differ from the invoice's in amount/);

    // The honest transfer plus a second TransferChecked to someone else, re-signed by the payer.
    const message = decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(transactionOf(honest).messageBytes));
    const extraTransfer = getTransferCheckedInstruction({ source: await ata(payer.address), mint, destination: await ata(attacker.address), authority: payer, amount: 1n, decimals: 6 });
    const tampered = await partiallySignTransaction([payer.keyPair], compileTransaction(appendTransactionMessageInstruction(extraTransfer, message)));
    const extraInstruction: PaymentPayload = { ...honest, payload: { transaction: getBase64EncodedWireTransaction(tampered) } };
    expect(await reasonOf(() => rail.bind(extraInstruction, requirements))).toMatch(/instruction 5 calls TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA; only Memo and Lighthouse/);

    // The right transfer, but spent from a token account that is not the payer's own.
    const otherSource = getTransferCheckedInstruction({ source: await ata(attacker.address), mint, destination: rail.payToTokenAccount, authority: payer, amount: 4n * USDC, decimals: 6 });
    const swapped = { ...message, instructions: [...(message.instructions as readonly Instruction[])].map((instruction, index) => (index === 2 ? otherSource : instruction)) } as typeof message;
    const wrongSource: PaymentPayload = { ...honest, payload: { transaction: getBase64EncodedWireTransaction(await partiallySignTransaction([payer.keyPair], compileTransaction(swapped))) } };
    expect(await reasonOf(() => rail.bind(wrongSource, requirements))).toMatch(new RegExp(`spends from ${await ata(attacker.address)}, not the payer's token account`));

    // A payer signature that does not verify.
    const wire = Uint8Array.from(getBase64Encoder().encode(honest.payload.transaction as string));
    wire[1 + 64 + 7]! ^= 0xff;
    const forged: PaymentPayload = { ...honest, payload: { transaction: Buffer.from(wire).toString("base64") } };
    expect(await reasonOf(() => rail.bind(forged, requirements))).toMatch(new RegExp(`signer ${payer.address} has not validly signed`));

    // A payer signature that is missing (all zeros on the wire, as for an unsigned signer).
    const blank = Uint8Array.from(getBase64Encoder().encode(honest.payload.transaction as string));
    blank.fill(0, 1 + 64, 1 + 64 + 64);
    const unsigned: PaymentPayload = { ...honest, payload: { transaction: Buffer.from(blank).toString("base64") } };
    expect(transactionOf(unsigned).signatures[payer.address]).toBeNull();
    expect(await reasonOf(() => rail.bind(unsigned, requirements))).toMatch(new RegExp(`signer ${payer.address} has not validly signed`));

    // None of these would have been accepted by the facilitator either.
    for (const payload of [wrongAmount, wrongRecipient, wrongMint, wrongFeePayer, extraInstruction, wrongSource, forged, unsigned]) {
      expect((await facilitator.verify(payload, requirements)).isValid).toBe(false);
    }
  }, 120_000);

  it("does not match another payer's transfer of the same amount to payTo", async () => {
    const checkpoint = await rail.checkpoint();
    const requirements = rail.requirements(5n * USDC, INVOICE_TIMEOUT_SECONDS);
    const mine = await signPayment(requirements, payer);
    const myBinding = await rail.bind(mine, requirements);

    const theirs = await signPayment(requirements, otherPayer);
    const theirBinding = await rail.bind(theirs, requirements);
    expect(theirBinding.payer).toBe(otherPayer.address);
    const settled = await facilitator.settle(theirs, requirements);
    expect(settled.success).toBe(true);
    const confirmed = await confirmEventually({ requirements, binding: theirBinding, checkpoint, validBefore: new Date() });
    expect(confirmed).toEqual({ state: "confirmed", transaction: settled.transaction, payer: otherPayer.address });

    // Their finalized transfer is in payTo's history, pays the same amount, and is still not mine.
    expect(await rail.confirm({ requirements, binding: myBinding, checkpoint, transaction: settled.transaction, validBefore: new Date(), payload: mine })).toEqual({ state: "pending" });
    expect(await rail.confirm({ requirements, binding: myBinding, checkpoint, validBefore: new Date(), payload: mine })).toEqual({ state: "pending" });
    // Nor does claiming their payer with my signature work.
    expect(await rail.confirm({ requirements, binding: { ...myBinding, payer: otherPayer.address }, checkpoint, validBefore: new Date() })).toEqual({ state: "pending" });
  }, 120_000);

  it("is paid end to end through the invoice service by a standard x402 fetch client", async () => {
    {
      const local: FacilitatorClient = {
        verify: (payload, requirements) => facilitator.verify(payload, requirements),
        settle: (payload, requirements) => facilitator.settle(payload, requirements),
        getSupported: async () => facilitator.getSupported() as unknown as SupportedResponse,
      };
      // Solana confirms only at finalized commitment, which trails confirmed by about 32 slots.
      const { db, service } = await invoiceService(local, { confirmTimeoutMs: 60_000 });
      const organizationId = `org_solana_${Date.now()}`;
      const { invoice } = await service.create({ organizationId, userId: "user_test", network: rail.config.network, amountMicro: 7_000_000, idempotencyKey: `topup-${organizationId}` });
      expect(invoice).toMatchObject({ status: "open", network: rail.config.network, asset: mint, payTo: receiver.address, amountMicro: 7_000_000 });
      const receivedBefore = BigInt((await rpc.getTokenAccountBalance(rail.payToTokenAccount, { commitment: "finalized" }).send()).value.amount);

      // The HTTP layer reduced to the one route, so @x402/fetch drives the whole exchange.
      const serviceFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const request = input instanceof Request ? input : new Request(input, init);
        const match = /^\/v1\/invoices\/([^/]+)\/pay$/.exec(new URL(request.url).pathname);
        if (request.method !== "POST" || !match) return new Response("not found", { status: 404 });
        const result = await service.pay(decodeURIComponent(match[1]!), request.headers.get("PAYMENT-SIGNATURE"));
        return new Response(JSON.stringify(result.body), { status: result.status, headers: { "content-type": "application/json", ...result.headers } });
      };
      const client = new x402Client().setSpendControls(false).register(wireNetwork as Network, new ExactSvmScheme(payer, { rpcUrl: RPC_URL }));
      const response = await wrapFetchWithPayment(serviceFetch as typeof fetch, client)(invoice.paymentUrl, { method: "POST" });

      expect(response.status).toBe(200);
      const settled = decodePaymentResponseHeader(response.headers.get("PAYMENT-RESPONSE")!);
      expect(settled).toMatchObject({ success: true, network: wireNetwork, payer: payer.address });
      expect(await service.get(invoice.id)).toMatchObject({ status: "paid", settlementTx: settled.transaction, payer: payer.address });
      expect(await balance(db, organizationId)).toBe(7_000_000);
      const receivedAfter = BigInt((await rpc.getTokenAccountBalance(rail.payToTokenAccount, { commitment: "finalized" }).send()).value.amount);
      expect(receivedAfter - receivedBefore).toBe(7_000_000n);
    }
  }, 120_000);

  it("fails the unsubmitted payment once its blockhash has expired below the finalized height", async () => {
    const blockhash = recentBlockhash(unsent.payload);
    const final = await pollUntil(() => rail.confirm({ ...confirmInput(unsent), payload: unsent.payload }), (c) => c.state !== "pending", 240_000);
    expect(final.state).toBe("failed");
    expect(final.state === "failed" && final.reason).toMatch(/blockhash expired at block height \d+ \(finalized height \d+\)/);
    expect((await rpc.isBlockhashValid(blockhash, { commitment: "processed" }).send()).value).toBe(false);
    // The expiry proof needs the blockhash, which only the payload carries.
    expect(await rail.confirm(confirmInput(unsent))).toEqual({ state: "pending" });
    // And the facilitator can no longer land it, nor can it claim a new invoice.
    expect((await facilitator.verify(unsent.payload, unsent.requirements)).isValid).toBe(false);
    expect(await reasonOf(() => rail.bind(unsent.payload, unsent.requirements))).toMatch(/blockhash has expired or is unknown/);
  }, 300_000);

  it("fails the stranded invoice on reconcile once its blockhash expires, and never credits it", async () => {
    expect(stranded.invoiceId).not.toBe("");
    // reconcile() never calls the facilitator, so any client will do here.
    const { db, service } = await invoiceService({} as FacilitatorClient, { confirmTimeoutMs: 0 });
    const deadline = Date.now() + 240_000;
    while ((await service.get(stranded.invoiceId))!.status === "settlement_pending" && Date.now() < deadline) {
      const report = await service.reconcile();
      expect(report).toMatchObject({ paid: 0, errors: 0 });
      await sleep(2_000);
    }
    const invoice = await service.get(stranded.invoiceId);
    expect(invoice).toMatchObject({ status: "failed", settlementTx: null, paidAt: null });
    expect(invoice!.failureReason).toMatch(/blockhash expired at block height \d+ \(finalized height \d+\) and no transaction carrying it landed/);
    expect(await balance(db, stranded.organizationId)).toBe(0);
    expect((await db.query("select payment_payload from invoices where id = $1", [stranded.invoiceId])).rows[0].payment_payload).toBeNull();
    // Final: another reconcile changes nothing.
    await service.reconcile();
    expect(await service.get(stranded.invoiceId)).toMatchObject({ status: "failed" });
    expect(await balance(db, stranded.organizationId)).toBe(0);
  }, 300_000);
});

/** An invoice service over this file's rail, sharing one schema and payload key across tests. */
async function invoiceService(facilitatorClient: FacilitatorClient, overrides: Partial<InvoiceServiceOptions> = {}) {
  serviceDb ??= await createTestDb();
  const service = createInvoiceService({
    db: serviceDb.db,
    rails: new Map<string, Rail>([[rail.config.network, rail]]),
    facilitator: facilitatorClient,
    payloadKey,
    publicUrl: "http://127.0.0.1:8760",
    maxTimeoutSeconds: 300,
    confirmPollMs: 1_000,
    ...overrides,
  });
  return { db: serviceDb.db, service };
}

function confirmInput(invoice: typeof unsent): SolanaConfirmInput {
  return { requirements: invoice.requirements, binding: invoice.binding, checkpoint: invoice.checkpoint, validBefore: new Date() };
}

/** A payer's x402 v2 payload for these requirements, carried through the real header encodings. */
async function signPayment(requirements: PaymentRequirements, signer: KeyPairSigner): Promise<PaymentPayload> {
  // The test mint is not one of the SDK's default assets, so its spend caps do not apply (Floatlane disables them the same way).
  const client = new x402Client().setSpendControls(false).register(wireNetwork as Network, new ExactSvmScheme(signer, { rpcUrl: RPC_URL }));
  const paymentRequired: PaymentRequired = {
    x402Version: 2,
    resource: { url: "http://127.0.0.1:8760/v1/invoices/test/pay", description: "Solana rail test top-up", mimeType: "application/json" },
    accepts: [requirements],
  };
  const payload = await new x402HTTPClient(client).createPaymentPayload(decodePaymentRequiredHeader(encodePaymentRequiredHeader(paymentRequired)));
  return decodePaymentSignatureHeader(encodePaymentSignatureHeader(payload));
}

function confirmEventually(input: SolanaConfirmInput): Promise<Confirmation> {
  return pollUntil(() => rail.confirm(input), (c) => c.state !== "pending", 90_000);
}

async function pollUntil<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await sleep(1000);
  }
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await sleep(250);
  }
}

async function reasonOf(bind: () => Promise<unknown>): Promise<string> {
  try {
    await bind();
  } catch (error) {
    if (error instanceof PaymentMismatchError) return error.reason;
    throw error;
  }
  throw new Error("bind accepted the payload");
}

function transactionOf(payload: PaymentPayload) {
  return getTransactionDecoder().decode(getBase64Encoder().encode(payload.payload.transaction as string));
}

function recentBlockhash(payload: PaymentPayload) {
  return getCompiledTransactionMessageDecoder().decode(transactionOf(payload).messageBytes).lifetimeToken as Parameters<typeof rpc.isBlockhashValid>[0];
}

function base58Signature(bytes: ReadonlyUint8Array): string {
  return getBase58Decoder().decode(bytes);
}

async function ata(owner: Address): Promise<Address> {
  const [address] = await findAssociatedTokenPda({ mint, owner, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  return address;
}

async function createMint(decimals: number): Promise<Address> {
  const account = await generateKeyPairSigner();
  const space = BigInt(getMintSize());
  const rent = await rpc.getMinimumBalanceForRentExemption(space).send();
  await send(authority, [
    getCreateAccountInstruction({ payer: authority, newAccount: account, lamports: rent, space, programAddress: TOKEN_PROGRAM_ADDRESS }),
    getInitializeMint2Instruction({ mint: account.address, decimals, mintAuthority: authority.address }),
  ]);
  return account.address;
}

async function send(feePayerSigner: KeyPairSigner, instructions: Instruction[]): Promise<Signature> {
  const { value: latest } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayerSigner, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const signed = await signTransactionMessageWithSigners(message);
  const signature = getSignatureFromTransaction(signed);
  await rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: "base64" }).send();
  await confirmed(signature);
  return signature;
}

async function airdrop(to: Address, amount: bigint): Promise<void> {
  let signature: Signature | undefined;
  await waitFor(async () => {
    signature = await rpc.requestAirdrop(to, lamports(amount)).send().catch(() => undefined);
    return signature !== undefined;
  }, 30_000);
  await confirmed(signature!);
}

async function confirmed(signature: Signature): Promise<void> {
  await waitFor(async () => {
    const [status] = (await rpc.getSignatureStatuses([signature]).send()).value;
    if (status?.err) throw new Error(`transaction ${signature} failed: ${JSON.stringify(status.err, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
    return status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized";
  }, 30_000);
}

function portRange(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

function portInUse(port: number): boolean {
  try {
    return execFileSync("lsof", ["-ti", `:${port}`], { encoding: "utf8" }).trim().length > 0;
  } catch (error) {
    if ((error as { status?: number }).status === 1) return false;
    throw error;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
