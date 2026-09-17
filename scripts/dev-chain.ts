/**
 * The service on a local chain, for trying payments end to end without testnet funds.
 *
 *   pnpm tsx scripts/dev-chain.ts
 *
 * Starts Anvil on 8761, deploys a test USDC, funds a demo wallet, runs an in-process
 * facilitator, and serves the service on PORT with that local chain as its only payment
 * network. Everything here is local and disposable: the token is fake, the keys are
 * Anvil's published defaults, and nothing touches a testnet or mainnet.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { x402Facilitator } from "@x402/core/facilitator";
import type { FacilitatorClient } from "@x402/core/server";
import type { SupportedResponse } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { createPublicClient, createWalletClient, defineChain, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createApp } from "../src/app.js";
import { createMigratedAuth, smtpMailer } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { createPool, migrate } from "../src/db.js";
import { createEvmRail } from "../src/charges/evm.js";
import { createPayments } from "../src/payments.js";

const PORT = 8761;
const RPC_URL = `http://127.0.0.1:${PORT}`;
const CHAIN_ID = 31337;
const NETWORK = `eip155:${CHAIN_ID}`;
// Anvil's published default accounts. Local only, and worthless.
const FACILITATOR_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const DEMO_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const TOKEN_DOMAIN = { name: "USDC", version: "2" } as const;

const chain = defineChain({ id: CHAIN_ID, name: "local", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } });
const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, "../test/fixtures/evm/MockUSDC.json"), "utf8")) as { abi: unknown[]; bytecode: Hex };

const anvil = spawn("anvil", ["--host", "127.0.0.1", "--port", String(PORT), "--chain-id", String(CHAIN_ID), "--block-time", "1", "--silent"], { stdio: "ignore" });
const stop = () => {
  if (anvil.exitCode === null) anvil.kill("SIGTERM");
};
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => (stop(), process.exit(0)));
process.on("exit", stop);

const publicClient = createPublicClient({ chain, transport: http(RPC_URL), pollingInterval: 200 });
const deadline = Date.now() + 15_000;
for (;;) {
  try {
    await publicClient.getChainId();
    break;
  } catch {
    if (Date.now() > deadline) throw new Error("anvil did not start");
    await new Promise((r) => setTimeout(r, 200));
  }
}

const facilitatorAccount = privateKeyToAccount(FACILITATOR_KEY);
const demo = privateKeyToAccount(DEMO_KEY);
const wallet = createWalletClient({ account: facilitatorAccount, chain, transport: http(RPC_URL) });
const hash = await wallet.deployContract({ abi: fixture.abi as never, bytecode: fixture.bytecode, args: [] });
const token = (await publicClient.waitForTransactionReceipt({ hash })).contractAddress as Address;
await publicClient.waitForTransactionReceipt({
  hash: await wallet.writeContract({ address: token, abi: fixture.abi as never, functionName: "mint", args: [demo.address, 1_000_000_000n] }),
});

const inProcess = new x402Facilitator();
inProcess.register(NETWORK, new ExactEvmScheme(toFacilitatorEvmSigner({
  address: facilitatorAccount.address,
  readContract: (args) => publicClient.readContract(args as never),
  verifyTypedData: (args) => publicClient.verifyTypedData(args as never),
  writeContract: (args) => wallet.writeContract({ ...(args as object), account: facilitatorAccount, chain } as never),
  sendTransaction: (args) => wallet.sendTransaction({ ...args, account: facilitatorAccount, chain }),
  waitForTransactionReceipt: (args) => publicClient.waitForTransactionReceipt(args),
  getCode: (args) => publicClient.getCode(args),
})));
const facilitator: FacilitatorClient = {
  verify: (payload, requirements) => inProcess.verify(payload, requirements),
  settle: (payload, requirements) => inProcess.settle(payload, requirements),
  getSupported: async () => inProcess.getSupported() as unknown as SupportedResponse,
};

const config = loadConfig();
const db = createPool(config.DATABASE_URL);
await migrate(db);
const auth = await createMigratedAuth({ db, config, mailer: smtpMailer(config), resources: (process.env.OAUTH_RESOURCES ?? "").split(",").map((v) => v.trim()).filter(Boolean) });
const payTo = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a").address;
const rail = createEvmRail({ network: NETWORK, wireNetwork: NETWORK, asset: token, payTo, rpcUrl: RPC_URL, extra: { ...TOKEN_DOMAIN } }, { confirmations: 2, client: publicClient });
const payments = await createPayments(db, config, {
  facilitator,
  rails: [{ rail, option: { network: NETWORK, chainFamily: "eip155", label: "Test USDC on the local chain", asset: token, payTo } }],
  reconcileEveryMs: 2000,
});
createApp({ db, auth, config, payments }).listen(config.PORT, config.HOST, () => {
  console.log(`Local-chain service on http://${config.HOST}:${config.PORT}`);
  console.log(`  chain ${NETWORK} at ${RPC_URL}, test USDC ${token}`);
  console.log(`  demo wallet ${demo.address} holds 1000 test USDC (Anvil key #1)`);
  console.log(`  payments land at ${payTo}. Set a price to make an action cost something:`);
  console.log(`    pnpm admin price set plotform.publish 250000 "Publish your site"`);
});
