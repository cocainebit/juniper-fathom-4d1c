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
import { createEvmRail } from "../src/charges/evm.js";
import { createServiceClient, setPrice, type ServiceClient } from "../src/catalog.js";
import { createPayments, type Payments } from "../src/payments.js";
import { LOCAL_NETWORK, RPC_URL, TOKEN_DOMAIN, createLocalFacilitator, deployUsdc, publicClient, startAnvil, type Anvil, type Token } from "./fixtures/evm/chain.js";
import { createTestDatabase } from "./helpers.js";

/**
 * The payment sheet end to end, in a real browser: a product raises a charge for one
 * action, a person opens the sheet and pays it with an Ethereum wallet, and the charge
 * becomes paid. There is no balance anywhere. The wallet is a
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
  await createServiceClient(db, "plotform", ["plotform"], SERVICE_TOKEN);
  await setPrice(db, "plotform.publish", 250_000, "Publish your site");
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

describe("the payment sheet", () => {
  it("pays a product's charge with an Ethereum wallet", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    await token.mint(payer.address, 50_000_000n);
    const { page, context, errors } = await walletPage(payer);
    const { charge, payUrl } = await raiseCharge("publish:project-1:3");
    expect(charge.amountMicro).toBe(250_000);

    await page.goto(payUrl);
    await page$(page.locator("#title")).toHaveText("Publish your site");
    await page$(page.locator("#amount")).toContainText("0.25");
    await page$(page.locator("#product")).toHaveText("Plotform");
    await page.click("#pay");
    await page$(page.locator("#done")).toHaveText("Paid. You can close this window and continue.", { timeout: 60_000 });
    await page.screenshot({ path: "/private/tmp/claude-501/-Users-achi/772ad7e0-bb04-4cdf-b09c-c5ba34dc6a58/scratchpad/shots/p-pay-sheet-paid.png", fullPage: true });

    // The product sees it paid, and the money moved exactly once.
    const seen = await productSees(charge.id);
    expect(seen).toMatchObject({ status: "paid", sku: "plotform.publish", subject: "publish:project-1:3" });
    expect(await token.balanceOf(payTo)).toBe(250_000n);
    expect(await token.balanceOf(payer.address)).toBe(49_750_000n);
    // The first POST to /pay answers 402 by design (the x402 challenge); Chrome logs it.
    expect(errors.filter((error) => !/status of 402/.test(error))).toEqual([]);
    await context.close();
  }, 120_000);

  it("pays nothing when the wallet declines, and the charge stays open", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    await token.mint(payer.address, 50_000_000n);
    const { page, context } = await walletPage(payer, { decline: true });
    const { charge, payUrl } = await raiseCharge("publish:project-2:1");
    const before = await token.balanceOf(payTo);

    await page.goto(payUrl);
    await page.click("#pay");
    await page$(page.locator("#error")).toHaveText("The wallet request was cancelled. Nothing was paid.", { timeout: 30_000 });
    await page$(page.locator("#pay")).toBeEnabled();
    expect((await productSees(charge.id)).status).toBe("open");
    expect(await token.balanceOf(payTo)).toBe(before);
    await context.close();
  }, 120_000);

  it("says so when the payment request does not exist", async () => {
    const { page, context } = await walletPage(privateKeyToAccount(generatePrivateKey()));
    await page.goto(`${base}/pay/chg_missing`);
    await page$(page.locator("#title")).toHaveText("Payment not found");
    await page$(page.locator("#actions")).toBeHidden();
    await context.close();
  }, 60_000);

  it("charges nothing for an action with no price", async () => {
    const response = await fetch(`${base}/internal/v1/charges`, {
      method: "POST",
      headers: { authorization: `Bearer ${SERVICE_TOKEN}`, "content-type": "application/json", "idempotency-key": "free:1" },
      body: JSON.stringify({ sku: "plotform.not-priced", subject: "free:1" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ free: true });
    expect((await db.query("select count(*)::int as n from charges where sku = $1", ["plotform.not-priced"])).rows[0].n).toBe(0);
  }, 60_000);
});

const SERVICE_TOKEN = "service-token-for-the-payment-sheet-test-0001";

/** Raises a charge the way Plotform's server does. */
async function raiseCharge(subject: string): Promise<{ charge: { id: string; amountMicro: number }; payUrl: string }> {
  const response = await fetch(`${base}/internal/v1/charges`, {
    method: "POST",
    headers: { authorization: `Bearer ${SERVICE_TOKEN}`, "content-type": "application/json", "idempotency-key": subject },
    body: JSON.stringify({ sku: "plotform.publish", subject, description: "Publish your site" }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { charge: { id: string; amountMicro: number }; payUrl: string };
  return body;
}

/** What the product sees when it re-checks before doing the work. */
async function productSees(id: string) {
  const response = await fetch(`${base}/internal/v1/charges/${id}`, { headers: { authorization: `Bearer ${SERVICE_TOKEN}` } });
  return ((await response.json()) as { charge: { status: string; sku: string; subject: string } }).charge;
}
