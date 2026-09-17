import type { Network, PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { getDefaultAsset } from "@x402/evm";
import {
  createPublicClient,
  getAddress,
  http,
  isAddress,
  isHash,
  pad,
  parseAbi,
  parseAbiItem,
  toEventSelector,
  TransactionReceiptNotFoundError,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import type { Config } from "../config.js";
import { canonicalJson } from "./crypto.js";
import { PaymentMismatchError, type Binding, type Confirmation, type Rail, type RailConfig } from "./rail.js";

/**
 * The EVM rail: x402 v2 `exact` payments made with an EIP-3009 `transferWithAuthorization`
 * of USDC. Reconciliation follows Cubicle's rail (desktop_service/x402_rail.py):
 *
 * - A payment is proven by one successful receipt, in a canonical block with enough
 *   confirmations, holding exactly one `AuthorizationUsed(payer, nonce)` and exactly one
 *   `Transfer(payer, payTo, amount)` from the USDC contract.
 * - The facilitator's reported hash is only a hint. Without it, or when it proves nothing,
 *   `AuthorizationUsed(payer, nonce)` logs are scanned forward from the invoice checkpoint.
 * - An invoice fails only when a finalized block past `validBefore` shows the authorization
 *   unused. Anything less certain stays pending.
 *
 * Unlike Cubicle, the nonce is the payer's own (any standard x402 v2 client picks it), and
 * the binding is that nonce.
 */

const AUTHORIZATION_USED_TOPIC = toEventSelector("AuthorizationUsed(address,bytes32)");
const TRANSFER_TOPIC = toEventSelector("Transfer(address,address,uint256)");
const authorizationUsedEvent = parseAbiItem("event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)");
const tokenAbi = parseAbi([
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "function decimals() view returns (uint8)",
]);

const DECIMAL = /^(0|[1-9][0-9]*)$/;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const EOA_SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const AUTHORIZATION_KEYS = ["from", "nonce", "to", "validAfter", "validBefore", "value"] as const;

/** x402's own EVM facilitator refuses an authorization with less than 6 seconds left, and so do we. */
const MIN_SECONDS_LEFT = 6n;
/** Payer clock drift allowed past maxTimeoutSeconds. Cubicle's rail allows 30 seconds. */
const DEFAULT_CLOCK_SKEW_SECONDS = 30;
/** eth_getLogs window when scanning for a lost settlement. Cubicle's rail scans 2,000 blocks at a time. */
const DEFAULT_LOG_CHUNK_BLOCKS = 2000;

export type EvmRailOptions = {
  /** Blocks a settlement must have, counting its own (EVM_CONFIRMATIONS). */
  confirmations: number;
  logChunkBlocks?: number;
  clockSkewSeconds?: number;
  /** Clock for authorization validity checks in bind(). Tests only. */
  now?: () => Date;
  /** Defaults to an HTTP client on config.rpcUrl. */
  client?: PublicClient;
};

/** The EVM binding also carries the authorization's own validBefore, which confirm() needs back. */
export type EvmBinding = Binding & { validBefore: Date };

export interface EvmRail extends Rail {
  bind(payload: PaymentPayload, requirements: PaymentRequirements): EvmBinding;
}

type Expected = { payer: Address; payTo: Address; amount: bigint; nonce: Hex };

export function createEvmRail(config: RailConfig, options: EvmRailOptions): EvmRail {
  const chainId = parseChainId(config.network);
  if (config.wireNetwork !== config.network) throw new Error("an EVM rail sends its own network on the wire");
  const asset = requireAddress(config.asset, "asset");
  const payTo = requireAddress(config.payTo, "payTo");
  if (!nonEmptyString(config.extra.name) || !nonEmptyString(config.extra.version)) {
    throw new Error("an EVM rail needs extra.name and extra.version (the token's EIP-712 domain)");
  }
  if (!Number.isInteger(options.confirmations) || options.confirmations < 1) throw new Error("confirmations must be a positive integer");
  const logChunk = BigInt(options.logChunkBlocks ?? DEFAULT_LOG_CHUNK_BLOCKS);
  const clockSkew = options.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
  const now = options.now ?? (() => new Date());
  const client: PublicClient = options.client ?? createPublicClient({ transport: http(config.rpcUrl) });

  // The RPC must serve the configured chain, and the token must have USDC's 6 decimals,
  // or every amount and every log we read would be about something else.
  let chainChecked: Promise<void> | undefined;
  const checkChain = () =>
    (chainChecked ??= (async () => {
      const served = await client.getChainId();
      if (served !== chainId) throw new Error(`EVM RPC serves chain ${served}, not ${config.network}`);
      const decimals = await client.readContract({ address: asset, abi: tokenAbi, functionName: "decimals" });
      if (decimals !== 6) throw new Error("the configured USDC contract does not have 6 decimals");
    })().catch((error: unknown) => {
      chainChecked = undefined;
      throw error;
    }));

  /** Stored requirements must still describe this rail: a changed payTo or token needs a new invoice. */
  function assertIssuedHere(requirements: PaymentRequirements, what: "bind" | "confirm") {
    if (requirements.scheme !== "exact" || requirements.network !== config.wireNetwork || !sameAddress(requirements.asset, asset)) {
      throw new PaymentMismatchError("the invoice was issued for a different chain or token than this rail");
    }
    if (what === "bind" && !sameAddress(requirements.payTo, payTo)) {
      throw new PaymentMismatchError("the receiving address changed since the invoice was issued; create a new invoice");
    }
    if (!DECIMAL.test(requirements.amount)) throw new PaymentMismatchError("the invoice amount is not a decimal integer");
  }

  function bind(payload: PaymentPayload, requirements: PaymentRequirements): EvmBinding {
    assertIssuedHere(requirements, "bind");
    const mismatch = (reason: string) => new PaymentMismatchError(reason);
    if (payload.x402Version !== 2) throw mismatch("x402Version must be 2");

    // Every field of the requirements the payer accepted must be exactly what the invoice asked for.
    const accepted: unknown = payload.accepted;
    if (!isRecord(accepted)) throw mismatch("accepted requirements are missing");
    if (accepted.scheme !== "exact") throw mismatch("scheme must be exact");
    if (accepted.network !== requirements.network) throw mismatch("wrong network");
    if (!sameAddress(accepted.asset, requirements.asset)) throw mismatch("wrong asset");
    if (!sameAddress(accepted.payTo, requirements.payTo)) throw mismatch("wrong payTo");
    if (accepted.amount !== requirements.amount) throw mismatch("wrong amount");
    if (accepted.maxTimeoutSeconds !== requirements.maxTimeoutSeconds) throw mismatch("wrong maxTimeoutSeconds");
    if (canonicalJson(accepted.extra ?? {}) !== canonicalJson(requirements.extra ?? {})) throw mismatch("wrong extra (EIP-712 name and version)");

    // The signed EIP-3009 authorization must pay exactly that.
    const inner: unknown = payload.payload;
    if (!isRecord(inner) || !hasExactKeys(inner, ["authorization", "signature"])) {
      throw mismatch("only EIP-3009 authorization payloads are accepted");
    }
    const authorization = inner.authorization;
    if (!isRecord(authorization) || !hasExactKeys(authorization, AUTHORIZATION_KEYS) || !AUTHORIZATION_KEYS.every((key) => typeof authorization[key] === "string")) {
      throw mismatch("authorization must hold from, to, value, validAfter, validBefore and nonce as strings");
    }
    const { from, to, value, validAfter, validBefore, nonce } = authorization as Record<(typeof AUTHORIZATION_KEYS)[number], string>;
    if (!isAddress(from, { strict: false }) || sameAddress(from, zeroAddress)) throw mismatch("authorization.from is not an address");
    if (!sameAddress(to, requirements.payTo)) throw mismatch("wrong payTo in the authorization");
    if (!DECIMAL.test(value) || value !== requirements.amount) throw mismatch("wrong amount in the authorization");
    if (!DECIMAL.test(validAfter) || !DECIMAL.test(validBefore)) throw mismatch("authorization validity bounds must be decimal integers");
    const nowSeconds = BigInt(Math.floor(now().getTime() / 1000));
    if (BigInt(validAfter) > nowSeconds) throw mismatch("authorization is not valid yet");
    if (BigInt(validBefore) < nowSeconds + MIN_SECONDS_LEFT) throw mismatch("authorization has expired (validBefore)");
    // A bounded window keeps "expired unused" provable soon, so a stuck invoice resolves.
    if (BigInt(validBefore) > nowSeconds + BigInt(requirements.maxTimeoutSeconds + clockSkew)) {
      throw mismatch("authorization validBefore is later than maxTimeoutSeconds allows");
    }
    if (!HEX32.test(nonce)) throw mismatch("authorization.nonce must be 32 bytes of hex");
    if (typeof inner.signature !== "string" || !EOA_SIGNATURE.test(inner.signature)) throw mismatch("signature must be a 65-byte EOA signature");

    // The nonce is lowercased so the unique (network, binding_id) index cannot be dodged by case.
    return { payer: getAddress(from), bindingId: nonce.toLowerCase(), validBefore: new Date(Number(validBefore) * 1000) };
  }

  async function checkpoint(): Promise<string> {
    await checkChain();
    return (await client.getBlockNumber()).toString();
  }

  async function confirm(input: Parameters<Rail["confirm"]>[0]): Promise<Confirmation> {
    await checkChain();
    const { requirements, binding } = input;
    assertIssuedHere(requirements, "confirm");
    if (!isAddress(binding.payer, { strict: false }) || !HEX32.test(binding.bindingId)) throw new Error("invalid EVM binding");
    if (!DECIMAL.test(input.checkpoint)) throw new Error("invalid EVM checkpoint");
    const expected: Expected = {
      payer: getAddress(binding.payer),
      payTo: getAddress(requirements.payTo),
      amount: BigInt(requirements.amount),
      nonce: binding.bindingId.toLowerCase() as Hex,
    };

    // 1. The facilitator's reported hash counts only if its receipt proves this exact payment.
    if (input.transaction && isHash(input.transaction)) {
      const proof = await proveTransaction(input.transaction, expected);
      if (proof) return proof;
    }

    // 2. A lost or wrong report: find where the authorization was used, from the checkpoint on.
    const head = await client.getBlockNumber();
    const uses = await findAuthorizationUses(expected, BigInt(input.checkpoint), head);
    if (uses.length === 1) return (await proveTransaction(uses[0]!, expected)) ?? { state: "pending" };
    // A single-use nonce used in two transactions cannot happen on one canonical chain. Leave it for an operator.
    if (uses.length > 1) return { state: "pending" };

    // 3. No proof of payment. Fail only when the chain proves it can never land.
    if (await expiredUnused(expected, input.validBefore)) {
      return { state: "failed", reason: "The payment authorization expired without being used. Create a new invoice to pay again." };
    }
    return { state: "pending" };
  }

  /** null: this transaction does not prove the payment. pending: it does, but is not yet final enough. */
  async function proveTransaction(hash: Hex, expected: Expected): Promise<Confirmation | null> {
    const receipt = await receiptOrNull(hash);
    if (!receipt || receipt.status !== "success" || !receiptProvesPayment(receipt, expected)) return null;
    const head = await client.getBlockNumber();
    if (head < receipt.blockNumber || head - receipt.blockNumber + 1n < BigInt(options.confirmations)) return { state: "pending" };
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    if (!block.hash || block.hash.toLowerCase() !== receipt.blockHash.toLowerCase()) return { state: "pending" };
    return { state: "confirmed", transaction: receipt.transactionHash.toLowerCase(), payer: expected.payer };
  }

  async function receiptOrNull(hash: Hex): Promise<TransactionReceipt | null> {
    try {
      return await client.getTransactionReceipt({ hash });
    } catch (error) {
      if (error instanceof TransactionReceiptNotFoundError) return null;
      throw error;
    }
  }

  /** Exactly one AuthorizationUsed(payer, nonce) and exactly one Transfer(payer, payTo, amount), both from the USDC contract. */
  function receiptProvesPayment(receipt: TransactionReceipt, expected: Expected): boolean {
    const logs = receipt.logs.filter((log) => sameAddress(log.address, asset) && !log.removed);
    const used = logs.filter((log) => topicsEqual(log.topics, [AUTHORIZATION_USED_TOPIC, pad(expected.payer), expected.nonce]));
    const transfers = logs.filter(
      (log) =>
        topicsEqual(log.topics, [TRANSFER_TOPIC, pad(expected.payer), pad(expected.payTo)]) &&
        /^0x[0-9a-fA-F]{64}$/.test(log.data) &&
        BigInt(log.data) === expected.amount,
    );
    return used.length === 1 && transfers.length === 1;
  }

  async function findAuthorizationUses(expected: Expected, fromBlock: bigint, head: bigint): Promise<Hex[]> {
    const hashes = new Set<string>();
    for (let start = fromBlock; start <= head; start += logChunk) {
      const end = start + logChunk - 1n < head ? start + logChunk - 1n : head;
      const logs = await client.getLogs({
        address: asset,
        event: authorizationUsedEvent,
        args: { authorizer: expected.payer, nonce: expected.nonce },
        fromBlock: start,
        toBlock: end,
      });
      for (const log of logs) if (!log.removed && log.transactionHash) hashes.add(log.transactionHash.toLowerCase());
    }
    return [...hashes] as Hex[];
  }

  /**
   * EIP-3009 accepts an authorization only while block.timestamp < validBefore. Once a finalized
   * block is past validBefore with the nonce still unused, no later block can use it.
   */
  async function expiredUnused(expected: Expected, validBefore: Date): Promise<boolean> {
    const finalized = await client.getBlock({ blockTag: "finalized" });
    if (finalized.number === null) return false;
    if (finalized.timestamp <= BigInt(Math.floor(validBefore.getTime() / 1000))) return false;
    const used = await client.readContract({
      address: asset,
      abi: tokenAbi,
      functionName: "authorizationState",
      args: [expected.payer, expected.nonce],
      blockNumber: finalized.number,
    });
    return used === false;
  }

  return {
    config,
    requirements(amountMicro: bigint, maxTimeoutSeconds: number): PaymentRequirements {
      if (amountMicro <= 0n) throw new Error("amount must be positive");
      if (!Number.isInteger(maxTimeoutSeconds) || maxTimeoutSeconds <= 0) throw new Error("maxTimeoutSeconds must be a positive integer");
      return {
        scheme: "exact",
        network: config.wireNetwork as Network,
        asset,
        // USDC has 6 decimals, so micro-USDC are the token's atomic units.
        amount: amountMicro.toString(),
        payTo,
        maxTimeoutSeconds,
        extra: { ...config.extra },
      };
    },
    bind,
    checkpoint,
    confirm,
  };
}

/** SPEC.md's EVM invoice networks: Base Sepolia and Base. */
const INVOICE_NETWORKS = new Set(["eip155:84532", "eip155:8453"]);

/**
 * The EVM rail for this deployment's environment. The token is always the network's canonical
 * USDC from x402's own asset table, which also supplies its EIP-712 name and version; EVM_USDC,
 * when set, must restate that address. Local chains are for tests, which call createEvmRail directly.
 */
export function createEvmRailFromConfig(config: Pick<Config, "EVM_NETWORK" | "EVM_RPC_URL" | "EVM_USDC" | "PAY_TO_EVM" | "EVM_CONFIRMATIONS">): EvmRail {
  if (!INVOICE_NETWORKS.has(config.EVM_NETWORK)) throw new Error(`EVM invoices support ${[...INVOICE_NETWORKS].join(" and ")}, not ${config.EVM_NETWORK}`);
  if (!config.EVM_RPC_URL || !config.PAY_TO_EVM) throw new Error("EVM invoices need EVM_RPC_URL and PAY_TO_EVM");
  const usdc = getDefaultAsset(config.EVM_NETWORK as Network, "USDC");
  if (usdc.decimals !== 6) throw new Error(`x402 lists USDC on ${config.EVM_NETWORK} with ${usdc.decimals} decimals`);
  if (config.EVM_USDC && !sameAddress(config.EVM_USDC, usdc.asset)) {
    throw new Error(`EVM_USDC is not the canonical USDC on ${config.EVM_NETWORK} (${usdc.asset})`);
  }
  return createEvmRail(
    {
      network: config.EVM_NETWORK,
      wireNetwork: config.EVM_NETWORK,
      asset: usdc.asset,
      payTo: config.PAY_TO_EVM,
      rpcUrl: config.EVM_RPC_URL,
      extra: { name: usdc.name, version: usdc.version },
    },
    { confirmations: config.EVM_CONFIRMATIONS },
  );
}

function parseChainId(network: string): number {
  const match = /^eip155:([1-9][0-9]*)$/.exec(network);
  if (!match) throw new Error(`${network} is not an eip155 network`);
  return Number(match[1]);
}

function requireAddress(value: string, name: string): Address {
  if (!isAddress(value, { strict: false }) || sameAddress(value, zeroAddress)) throw new Error(`EVM rail ${name} is not an address`);
  return getAddress(value);
}

function sameAddress(a: unknown, b: unknown): boolean {
  return typeof a === "string" && typeof b === "string" && isAddress(a, { strict: false }) && isAddress(b, { strict: false }) && a.toLowerCase() === b.toLowerCase();
}

function topicsEqual(actual: readonly Hex[], expected: readonly Hex[]): boolean {
  return actual.length === expected.length && actual.every((topic, i) => topic.toLowerCase() === expected[i]!.toLowerCase());
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...keys].sort();
  return actual.length === wanted.length && actual.every((key, i) => key === wanted[i]);
}
