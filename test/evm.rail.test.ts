import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { getAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEvmRail, type EvmRail } from "../src/charges/evm.js";
import { PaymentMismatchError, type Confirmation } from "../src/charges/rail.js";
import {
  LOCAL_NETWORK,
  RPC_URL,
  TOKEN_DOMAIN,
  advanceChainTime,
  createLocalFacilitator,
  deployUsdc,
  funded,
  publicClient,
  signPayment,
  startAnvil,
  usdcAbi,
  type Anvil,
  type Token,
} from "./fixtures/evm/chain.js";

const CONFIRMATIONS = 2;
const newAddress = () => privateKeyToAccount(generatePrivateKey()).address;

let anvil: Anvil | undefined;
let token: Token;
let payer: PrivateKeyAccount;
let payTo: Address;
let rail: EvmRail;
let facilitator: Awaited<ReturnType<typeof createLocalFacilitator>>;

beforeAll(async () => {
  anvil = await startAnvil();
  token = await deployUsdc();
  payer = (await funded()).account;
  await token.mint(payer.address, 100_000_000n);
  payTo = newAddress();
  facilitator = await createLocalFacilitator();
  rail = createEvmRail(
    { network: LOCAL_NETWORK, wireNetwork: LOCAL_NETWORK, asset: token.address, payTo, rpcUrl: RPC_URL, extra: { ...TOKEN_DOMAIN } },
    { confirmations: CONFIRMATIONS, client: publicClient() },
  );
});
afterAll(async () => {
  await anvil?.stop();
});

/** Calls confirm until it is no longer pending, for at most `ms`. */
async function confirmWithin(input: Parameters<EvmRail["confirm"]>[0], ms = 15_000): Promise<Confirmation> {
  const deadline = Date.now() + ms;
  for (;;) {
    const result = await rail.confirm(input);
    if (result.state !== "pending" || Date.now() > deadline) return result;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Flips one byte of a hex string, keeping it well-formed. */
const flipByte = (hex: string, index: number) => {
  const bytes = Buffer.from(hex.slice(2), "hex");
  bytes[index] = bytes[index]! ^ 0xff;
  return `0x${bytes.toString("hex")}`;
};

/** Re-signs the payload's authorization with `signer`, keeping `from`, optionally over a different EIP-712 domain. */
async function resign(payload: PaymentPayload, signer: PrivateKeyAccount, domain: { chainId?: number; verifyingContract?: Address } = {}): Promise<PaymentPayload> {
  const authorization = (payload.payload as { authorization: Record<string, string> }).authorization;
  const signature = await signer.signTypedData({
    domain: { ...TOKEN_DOMAIN, chainId: domain.chainId ?? 31337, verifyingContract: domain.verifyingContract ?? getAddress(token.address) },
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
  return { ...payload, payload: { authorization, signature } };
}

const mutate = (payload: PaymentPayload, change: (copy: { accepted: Record<string, unknown>; payload: Record<string, any> } & Record<string, any>) => void): PaymentPayload => {
  const copy = structuredClone(payload) as never;
  change(copy);
  return copy;
};

describe("requirements", () => {
  it("asks for an exact EIP-3009 payment in atomic USDC units", () => {
    expect(rail.requirements(5_000_000n, 300)).toEqual({
      scheme: "exact",
      network: LOCAL_NETWORK,
      asset: getAddress(token.address),
      amount: "5000000",
      payTo: getAddress(payTo),
      maxTimeoutSeconds: 300,
      extra: { name: "USDC", version: "2" },
    });
  });

  it("refuses a misconfigured rail", () => {
    const base = { network: LOCAL_NETWORK, wireNetwork: LOCAL_NETWORK, asset: token.address, payTo, rpcUrl: RPC_URL, extra: { ...TOKEN_DOMAIN } };
    expect(() => createEvmRail({ ...base, network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" }, { confirmations: 1 })).toThrow(/eip155/);
    expect(() => createEvmRail({ ...base, payTo: "0x0000000000000000000000000000000000000000" }, { confirmations: 1 })).toThrow(/payTo/);
    expect(() => createEvmRail({ ...base, extra: {} }, { confirmations: 1 })).toThrow(/EIP-712/);
    expect(() => createEvmRail(base, { confirmations: 0 })).toThrow(/confirmations/);
  });
});

describe("bind", () => {
  let requirements: PaymentRequirements;
  let payload: PaymentPayload;
  beforeAll(async () => {
    requirements = rail.requirements(2_000_000n, 300);
    payload = await signPayment(payer, requirements);
  });

  it("binds a standard client's payment to its payer and nonce", async () => {
    const nonce = (payload.payload as { authorization: { nonce: string; validBefore: string } }).authorization;
    const binding = await rail.bind(payload, requirements);
    expect(binding.payer).toBe(getAddress(payer.address));
    expect(binding.bindingId).toBe(nonce.nonce.toLowerCase());
    expect(binding.validBefore.getTime()).toBe(Number(nonce.validBefore) * 1000);
  });

  const other = "0x1111111111111111111111111111111111111111";
  const cases: [string, (p: any) => void, RegExp][] = [
    ["x402 version 1", (p) => (p.x402Version = 1), /x402Version/],
    ["another scheme", (p) => (p.accepted.scheme = "upto"), /scheme/],
    ["another network", (p) => (p.accepted.network = "eip155:84532"), /network/],
    ["another asset", (p) => (p.accepted.asset = other), /asset/],
    ["another payTo", (p) => (p.accepted.payTo = other), /payTo/],
    ["another amount", (p) => (p.accepted.amount = "1999999"), /amount/],
    ["another timeout", (p) => (p.accepted.maxTimeoutSeconds = 3600), /maxTimeoutSeconds/],
    ["another token domain", (p) => (p.accepted.extra = { name: "USD Coin", version: "2" }), /extra/],
    ["an authorization to someone else", (p) => (p.payload.authorization.to = other), /payTo/],
    ["an authorization for less", (p) => (p.payload.authorization.value = "1000000"), /amount/],
    ["a non-canonical value", (p) => (p.payload.authorization.value = "02000000"), /amount/],
    ["a validAfter in the future", (p) => (p.payload.authorization.validAfter = String(Math.floor(Date.now() / 1000) + 120)), /not valid yet/],
    ["an expired validBefore", (p) => (p.payload.authorization.validBefore = String(Math.floor(Date.now() / 1000) - 1)), /expired/],
    ["a validBefore past the timeout", (p) => (p.payload.authorization.validBefore = String(Math.floor(Date.now() / 1000) + 3600)), /maxTimeoutSeconds/],
    ["a short nonce", (p) => (p.payload.authorization.nonce = "0x1234"), /nonce/],
    ["a smart-wallet signature", (p) => (p.payload.signature = p.payload.signature + "00"), /65-byte/],
    ["a zero payer", (p) => (p.payload.authorization.from = "0x0000000000000000000000000000000000000000"), /from/],
    ["a numeric value", (p) => (p.payload.authorization.value = 2000000), /strings/],
    ["an extra authorization field", (p) => (p.payload.authorization.extra = "1"), /authorization must hold/],
    ["a Permit2 payload", (p) => (p.payload = { permit2Authorization: {}, signature: p.payload.signature }), /EIP-3009/],
  ];
  for (const [name, change, reason] of cases) {
    it(`refuses ${name}`, async () => {
      const bad = mutate(payload, change);
      await expect(rail.bind(bad, requirements)).rejects.toThrow(PaymentMismatchError);
      await expect(rail.bind(bad, requirements)).rejects.toThrow(reason);
    });
  }

  it("refuses requirements this rail no longer issues", async () => {
    const moved = { ...requirements, payTo: other };
    await expect(rail.bind(mutate(payload, (p) => (p.accepted.payTo = other)), moved)).rejects.toThrow(/receiving address changed/);
  });

  // Well-formed payloads whose every field matches, but which the payer did not sign as they stand.
  const notSignedByPayer: [string, () => Promise<PaymentPayload>][] = [
    ["a corrupted signature", async () => mutate(payload, (p) => (p.payload.signature = flipByte(p.payload.signature, 10)))],
    ["a signature by another key", async () => resign(payload, privateKeyToAccount(generatePrivateKey()))],
    ["a signature over another token's domain", async () => resign(payload, payer, { verifyingContract: other })],
    ["a signature over another chain's domain", async () => resign(payload, payer, { chainId: 84532 })],
    ["a field changed after signing", async () => mutate(payload, (p) => (p.payload.authorization.validBefore = String(Number(p.payload.authorization.validBefore) - 1)))],
  ];
  for (const [name, make] of notSignedByPayer) {
    it(`refuses ${name}`, async () => {
      await expect(rail.bind(await make(), requirements)).rejects.toThrow(/signature is not authorization.from's signature/);
    });
  }
});

describe("checkpoint", () => {
  it("returns the current block and refuses an RPC serving another chain", async () => {
    const block = await rail.checkpoint();
    expect(BigInt(block)).toBeGreaterThan(0n);
    const wrongChain = createEvmRail(
      { network: "eip155:84532", wireNetwork: "eip155:84532", asset: token.address, payTo, rpcUrl: RPC_URL, extra: { ...TOKEN_DOMAIN } },
      { confirmations: 1 },
    );
    await expect(wrongChain.checkpoint()).rejects.toThrow(/serves chain 31337/);
  });
});

describe("confirm", () => {
  it("confirms a settled payment only after enough confirmations, with or without the facilitator's hash", async () => {
    const checkpoint = await rail.checkpoint();
    const requirements = rail.requirements(3_000_000n, 300);
    const payload = await signPayment(payer, requirements);
    const binding = await rail.bind(payload, requirements);
    const settled = await facilitator.settle(payload, requirements);
    expect(settled.success).toBe(true);

    const input = { requirements, binding, checkpoint, validBefore: binding.validBefore };
    const receipt = await publicClient().getTransactionReceipt({ hash: settled.transaction as `0x${string}` });
    const head = await publicClient().getBlockNumber();
    if (head - receipt.blockNumber + 1n < BigInt(CONFIRMATIONS)) {
      expect(await rail.confirm({ ...input, transaction: settled.transaction })).toEqual({ state: "pending" });
    }
    const withHash = await confirmWithin({ ...input, transaction: settled.transaction });
    expect(withHash).toEqual({ state: "confirmed", transaction: settled.transaction.toLowerCase(), payer: getAddress(payer.address) });
    // A lost facilitator response: the scan from the checkpoint finds the same transaction.
    expect(await rail.confirm(input)).toEqual(withHash);
    expect(await token.balanceOf(payTo)).toBeGreaterThanOrEqual(3_000_000n);
  });

  it("ignores a reported transaction that pays someone else's authorization", async () => {
    const checkpoint = await rail.checkpoint();
    const requirements = rail.requirements(4_000_000n, 300);
    // Payment A settles for real. Payment B, same payer, payee and amount, is never settled.
    const paid = await signPayment(payer, requirements);
    const settled = await facilitator.settle(paid, requirements);
    expect(settled.success).toBe(true);
    const paidBinding = await rail.bind(paid, requirements);
    expect((await confirmWithin({ requirements, binding: paidBinding, checkpoint, transaction: settled.transaction, validBefore: paidBinding.validBefore })).state).toBe("confirmed");
    const unpaid = await signPayment(payer, requirements);
    const binding = await rail.bind(unpaid, requirements);
    // A's receipt holds Transfer(payer, payTo, amount) but not AuthorizationUsed for B's nonce.
    expect(await rail.confirm({ requirements, binding, checkpoint, transaction: settled.transaction, validBefore: binding.validBefore })).toEqual({ state: "pending" });
    expect(await rail.confirm({ requirements, binding, checkpoint, transaction: `0x${"ab".repeat(32)}`, validBefore: binding.validBefore })).toEqual({ state: "pending" });
  });

  it("fails an unused authorization only once a finalized block is past validBefore", async () => {
    const checkpoint = await rail.checkpoint();
    const requirements = rail.requirements(1_000_000n, 300);
    const payload = await signPayment(payer, requirements);
    const binding = await rail.bind(payload, requirements);
    const input = { requirements, binding, checkpoint, validBefore: binding.validBefore };
    expect(await rail.confirm(input)).toEqual({ state: "pending" });
    // This moves chain time forward for the rest of this file, so it runs last.
    await advanceChainTime(400);
    const result = await confirmWithin(input, 10_000);
    expect(result.state).toBe("failed");
    // The payer's funds never moved for it.
    expect(await publicClient().readContract({ address: token.address, abi: usdcAbi, functionName: "authorizationState", args: [payer.address, binding.bindingId] })).toBe(false);
  });
});
