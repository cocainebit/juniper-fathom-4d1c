/**
 * Local EVM counterparties for tests: an Anvil on the repo's test port, the MockUSDC fixture,
 * an in-process x402 facilitator and a standard x402 v2 payer. Nothing here runs outside tests.
 * Keys are generated per run and never printed.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { x402Client } from "@x402/core/client";
import { x402Facilitator } from "@x402/core/facilitator";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequired, PaymentRequirements, SupportedResponse } from "@x402/core/types";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { ExactEvmScheme as ExactEvmClientScheme } from "@x402/evm/exact/client";
import { ExactEvmScheme as ExactEvmFacilitatorScheme } from "@x402/evm/exact/facilitator";
import { createPublicClient, createWalletClient, defineChain, http, parseEther, type Abi, type Address, type Hex, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

export const ANVIL_PORT = 8761;
export const LOCAL_CHAIN_ID = 31337;
export const LOCAL_NETWORK = "eip155:31337";
export const RPC_URL = `http://127.0.0.1:${ANVIL_PORT}`;
/** MockUSDC's EIP-712 domain. */
export const TOKEN_DOMAIN = { name: "USDC", version: "2" } as const;

const fixture = JSON.parse(readFileSync(new URL("./MockUSDC.json", import.meta.url), "utf8")) as { abi: Abi; bytecode: Hex };
export const usdcAbi = fixture.abi;

export const localChain = defineChain({
  id: LOCAL_CHAIN_ID,
  name: "Anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

export const publicClient = (): PublicClient => createPublicClient({ chain: localChain, transport: http(RPC_URL), pollingInterval: 100 }) as PublicClient;

function pidsOnPort(port: number): string[] {
  try {
    return execFileSync("lsof", ["-ti", `:${port}`], { encoding: "utf8" }).split("\n").map((pid) => pid.trim()).filter(Boolean);
  } catch {
    return []; // lsof exits 1 when nothing listens
  }
}

async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const response = await fetch(RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = (await response.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

export type Anvil = { stop(): Promise<void> };

/**
 * Starts Anvil on 8761 with 1-second blocks. `--slots-in-an-epoch 1` keeps the finalized block a
 * couple of blocks behind the head instead of 64, so finality-based rules can be tested quickly.
 * Refuses to start if anything already listens on the port, and stops only the PID it started.
 */
export async function startAnvil(): Promise<Anvil> {
  const busy = pidsOnPort(ANVIL_PORT);
  if (busy.length > 0) throw new Error(`port ${ANVIL_PORT} is already in use (PID ${busy.join(", ")}); not starting a test Anvil`);
  const child: ChildProcess = spawn(
    "anvil",
    ["--host", "127.0.0.1", "--port", String(ANVIL_PORT), "--chain-id", String(LOCAL_CHAIN_ID), "--block-time", "1", "--slots-in-an-epoch", "1", "--silent"],
    { stdio: "ignore" },
  );
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await exited;
    }
  };
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error("anvil exited during startup");
    try {
      const chainId = await rpc("eth_chainId");
      // Make sure the node answering is the one we started, not another process that took the port.
      if (Number(chainId) === LOCAL_CHAIN_ID && child.pid !== undefined && pidsOnPort(ANVIL_PORT).includes(String(child.pid))) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error("anvil did not start within 15 seconds");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { stop };
}

export async function setBalance(address: Address, wei: bigint): Promise<void> {
  await rpc("anvil_setBalance", [address, `0x${wei.toString(16)}`]);
}

/** Moves chain time forward and mines blocks so the new time reaches the finalized block. */
export async function advanceChainTime(seconds: number, blocks = 4): Promise<void> {
  await rpc("evm_increaseTime", [seconds]);
  await rpc("anvil_mine", [`0x${blocks.toString(16)}`]);
}

export async function funded(): Promise<{ key: Hex; account: PrivateKeyAccount }> {
  const key = generatePrivateKey();
  const account = privateKeyToAccount(key);
  await setBalance(account.address, parseEther("10"));
  return { key, account };
}

export type Token = { address: Address; mint(to: Address, amount: bigint): Promise<void>; balanceOf(owner: Address): Promise<bigint> };

export async function deployUsdc(): Promise<Token> {
  const { account } = await funded();
  const client = publicClient();
  const wallet = createWalletClient({ account, chain: localChain, transport: http(RPC_URL) });
  const hash = await wallet.deployContract({ abi: usdcAbi, bytecode: fixture.bytecode });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error("MockUSDC deployment has no contract address");
  const address = receipt.contractAddress;
  return {
    address,
    async mint(to, amount) {
      const mintHash = await wallet.writeContract({ address, abi: usdcAbi, functionName: "mint", args: [to, amount] });
      await client.waitForTransactionReceipt({ hash: mintHash });
    },
    async balanceOf(owner) {
      return (await client.readContract({ address, abi: usdcAbi, functionName: "balanceOf", args: [owner] })) as bigint;
    },
  };
}

/** An x402 facilitator that verifies and settles on the local chain, the way Floatlane's testing.ts builds one. */
export async function createLocalFacilitator(): Promise<FacilitatorClient & { address: Address }> {
  const { account } = await funded();
  const client = publicClient();
  const wallet = createWalletClient({ account, chain: localChain, transport: http(RPC_URL) });
  const signer = toFacilitatorEvmSigner({
    address: account.address,
    readContract: (args) => client.readContract(args as never),
    verifyTypedData: (args) => client.verifyTypedData(args as never),
    writeContract: (args) => wallet.writeContract({ ...(args as object), account, chain: localChain } as never),
    sendTransaction: (args) => wallet.sendTransaction({ ...args, account, chain: localChain }),
    waitForTransactionReceipt: (args) => client.waitForTransactionReceipt(args),
    getCode: (args) => client.getCode(args),
  });
  const facilitator = new x402Facilitator().register(LOCAL_NETWORK, new ExactEvmFacilitatorScheme(signer));
  return {
    address: account.address,
    verify: (payload, requirements) => facilitator.verify(payload, requirements),
    settle: (payload, requirements) => facilitator.settle(payload, requirements),
    getSupported: async () => facilitator.getSupported() as unknown as SupportedResponse,
  };
}

/** Wraps a facilitator and counts calls, so a test can prove none were made. */
export function countingFacilitator(inner: FacilitatorClient) {
  const calls = { verify: 0, settle: 0 };
  const client: FacilitatorClient = {
    verify: (payload, requirements) => {
      calls.verify++;
      return inner.verify(payload, requirements);
    },
    settle: (payload, requirements) => {
      calls.settle++;
      return inner.settle(payload, requirements);
    },
    getSupported: () => inner.getSupported(),
  };
  return { client, calls };
}

/** A standard x402 v2 client for the local token (not a default asset, so it is allowed explicitly). */
export function payerClient(account: PrivateKeyAccount, token: Address): x402Client {
  return new x402Client()
    .register(LOCAL_NETWORK, new ExactEvmClientScheme(account, { rpcUrl: RPC_URL }))
    .setSpendControls({ allowedAssets: [{ network: LOCAL_NETWORK, asset: token }] });
}

/**
 * Signs a payment for exactly these requirements with the standard client, as if they came from a 402.
 * Registered for every eip155 network with spend controls off, so tests can sign deliberately wrong requirements.
 */
export async function signPayment(account: PrivateKeyAccount, requirements: PaymentRequirements, resourceUrl = "http://127.0.0.1:8760/v1/invoices/test/pay"): Promise<PaymentPayload> {
  const required: PaymentRequired = { x402Version: 2, resource: { url: resourceUrl }, accepts: [requirements] };
  const client = new x402Client().register("eip155:*", new ExactEvmClientScheme(account, { rpcUrl: RPC_URL })).setSpendControls(false);
  return client.createPaymentPayload(required);
}
