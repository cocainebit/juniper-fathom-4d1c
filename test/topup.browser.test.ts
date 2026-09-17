import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, expect as page$, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { getAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createMigratedAuth } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import type { Db } from "../src/db.js";
import { createEvmRail } from "../src/invoices/evm.js";
import { balance } from "../src/ledger.js";
import { createPayments, type Payments } from "../src/payments.js";
import { LOCAL_NETWORK, RPC_URL, TOKEN_DOMAIN, createLocalFacilitator, deployUsdc, publicClient, startAnvil, type Anvil, type Token } from "./fixtures/evm/chain.js";
import { createTestDatabase } from "./helpers.js";

/**
 * The human top-up path end to end, in a real browser: sign in with an Ethereum
 * wallet, add credits on the account page, and see the balance. The wallet is a
 * test double that signs with a local key; the chain is a local Anvil with a test
 * USDC, settled by an in-process facilitator.
 */

let anvil: Anvil | undefined;
let db: Db;
let drop: (() => Promise<void>) | undefined;
let server: Server | undefined;
let payments: Payments | null = null;
let browser: Browser | undefined;
let base: string;
let token: Token;
let payTo: `0x${string}`;

async function freePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/** A browser page whose window.ethereum is backed by `account`. `decline` makes the wallet refuse payment signatures. */
async function walletPage(account: PrivateKeyAccount, options: { decline?: boolean } = {}): Promise<{ page: Page; context: BrowserContext; errors: string[] }> {
  const context = await browser!.newContext({ viewport: { width: 1280, height: 900 } });
  const errors: string[] = [];
  await context.exposeBinding("__wallet", async (_source, method: string, params: unknown[]) => {
    switch (method) {
      case "eth_requestAccounts":
      case "eth_accounts":
        return [account.address.toLowerCase()];
      case "eth_chainId":
        return "0x7a69";
      case "wallet_switchEthereumChain":
        return null;
      case "personal_sign":
        return account.signMessage({ message: { raw: params[0] as Hex } });
      case "eth_signTypedData_v4": {
        if (options.decline) throw Object.assign(new Error("User rejected the request."), { code: 4001 });
        const data = JSON.parse(params[1] as string);
        const { EIP712Domain: _domain, ...types } = data.types;
        const message = { ...data.message, value: BigInt(data.message.value), validAfter: BigInt(data.message.validAfter), validBefore: BigInt(data.message.validBefore) };
        return account.signTypedData({ domain: data.domain, types, primaryType: data.primaryType, message });
      }
      default:
        throw new Error(`test wallet does not support ${method}`);
    }
  });
  await context.addInitScript(() => {
    const call = (window as unknown as { __wallet: (method: string, params: unknown[]) => Promise<unknown> }).__wallet;
    (window as unknown as { ethereum: unknown }).ethereum = {
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        try {
          return await call(method, params ?? []);
        } catch (error) {
          // Playwright rethrows binding errors as plain Errors; restore the EIP-1193 rejection code.
          throw /rejected/i.test(String(error)) ? Object.assign(new Error("User rejected the request."), { code: 4001 }) : error;
        }
      },
    };
  });
  const page = await context.newPage();
  page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
  page.on("pageerror", (error) => errors.push(error.message));
  return { page, context, errors };
}

async function signInWithWallet(page: Page) {
  await page.goto(`${base}/sign-in`);
  await page.getByRole("button", { name: /Continue with Ethereum wallet/ }).click();
  await page.waitForURL(`${base}/account`);
  await expect.poll(() => page.locator("#page").getAttribute("aria-busy")).toBe("false");
}

beforeAll(async () => {
  anvil = await startAnvil();
  let url: string;
  ({ db, drop, url } = await createTestDatabase());
  token = await deployUsdc();
  payTo = privateKeyToAccount(generatePrivateKey()).address;
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const config = loadConfig({ ...process.env, NODE_ENV: "test", DATABASE_URL: url, PUBLIC_URL: base, TRUSTED_ORIGINS: "" });
  const auth = await createMigratedAuth({ db, config, mailer: { send: async () => {} } });
  const rail = createEvmRail(
    { network: LOCAL_NETWORK, wireNetwork: LOCAL_NETWORK, asset: token.address, payTo, rpcUrl: RPC_URL, extra: { ...TOKEN_DOMAIN } },
    { confirmations: 2, client: publicClient() },
  );
  payments = await createPayments(db, config, {
    facilitator: await createLocalFacilitator(),
    rails: [{ rail, option: { network: LOCAL_NETWORK, chainFamily: "eip155", label: "USDC on the local test chain", asset: token.address, payTo } }],
    reconcileEveryMs: 1000,
  });
  const app = createApp({ db, auth, config, payments });
  await new Promise<void>((resolve) => {
    server = app.listen(port, "127.0.0.1", () => resolve());
  });
  browser = await chromium.launch();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  payments?.stop();
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
  await drop?.();
  await anvil?.stop();
});

describe("adding credits from the account page", () => {
  it("pays an invoice with an Ethereum wallet and shows the new balance", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    await token.mint(payer.address, 50_000_000n);
    const { page, context, errors } = await walletPage(payer);
    await signInWithWallet(page);
    await expect.poll(() => page.locator("#topup-network option").count()).toBe(1);

    await page.fill("#topup-amount", "5");
    await page.click("#topup-pay");
    await page$(page.locator("#topup-status")).toHaveText("Added 5.00 USDC.", { timeout: 60_000 });
    await page$(page.locator("#balance")).toContainText("5.00");
    await page$(page.locator("#activity")).toContainText("+5.00");
    await page.screenshot({ path: "/private/tmp/claude-501/-Users-achi/772ad7e0-bb04-4cdf-b09c-c5ba34dc6a58/scratchpad/shots/p-topup-paid.png", fullPage: true });

    const me = (await (await page.request.get(`${base}/v1/me`)).json()) as { organizations: { id: string }[]; wallets: { address: string }[] };
    expect(me.wallets[0]!.address).toBe(getAddress(payer.address));
    expect(await balance(db, me.organizations[0]!.id)).toBe(5_000_000);
    expect(await token.balanceOf(payTo)).toBe(5_000_000n);
    expect(await token.balanceOf(payer.address)).toBe(45_000_000n);
    // The first POST to /pay is answered with 402 by design (that is the x402 challenge); Chrome logs it. Nothing else may error.
    expect(errors.filter((error) => !/status of 402/.test(error))).toEqual([]);
    await context.close();
  }, 120_000);

  it("adds nothing when the wallet declines, and says so", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    await token.mint(payer.address, 50_000_000n);
    const { page, context } = await walletPage(payer, { decline: true });
    await signInWithWallet(page);
    await expect.poll(() => page.locator("#topup-network option").count()).toBe(1);
    const before = await token.balanceOf(payTo);

    await page.fill("#topup-amount", "3");
    await page.click("#topup-pay");
    await page$(page.locator("#topup-status")).toHaveText("The wallet request was cancelled. Nothing was paid.", { timeout: 30_000 });
    await page$(page.locator("#topup-pay")).toBeEnabled();
    const me = (await (await page.request.get(`${base}/v1/me`)).json()) as { organizations: { id: string }[] };
    expect(await balance(db, me.organizations[0]!.id)).toBe(0);
    expect(await token.balanceOf(payTo)).toBe(before);
    await context.close();
  }, 120_000);

  it("rejects amounts outside 1 to 1,000 USDC before creating an invoice", async () => {
    const { page, context } = await walletPage(privateKeyToAccount(generatePrivateKey()));
    await signInWithWallet(page);
    const count = async () => (await db.query("select count(*)::int as n from invoices")).rows[0].n as number;
    const before = await count();
    await page.fill("#topup-amount", "0");
    await page.click("#topup-pay");
    await page$(page.locator("#topup-status")).toHaveText("Enter a whole number of USDC between 1 and 1,000.");
    await page.fill("#topup-amount", "1001");
    await page.click("#topup-pay");
    await page$(page.locator("#topup-status")).toHaveText("Enter a whole number of USDC between 1 and 1,000.");
    expect(await count()).toBe(before);
    await context.close();
  }, 60_000);
});
