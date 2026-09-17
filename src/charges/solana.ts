import { createHash, createPublicKey, verify as verifyEd25519 } from "node:crypto";
import {
  address,
  createSolanaRpc,
  getAddressDecoder,
  getAddressEncoder,
  getBase58Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  isAddress,
  isOffCurveAddress,
  isSignature,
  isSolanaError,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_UNSUPPORTED_TRANSACTION_VERSION,
  type Address,
  type Blockhash,
  type ReadonlyUint8Array,
  type Rpc,
  type Signature,
  type SolanaRpcApi,
  type Transaction,
} from "@solana/kit";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  LIGHTHOUSE_PROGRAM_ADDRESS,
  MEMO_PROGRAM_ADDRESS,
  SOLANA_DEVNET_CAIP2,
  SOLANA_MAINNET_CAIP2,
  SOLANA_TESTNET_CAIP2,
  TOKEN_2022_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
} from "@x402/svm";
import { PaymentMismatchError, type Binding, type Confirmation, type Rail, type RailConfig } from "./rail.js";

/**
 * The Solana rail: x402 v2 `exact` payments made with a payer-signed SPL `TransferChecked`
 * that the facilitator co-signs as fee payer and broadcasts.
 *
 * Factory: `createSolanaRail(config, options?)`.
 *
 * config (RailConfig):
 * - `network`: the CAIP-2 id stored with the invoice. A public cluster id, or for a local
 *   validator any other `solana:` id (`solanaNetworks(rpcUrl)` derives one from its genesis hash).
 * - `wireNetwork`: mainnet, devnet or testnet's CAIP-2 id; the x402 SVM SDK accepts no others.
 *   Equal to `network` on a public cluster; devnet's id for a local validator.
 * - `asset`: the USDC mint (6 decimals). `payTo`: the receiving wallet; payments land in its
 *   associated token account for `asset`, which must already exist.
 * - `rpcUrl`: our own RPC, with transaction history (getSignaturesForAddress, getTransaction, getBlock).
 * - `extra`: `{ feePayer }`, the facilitator's fee payer address from its supported kinds.
 *
 * options (SolanaRailOptions, all optional):
 * - `rpc`: a @solana/kit RPC client to use instead of one built from `rpcUrl` (tests, custom transports).
 * - `tokenProgram`: the program that owns `asset`. Defaults to SPL Token, which owns USDC on
 *   mainnet and devnet. Token-2022 is the only other value accepted.
 * - `concurrency`: parallel RPC reads during recovery scans (default 8).
 *
 * Binding. `bind` decodes the partially signed transaction in the payload and accepts only the
 * layout the x402 SDK client builds and the SDK facilitator's static check allows: a compute unit
 * limit, a compute unit price, one `TransferChecked` of exactly `amount` of the mint (6 decimals)
 * from the payer's associated token account into payTo's, then only Memo or Lighthouse
 * instructions. The fee payer must be the configured one, every other signer's signature must
 * verify (ed25519 over the message bytes), the transfer authority (the payer) must be a signer, and
 * the recent blockhash must still be valid on our RPC. The binding id is the payer's base58
 * signature: it is fixed before the facilitator adds its own, it appears in the landed
 * transaction, and the invoices table keeps it unique per network, so one transaction cannot pay
 * two invoices. `validBefore` is an estimate (now + maxTimeoutSeconds + 151 slots at 400 ms);
 * confirm() does not rely on it.
 *
 * Confirmation. A payment is proven only by a finalized transaction that carries the payer's
 * signature equal to the binding id, succeeded, still has the bound layout, and whose token
 * balance changes move exactly `amount` of the mint out of the payer's accounts and into payTo's
 * token account, with no other balance change for the mint. The facilitator's reported id is
 * only a hint; without it, or when it proves nothing, payTo's token account history is scanned
 * back to the invoice checkpoint (Solana indexes a transaction only by its first signature, the
 * fee payer's, so the payer's signature cannot be looked up directly).
 *
 * Failure. `failed` only when the chain proves the payment can never land: the transaction with
 * this signature landed and failed or paid something else, or its recent blockhash sits in a
 * finalized block whose last valid block height (block height + 150, as getLatestBlockhash
 * reports it) is below the finalized block height and no matching transaction exists. The
 * blockhash lives only in the signed transaction, so the expiry proof needs the persisted
 * payload, which the invoice service passes to `confirm` as `payload`. Without it, or when the
 * blockhash is not found in a finalized block from 150 blocks before the checkpoint onward, the
 * answer stays `pending`.
 * confirm() ignores `validBefore`: a Solana payment has no clock-time bound.
 */

export type SolanaRpc = Rpc<SolanaRpcApi>;

export type SolanaRailOptions = {
  rpc?: SolanaRpc;
  tokenProgram?: string;
  concurrency?: number;
};

/** Rail.confirm's input. Its optional `payload` is what lets confirm() prove a blockhash expired. */
export type SolanaConfirmInput = Parameters<Rail["confirm"]>[0];

export interface SolanaRail extends Rail {
  /** payTo's associated token account for the configured mint. */
  readonly payToTokenAccount: Address;
}

const PUBLIC_CLUSTERS: readonly string[] = [SOLANA_MAINNET_CAIP2, SOLANA_DEVNET_CAIP2, SOLANA_TESTNET_CAIP2];
const ASSOCIATED_TOKEN_PROGRAM_ADDRESS = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const USDC_DECIMALS = 6;
/** Agave's MAX_PROCESSING_AGE. getLatestBlockhash reports lastValidBlockHeight as block height plus this. */
const MAX_PROCESSING_AGE = 150n;
/** The largest `limit` getSignaturesForAddress accepts. */
const SIGNATURE_PAGE = 1000;
/** The largest slot range getBlocks accepts. */
const BLOCK_RANGE = 500_000n;
const DEFAULT_CONCURRENCY = 8;
/** Agave's DEFAULT_MS_PER_SLOT, the cluster's target slot time. */
const MS_PER_SLOT = 400;
/** bind() looks at the blockhash this many times, a slot apart, before calling it unusable. */
const BLOCKHASH_CHECKS = 3;

const IX_SET_COMPUTE_UNIT_LIMIT = 2;
const IX_SET_COMPUTE_UNIT_PRICE = 3;
const IX_TRANSFER_CHECKED = 12;
/** DER prefix that turns a raw 32-byte Ed25519 public key into SPKI, for node:crypto. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const DECIMAL = /^(0|[1-9][0-9]*)$/;

const addressEncoder = getAddressEncoder();
const addressDecoder = getAddressDecoder();
const base58 = getBase58Decoder();
const base64 = getBase64Encoder();
const transactionDecoder = getTransactionDecoder();
const messageDecoder = getCompiledTransactionMessageDecoder();

/** What one invoice asks for, taken from its stored requirements. */
type Terms = { amount: bigint; payTo: Address; payToTokenAccount: Address; feePayer: Address };

/** A transaction that pays the terms, as read from its message. */
type Inspected = { payer: Address; payerSignature: string; blockhash: Blockhash; accounts: readonly Address[] };

type Landed = Confirmation | { state: "missing" } | { state: "unrelated" };

/**
 * The network labels for a Solana RPC: `network` is `solana:` plus the first 32 characters of its
 * genesis hash (the CAIP-2 rule), and `wireNetwork` is that id on a public cluster or devnet's id
 * on anything else.
 */
export async function solanaNetworks(rpcUrl: string): Promise<{ network: string; wireNetwork: string }> {
  const genesis = await createSolanaRpc(rpcUrl).getGenesisHash().send();
  const network = `solana:${genesis.slice(0, 32)}`;
  return { network, wireNetwork: PUBLIC_CLUSTERS.includes(network) ? network : SOLANA_DEVNET_CAIP2 };
}

/** The associated token account of `owner` for `mint`, derived without WebCrypto so bind() can stay synchronous. */
export function associatedTokenAccount(owner: string, mint: string, tokenProgram: string = TOKEN_PROGRAM_ADDRESS): Address {
  const seeds = [addressEncoder.encode(address(owner)), addressEncoder.encode(address(tokenProgram)), addressEncoder.encode(address(mint))];
  const program = addressEncoder.encode(address(ASSOCIATED_TOKEN_PROGRAM_ADDRESS));
  for (let bump = 255; bump >= 0; bump -= 1) {
    const hash = createHash("sha256");
    for (const seed of seeds) hash.update(Uint8Array.from(seed));
    hash.update(Uint8Array.of(bump)).update(Uint8Array.from(program)).update("ProgramDerivedAddress");
    const candidate = addressDecoder.decode(hash.digest());
    if (isOffCurveAddress(candidate)) return candidate;
  }
  throw new Error("no associated token account address exists for these seeds");
}

export function createSolanaRail(config: RailConfig, options: SolanaRailOptions = {}): SolanaRail {
  if (!PUBLIC_CLUSTERS.includes(config.wireNetwork)) {
    throw new Error("a Solana rail's wireNetwork must be mainnet, devnet or testnet's CAIP-2 id");
  }
  if (!/^solana:[-_a-zA-Z0-9]{1,32}$/.test(config.network)) throw new Error("a Solana rail's network must be a solana CAIP-2 id");
  const local = config.network !== config.wireNetwork;
  if (local && PUBLIC_CLUSTERS.includes(config.network)) {
    throw new Error("a public Solana cluster goes on the wire under its own id: wireNetwork must equal network");
  }
  const asset = requireAddress(config.asset, "asset");
  const payTo = requireAddress(config.payTo, "payTo");
  const feePayer = requireAddress(config.extra.feePayer, "extra.feePayer");
  const tokenProgram = requireAddress(options.tokenProgram ?? TOKEN_PROGRAM_ADDRESS, "tokenProgram");
  if (tokenProgram !== TOKEN_PROGRAM_ADDRESS && tokenProgram !== TOKEN_2022_PROGRAM_ADDRESS) {
    throw new Error("tokenProgram must be the SPL Token or Token-2022 program");
  }
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("concurrency must be a positive integer");
  const rpc: SolanaRpc = options.rpc ?? createSolanaRpc(config.rpcUrl);
  const payToTokenAccount = associatedTokenAccount(payTo, asset, tokenProgram);
  /** Heights of blockhashes already found in finalized blocks. A finalized fact never changes. */
  const blockhashHeights = new Map<string, bigint>();

  // The RPC must serve the configured cluster and the mint must be a 6-decimal mint of the
  // configured token program, or every balance we read would be about something else.
  let clusterChecked: Promise<void> | undefined;
  const checkCluster = () =>
    (clusterChecked ??= (async () => {
      const genesis = await rpc.getGenesisHash().send();
      const served = `solana:${genesis.slice(0, 32)}`;
      if (!local && served !== config.network) throw new Error(`Solana RPC serves ${served}, not ${config.network}`);
      if (local && PUBLIC_CLUSTERS.includes(served)) {
        throw new Error(`Solana RPC serves the public cluster ${served}, but ${config.network} is configured as a local chain`);
      }
      const mint = await rpc.getAccountInfo(asset, { encoding: "jsonParsed", commitment: "confirmed" }).send();
      const data: unknown = mint.value?.data;
      const decimals = isRecord(data) && isRecord(data.parsed) && isRecord(data.parsed.info) ? data.parsed.info.decimals : undefined;
      if (!mint.value) throw new Error("the configured USDC mint does not exist on this cluster");
      if (mint.value.owner !== tokenProgram) throw new Error("the configured USDC mint is not a mint of the configured token program");
      if (decimals !== USDC_DECIMALS) throw new Error("the configured USDC mint does not have 6 decimals");
    })().catch((error: unknown) => {
      clusterChecked = undefined;
      throw error;
    }));

  /** Stored requirements must describe this rail's chain and mint. bind() also holds them to the current payTo and fee payer. */
  function termsOf(requirements: PaymentRequirements, what: "bind" | "confirm"): Terms {
    if (requirements.scheme !== "exact" || requirements.network !== config.wireNetwork || requirements.asset !== asset) {
      throw new PaymentMismatchError("the invoice was issued for a different chain or mint than this rail");
    }
    if (typeof requirements.amount !== "string" || !DECIMAL.test(requirements.amount) || BigInt(requirements.amount) === 0n) {
      throw new PaymentMismatchError("the invoice amount is not a positive decimal integer");
    }
    if (!isAddress(requirements.payTo) || !isAddress(String(requirements.extra?.feePayer))) {
      throw new PaymentMismatchError("the invoice's payTo or feePayer is not a Solana address");
    }
    const terms: Terms = {
      amount: BigInt(requirements.amount),
      payTo: requirements.payTo,
      payToTokenAccount: requirements.payTo === payTo ? payToTokenAccount : associatedTokenAccount(requirements.payTo, asset, tokenProgram),
      feePayer: address(String(requirements.extra.feePayer)),
    };
    if (what === "bind" && terms.payTo !== payTo) {
      throw new PaymentMismatchError("the receiving address changed since the invoice was issued; create a new invoice");
    }
    if (what === "bind" && terms.feePayer !== feePayer) {
      throw new PaymentMismatchError("the facilitator fee payer changed since the invoice was issued; create a new invoice");
    }
    return terms;
  }

  /**
   * Checks that a transaction pays exactly the terms and nothing else, and returns its payer.
   * Mirrors the static layout the x402 SVM facilitator accepts (@x402/svm 2.26.0, verifyStaticPath).
   */
  function inspect(transaction: Transaction, terms: Terms): Inspected {
    const mismatch = (reason: string) => new PaymentMismatchError(reason);
    let message;
    try {
      message = messageDecoder.decode(transaction.messageBytes);
    } catch {
      throw mismatch("the transaction message could not be decoded");
    }
    if (message.version !== "legacy" && message.version !== 0) throw mismatch("only legacy and version 0 transactions are accepted");
    if (message.version === 0 && (message.addressTableLookups?.length ?? 0) > 0) {
      throw mismatch("address lookup tables are not accepted");
    }
    const accounts = message.staticAccounts;
    const signerCount = message.header.numSignerAccounts;
    if (accounts[0] !== terms.feePayer) throw mismatch(`the fee payer is ${accounts[0] ?? "missing"}, not the facilitator's ${terms.feePayer}`);

    const instructions = message.instructions;
    if (instructions.length < 3 || instructions.length > 7) throw mismatch("the transaction must hold 3 to 7 instructions");
    const programOf = (index: number) => accounts[instructions[index]!.programAddressIndex];
    const dataOf = (index: number) => instructions[index]!.data ?? new Uint8Array();

    if (programOf(0) !== COMPUTE_BUDGET_PROGRAM_ADDRESS || dataOf(0)[0] !== IX_SET_COMPUTE_UNIT_LIMIT || dataOf(0).length !== 5) {
      throw mismatch("instruction 1 must set the compute unit limit");
    }
    if (programOf(1) !== COMPUTE_BUDGET_PROGRAM_ADDRESS || dataOf(1)[0] !== IX_SET_COMPUTE_UNIT_PRICE || dataOf(1).length !== 9) {
      throw mismatch("instruction 2 must set the compute unit price");
    }

    const data = dataOf(2);
    const accountIndices = instructions[2]!.accountIndices ?? [];
    if (programOf(2) !== tokenProgram || data[0] !== IX_TRANSFER_CHECKED || data.length !== 10 || accountIndices.length !== 4) {
      throw mismatch("instruction 3 must be a single-signer TransferChecked of the token program");
    }
    const [source, mint, destination, authority] = accountIndices.map((index) => accounts[index]);
    const authorityIndex = accountIndices[3]!;
    if (!source || !mint || !destination || !authority) throw mismatch("the transfer references accounts outside the message");
    if (mint !== asset) throw mismatch(`the transfer moves mint ${mint}, not ${asset}`);
    if (destination !== terms.payToTokenAccount) throw mismatch(`the transfer pays ${destination}, not payTo's token account ${terms.payToTokenAccount}`);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const amount = view.getBigUint64(1, true);
    if (amount !== terms.amount) throw mismatch(`the transfer moves ${amount}, not ${terms.amount}`);
    if (data[9] !== USDC_DECIMALS) throw mismatch("the transfer does not use 6 decimals");
    if (authorityIndex >= signerCount) throw mismatch("the transfer authority does not sign the transaction");
    if (authority === terms.feePayer) throw mismatch("the facilitator's fee payer cannot be the payer");
    if (authority === terms.payTo) throw mismatch("payTo cannot pay itself");
    // The payer spends from its own associated token account, as the x402 client builds it, so
    // confirm() can require the balance to leave the payer's account and nobody else's.
    if (source !== associatedTokenAccount(authority, asset, tokenProgram)) {
      throw mismatch(`the transfer spends from ${source}, not the payer's token account`);
    }

    for (let index = 3; index < instructions.length; index += 1) {
      const program = programOf(index);
      if (program !== MEMO_PROGRAM_ADDRESS && program !== LIGHTHOUSE_PROGRAM_ADDRESS) {
        throw mismatch(`instruction ${index + 1} calls ${program ?? "an unknown program"}; only Memo and Lighthouse may follow the transfer`);
      }
    }

    // Every signer but the fee payer must already have signed, or the transaction can never land.
    let payerSignature: string | undefined;
    for (let index = 1; index < signerCount; index += 1) {
      const signer = accounts[index];
      const signature = signer ? transaction.signatures[signer] : undefined;
      if (!signer || !signature || !ed25519Valid(signer, signature, transaction.messageBytes)) {
        throw mismatch(`signer ${signer ?? index} has not validly signed the transaction`);
      }
      if (index === authorityIndex) payerSignature = base58.decode(signature);
    }
    if (!payerSignature) throw mismatch("the payer's signature is missing");
    return { payer: authority, payerSignature, blockhash: message.lifetimeToken as Blockhash, accounts };
  }

  function payloadTransaction(payload: PaymentPayload): Transaction {
    const inner: unknown = payload.payload;
    if (!isRecord(inner) || typeof inner.transaction !== "string") {
      throw new PaymentMismatchError("payload.transaction must be a base64 transaction");
    }
    try {
      return transactionDecoder.decode(base64.encode(inner.transaction));
    } catch {
      throw new PaymentMismatchError("payload.transaction could not be decoded");
    }
  }

  async function bind(payload: PaymentPayload, requirements: PaymentRequirements): Promise<Binding> {
    const terms = termsOf(requirements, "bind");
    if (payload.x402Version !== 2) throw new PaymentMismatchError("x402Version must be 2");
    const accepted: unknown = payload.accepted;
    if (!isRecord(accepted)) throw new PaymentMismatchError("accepted requirements are missing");
    const differing = [...new Set([...Object.keys(accepted), ...Object.keys(requirements)])]
      .filter((key) => canonicalJson(accepted[key]) !== canonicalJson((requirements as Record<string, unknown>)[key]))
      .sort();
    if (differing.length > 0) throw new PaymentMismatchError(`accepted requirements differ from the invoice's in ${differing.join(", ")}`);
    // Layout, amounts, addresses, and every signer's ed25519 signature over the message bytes.
    const { payer, payerSignature, blockhash } = inspect(payloadTransaction(payload), terms);

    // The validity window: the blockhash must still be usable, or the invoice would be claimed by
    // a payment that can never land. Our RPC may trail the payer's by a slot or two.
    await checkCluster();
    let usable = false;
    for (let attempt = 1; attempt <= BLOCKHASH_CHECKS && !usable; attempt += 1) {
      if (attempt > 1) await sleep(MS_PER_SLOT);
      usable = (await rpc.isBlockhashValid(blockhash, { commitment: "processed" }).send()).value;
    }
    if (!usable) throw new PaymentMismatchError("the transaction's blockhash has expired or is unknown to this cluster; sign the payment again");

    // A usable blockhash has at most MAX_PROCESSING_AGE + 1 blocks left. At the 400 ms slot target
    // that is about a minute; maxTimeoutSeconds on top allows for slow or skipped slots. An
    // estimate for display and scheduling only: confirm() decides from block heights.
    const lifetimeMs = requirements.maxTimeoutSeconds * 1000 + Number(MAX_PROCESSING_AGE + 1n) * MS_PER_SLOT;
    return { payer, bindingId: payerSignature, validBefore: new Date(Date.now() + lifetimeMs) };
  }

  async function checkpoint(): Promise<string> {
    await checkCluster();
    return (await rpc.getSlot({ commitment: "finalized" }).send()).toString();
  }

  async function confirm(input: SolanaConfirmInput): Promise<Confirmation> {
    const terms = termsOf(input.requirements, "confirm");
    const { binding } = input;
    if (!isAddress(binding.payer) || !isSignature(binding.bindingId)) throw new Error("invalid Solana binding");
    if (!DECIMAL.test(input.checkpoint)) throw new Error("invalid Solana checkpoint");
    const checkpointSlot = BigInt(input.checkpoint);
    const blockhash = input.payload ? blockhashOf(input.payload, binding) : undefined;
    await checkCluster();

    // The finalized tip is read before looking for the transaction: anything able to land at or
    // below it is already visible to the reads that follow, so an expiry decision made against
    // it cannot miss a transaction that finalizes mid-scan.
    const finalizedSlot = await rpc.getSlot({ commitment: "finalized" }).send();
    const finalizedHeight = await rpc.getBlockHeight({ commitment: "finalized" }).send();

    // 1. The facilitator's reported id counts only if the transaction proves this payment.
    if (input.transaction && isSignature(input.transaction)) {
      const landed = await inspectLanded(input.transaction, binding, terms);
      if (isDecided(landed)) return landed;
      if (landed.state === "missing") {
        const [status] = (await rpc.getSignatureStatuses([input.transaction]).send()).value;
        if (status) return { state: "pending" };
      }
    }

    // 2. A lost or unhelpful report: search payTo's token account history back to the checkpoint.
    const found = await scan(binding, terms, checkpointSlot);
    if (found) return found;

    // 3. Nothing landed. Fail only when the blockhash provably expired.
    if (!blockhash) return { state: "pending" };
    if ((await rpc.isBlockhashValid(blockhash, { commitment: "processed" }).send()).value) return { state: "pending" };
    const height = await locateBlockhash(blockhash, checkpointSlot, finalizedSlot);
    if (height === null) return { state: "pending" };
    const lastValid = height + MAX_PROCESSING_AGE;
    if (lastValid < finalizedHeight) {
      return {
        state: "failed",
        reason: `The payment's blockhash expired at block height ${lastValid} (finalized height ${finalizedHeight}) and no transaction carrying it landed. Create a new invoice to pay again.`,
      };
    }
    return { state: "pending" };
  }

  /** The recent blockhash of the persisted payload, after checking the payload is the one bound. */
  function blockhashOf(payload: PaymentPayload, binding: Binding): Blockhash {
    const transaction = payloadTransaction(payload);
    const signature = isAddress(binding.payer) ? transaction.signatures[binding.payer] : undefined;
    if (!signature || base58.decode(signature) !== binding.bindingId) {
      throw new PaymentMismatchError("the payload is not the one this binding was made from");
    }
    let message;
    try {
      message = messageDecoder.decode(transaction.messageBytes);
    } catch {
      throw new PaymentMismatchError("the transaction message could not be decoded");
    }
    return message.lifetimeToken as Blockhash;
  }

  /** Reads one transaction at finalized commitment and says whether it proves, or rules out, this binding. */
  async function inspectLanded(signature: Signature, binding: Binding, terms: Terms): Promise<Landed> {
    let response;
    try {
      response = await rpc
        .getTransaction(signature, { commitment: "finalized", encoding: "base64", maxSupportedTransactionVersion: 0 })
        .send();
    } catch (error) {
      // A newer transaction version cannot be the legacy or v0 transaction that was bound.
      if (isSolanaError(error, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_UNSUPPORTED_TRANSACTION_VERSION)) return { state: "unrelated" };
      throw error;
    }
    if (!response) return { state: "missing" };
    let transaction: Transaction;
    try {
      transaction = transactionDecoder.decode(base64.encode(response.transaction[0]));
    } catch {
      return { state: "unrelated" };
    }
    const payerSignature = transaction.signatures[binding.payer as Address];
    if (!payerSignature || base58.decode(payerSignature) !== binding.bindingId) return { state: "unrelated" };

    // This is the message the payer signed, and the cluster checked every signature on it.
    const firstSignature = Object.values(transaction.signatures)[0];
    const id = firstSignature ? base58.decode(firstSignature) : signature;
    const meta = response.meta;
    if (!meta) throw new Error("the Solana RPC returned a transaction without status metadata");
    if (meta.err !== null) {
      return { state: "failed", reason: `Transaction ${id} carrying this payment failed on chain. Create a new invoice to pay again.` };
    }
    let inspected: Inspected;
    try {
      inspected = inspect(transaction, terms);
    } catch (error) {
      if (!(error instanceof PaymentMismatchError)) throw error;
      return { state: "failed", reason: `Transaction ${id} carrying this signature landed but does not pay this invoice: ${error.reason}` };
    }
    if (inspected.payer !== binding.payer) {
      return { state: "failed", reason: `Transaction ${id} carrying this signature landed with a different payer` };
    }

    const moved = tokenMovement(meta, [...inspected.accounts, ...loadedAddresses(meta)], binding.payer, terms);
    if (moved.received !== terms.amount || moved.paid !== terms.amount || moved.other) {
      return {
        state: "failed",
        reason: `Transaction ${id} landed but moved ${moved.received} into payTo and ${moved.paid} out of the payer${moved.other ? " and touched other token accounts" : ""}, not exactly ${terms.amount}`,
      };
    }
    return { state: "confirmed", transaction: id, payer: binding.payer };
  }

  /** Token balance changes of the configured mint, from the transaction's own metadata. */
  function tokenMovement(
    meta: { preTokenBalances?: readonly TokenBalanceLike[]; postTokenBalances?: readonly TokenBalanceLike[] },
    keys: readonly Address[],
    payer: string,
    terms: Terms,
  ): { received: bigint; paid: bigint; other: boolean } {
    if (!meta.preTokenBalances || !meta.postTokenBalances) {
      throw new Error("the Solana RPC did not return token balances, so it cannot confirm SPL payments");
    }
    const changes = new Map<string, { owner: string; delta: bigint }>();
    const record = (balances: readonly TokenBalanceLike[], sign: bigint) => {
      for (const balance of balances) {
        if (balance.mint !== asset) continue;
        const account = keys[balance.accountIndex];
        if (!account || !balance.owner) throw new Error("the Solana RPC returned token balances without accounts or owners");
        const entry = changes.get(account) ?? { owner: balance.owner, delta: 0n };
        entry.delta += sign * BigInt(balance.uiTokenAmount.amount);
        changes.set(account, entry);
      }
    };
    record(meta.preTokenBalances, -1n);
    record(meta.postTokenBalances, 1n);
    let received = 0n;
    let paid = 0n;
    let other = false;
    for (const [account, { owner, delta }] of changes) {
      if (delta === 0n) continue;
      if (account === terms.payToTokenAccount && owner === terms.payTo) received += delta;
      else if (owner === payer) paid -= delta;
      else other = true;
    }
    return { received, paid, other };
  }

  /** Walks payTo's token account history, newest first, down to the checkpoint slot. */
  async function scan(binding: Binding, terms: Terms, checkpointSlot: bigint): Promise<Confirmation | null> {
    let before: Signature | undefined;
    for (;;) {
      const page = await rpc
        .getSignaturesForAddress(terms.payToTokenAccount, { commitment: "finalized", limit: SIGNATURE_PAGE, ...(before ? { before } : {}) })
        .send();
      const inRange = page.filter((entry) => entry.slot >= checkpointSlot);
      for (let start = 0; start < inRange.length; start += concurrency) {
        const verdicts = await Promise.all(
          inRange.slice(start, start + concurrency).map((entry) => inspectLanded(entry.signature, binding, terms)),
        );
        const decided = verdicts.find(isDecided);
        if (decided) return decided;
      }
      if (page.length < SIGNATURE_PAGE || inRange.length < page.length) return null;
      before = page[page.length - 1]!.signature;
    }
  }

  /**
   * The block height of the finalized block whose blockhash this is, searching from 150 blocks
   * before the checkpoint (a payment signed after the invoice was created can still use a
   * blockhash that old) up to the finalized slot read at the start of confirm(). null if absent.
   */
  async function locateBlockhash(blockhash: Blockhash, checkpointSlot: bigint, finalizedSlot: bigint): Promise<bigint | null> {
    const known = blockhashHeights.get(blockhash);
    if (known !== undefined) return known;
    const from = await searchStart(checkpointSlot);
    for (let start = from; start <= finalizedSlot; start += BLOCK_RANGE) {
      const end = start + BLOCK_RANGE - 1n < finalizedSlot ? start + BLOCK_RANGE - 1n : finalizedSlot;
      const slots = await rpc.getBlocks(start, end, { commitment: "finalized" }).send();
      for (let index = 0; index < slots.length; index += concurrency) {
        const blocks = await Promise.all(
          slots
            .slice(index, index + concurrency)
            .map((slot) => rpc.getBlock(slot, { commitment: "finalized", transactionDetails: "none", rewards: false }).send()),
        );
        for (const block of blocks) {
          if (!block || typeof block.blockHeight !== "bigint") continue;
          const height =
            block.blockhash === blockhash ? block.blockHeight : block.previousBlockhash === blockhash ? block.blockHeight - 1n : null;
          if (height !== null) {
            blockhashHeights.set(blockhash, height);
            return height;
          }
        }
      }
    }
    return null;
  }

  /** The slot of the finalized block 150 blocks before the checkpoint, or the oldest one this RPC still has. */
  async function searchStart(checkpointSlot: bigint): Promise<bigint> {
    const first = await rpc.getFirstAvailableBlock().send();
    if (first >= checkpointSlot) return first;
    const needed = Number(MAX_PROCESSING_AGE) + 1;
    for (let span = BigInt(needed) * 2n; ; span *= 2n) {
      const start = checkpointSlot > first + span ? checkpointSlot - span : first;
      const slots = await rpc.getBlocks(start, checkpointSlot, { commitment: "finalized" }).send();
      if (slots.length >= needed) return slots[slots.length - needed]!;
      if (start === first || span >= BLOCK_RANGE) return start;
    }
  }

  return { config, payToTokenAccount, requirements, bind, checkpoint, confirm };

  function requirements(amountMicro: bigint, maxTimeoutSeconds: number): PaymentRequirements {
    if (typeof amountMicro !== "bigint" || amountMicro <= 0n) throw new Error("amountMicro must be a positive bigint");
    if (!Number.isInteger(maxTimeoutSeconds) || maxTimeoutSeconds <= 0) throw new Error("maxTimeoutSeconds must be a positive integer");
    return {
      scheme: "exact",
      network: config.wireNetwork as PaymentRequirements["network"],
      asset,
      amount: amountMicro.toString(),
      payTo,
      maxTimeoutSeconds,
      extra: { ...config.extra, feePayer },
    };
  }
}

type TokenBalanceLike = { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } };

function isDecided(landed: Landed): landed is Confirmation {
  return landed.state === "confirmed" || landed.state === "failed";
}

function loadedAddresses(meta: object): Address[] {
  const loaded = (meta as { loadedAddresses?: { writable: readonly Address[]; readonly: readonly Address[] } }).loadedAddresses;
  return loaded ? [...loaded.writable, ...loaded.readonly] : [];
}

function ed25519Valid(signer: Address, signature: ReadonlyUint8Array, message: ReadonlyUint8Array): boolean {
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Uint8Array.from(addressEncoder.encode(signer))]), format: "der", type: "spki" });
    return verifyEd25519(null, Uint8Array.from(message), key, Uint8Array.from(signature));
  } catch {
    return false;
  }
}

function requireAddress(value: unknown, name: string): Address {
  if (typeof value !== "string" || !isAddress(value)) throw new Error(`${name} must be a Solana address`);
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON with sorted keys and undefined members dropped, so equal requirements compare equal however they were encoded. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
