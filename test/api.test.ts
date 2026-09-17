import { createHash, generateKeyPairSync, randomBytes, sign as edSign } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createSignInMessage } from "@solana/wallet-standard-util";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createMigratedAuth, type Auth } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import type { Db } from "../src/db.js";
import { createServiceClient, grant, setPrice } from "../src/ledger.js";
import { registerTrustedClient } from "../src/operator.js";
import { createTestDatabase, token } from "./helpers.js";

let db: Db;
let drop: () => Promise<void>;
let server: Server;
let base: string;
let auth: Auth;
const mail: { to: string; text: string }[] = [];
const RESOURCE = "http://127.0.0.1:8000";

/** A tiny browser: remembers cookies per origin and never follows redirects. */
function browser() {
  const jar = new Map<string, string>();
  return async (path: string, init: RequestInit & { json?: unknown } = {}) => {
    const headers = new Headers(init.headers);
    if (jar.size) headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
    if (init.json !== undefined) {
      headers.set("content-type", "application/json");
      init.body = JSON.stringify(init.json);
    }
    headers.set("origin", base);
    const response = await fetch(path.startsWith("http") ? path : base + path, { ...init, headers, redirect: "manual" });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(";");
      const index = pair!.indexOf("=");
      const name = pair!.slice(0, index);
      const value = pair!.slice(index + 1);
      if (/max-age=0/i.test(cookie) || value === "") jar.delete(name);
      else jar.set(name, value);
    }
    return response;
  };
}

async function freePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

beforeAll(async () => {
  let url: string;
  ({ db, drop, url } = await createTestDatabase());
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const config = loadConfig({ ...process.env, NODE_ENV: "test", DATABASE_URL: url, PUBLIC_URL: base, TRUSTED_ORIGINS: "" });
  auth = await createMigratedAuth({ db, config, mailer: { send: async (to, _subject, text) => void mail.push({ to, text }) }, resources: [RESOURCE] });
  const app = createApp({ db, auth, config });
  await new Promise<void>((resolve) => {
    server = app.listen(port, "127.0.0.1", () => resolve());
  });
});
afterAll(async () => {
  await new Promise((resolve) => server?.close(resolve));
  await drop();
});

async function signInWithEmail(email: string) {
  const b = browser();
  expect((await b("/api/auth/email-otp/send-verification-otp", { method: "POST", json: { email, type: "sign-in" } })).status).toBe(200);
  const code = /code is (\d{6})/.exec(mail.filter((m) => m.to === email).at(-1)!.text)![1];
  const response = await b("/api/auth/sign-in/email-otp", { method: "POST", json: { email, otp: code } });
  expect(response.status).toBe(200);
  return b;
}

async function siweProof(b: ReturnType<typeof browser>, privateKey: `0x${string}`, chainId = 8453) {
  const account = privateKeyToAccount(privateKey);
  const { nonce } = (await (await b("/api/auth/siwe/nonce", { method: "POST", json: {} })).json()) as { nonce: string };
  const message = createSiweMessage({
    address: account.address,
    chainId,
    domain: new URL(base).host,
    nonce,
    uri: base,
    version: "1",
    issuedAt: new Date(),
    expirationTime: new Date(Date.now() + 300_000),
  });
  return { account, message, signature: await account.signMessage({ message }) };
}

function solanaKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return { raw: new Uint8Array(raw), privateKey };
}

const base58 = async (bytes: Uint8Array) => (await import("@solana/kit")).getAddressDecoder().decode(bytes);

async function siwsProof(b: ReturnType<typeof browser>, key = solanaKey(), overrideAddress?: string) {
  const { input } = (await (await b("/api/auth/siws/input", { method: "POST", json: {} })).json()) as { input: Parameters<typeof createSignInMessage>[0] & { nonce: string } };
  const address = overrideAddress ?? (await base58(key.raw));
  const signedMessage = createSignInMessage({ ...input, address });
  const signature = edSign(null, signedMessage, key.privateKey);
  return {
    key,
    address: await base58(key.raw),
    body: { nonce: input.nonce, publicKey: Buffer.from(key.raw).toString("base64"), signedMessage: Buffer.from(signedMessage).toString("base64"), signature: signature.toString("base64") },
  };
}

/** better-auth answers a browser navigation with a 302 and a fetch() call (which Node's fetch always is) with { redirect, url }. */
async function redirectTarget(response: Response): Promise<URL> {
  if (response.status === 302) return new URL(response.headers.get("location")!, base);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { redirect?: boolean; url?: string };
  expect(body.url).toBeTruthy();
  return new URL(body.url!, base);
}

type Me = { user: { id: string; email: string | null }; wallets: { chainFamily: string; address: string; chainId?: number }[]; organizations: { id: string; role: string }[] };
const me = async (b: ReturnType<typeof browser>) => (await (await b("/v1/me")).json()) as Me;

describe("sign-in", () => {
  it("signs in with an emailed code and gets a personal organization with an empty balance", async () => {
    const b = await signInWithEmail("ada@example.test");
    const profile = await me(b);
    expect(profile.user.email).toBe("ada@example.test");
    expect(profile.organizations).toHaveLength(1);
    expect(profile.organizations[0]!.role).toBe("owner");
    const credits = (await (await b(`/v1/orgs/${profile.organizations[0]!.id}/credits`)).json()) as { balanceMicro: number };
    expect(credits.balanceMicro).toBe(0);
  });

  it("signs in with an Ethereum wallet, and the same wallet returns to the same account", async () => {
    const privateKey = generatePrivateKey();
    const first = browser();
    const proof = await siweProof(first, privateKey);
    expect((await first("/api/auth/siwe/verify", { method: "POST", json: { message: proof.message, signature: proof.signature } })).status).toBe(200);
    const profile = await me(first);
    expect(profile.user.email).toBeNull();
    expect(profile.wallets).toEqual([expect.objectContaining({ chainFamily: "eip155", address: proof.account.address, chainId: 8453 })]);
    const second = browser();
    const again = await siweProof(second, privateKey);
    await second("/api/auth/siwe/verify", { method: "POST", json: { message: again.message, signature: again.signature } });
    expect((await me(second)).user.id).toBe(profile.user.id);
  });

  it("accepts the lowercase addresses that injected wallets report, and stores the checksummed form", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const b = browser();
    const { nonce } = (await (await b("/api/auth/siwe/nonce", { method: "POST", json: {} })).json()) as { nonce: string };
    // Built by hand the way the sign-in page does, with the address as the wallet returned it.
    const message = [
      `${new URL(base).host} wants you to sign in with your Ethereum account:`,
      account.address.toLowerCase(),
      "",
      "Sign in to your account.",
      "",
      `URI: ${base}`,
      "Version: 1",
      "Chain ID: 1",
      `Nonce: ${nonce}`,
      `Issued At: ${new Date().toISOString()}`,
      `Expiration Time: ${new Date(Date.now() + 300_000).toISOString()}`,
    ].join("\n");
    const response = await b("/api/auth/siwe/verify", { method: "POST", json: { message, signature: await account.signMessage({ message }) } });
    expect(response.status).toBe(200);
    expect((await me(b)).wallets[0]!.address).toBe(account.address);
  });

  it("signs in with a Solana wallet and rejects replays, expired inputs, and forged addresses", async () => {
    const b = browser();
    const proof = await siwsProof(b);
    expect((await b("/api/auth/siws/verify", { method: "POST", json: proof.body })).status).toBe(200);
    expect((await me(b)).wallets).toEqual([{ chainFamily: "solana", address: proof.address }]);
    // The same signed output cannot be used twice.
    expect((await browser()("/api/auth/siws/verify", { method: "POST", json: proof.body })).status).toBe(401);
    // A key cannot sign a message that claims someone else's address.
    const victim = await base58(solanaKey().raw);
    const attacker = browser();
    const forged = await siwsProof(attacker, solanaKey(), victim);
    expect((await attacker("/api/auth/siws/verify", { method: "POST", json: forged.body })).status).toBe(401);
    expect((await attacker("/v1/me")).status).toBe(401);
  });

  it("rejects a Solana signature over a message the server did not issue", async () => {
    const b = browser();
    const proof = await siwsProof(b);
    const key = proof.key;
    const tampered = createSignInMessage({ domain: "evil.example", address: proof.address, nonce: proof.body.nonce, version: "1" });
    const body = { ...proof.body, signedMessage: Buffer.from(tampered).toString("base64"), signature: edSign(null, tampered, key.privateKey).toString("base64") };
    expect((await b("/api/auth/siws/verify", { method: "POST", json: body })).status).toBe(401);
  });
});

describe("one account across wallets", () => {
  it("links Ethereum and Solana wallets to an email account, and a wallet cannot belong to two accounts", async () => {
    const ada = await signInWithEmail("ada.links@example.test");
    const evmKey = generatePrivateKey();
    const evm = await siweProof(ada, evmKey);
    expect((await ada("/api/auth/siwe/link", { method: "POST", json: { message: evm.message, signature: evm.signature } })).status).toBe(200);
    const sol = await siwsProof(ada);
    expect((await ada("/api/auth/siws/link", { method: "POST", json: sol.body })).status).toBe(200);
    const profile = await me(ada);
    expect(profile.wallets.map((w) => w.chainFamily).sort()).toEqual(["eip155", "solana"]);

    // Signing in with a linked wallet lands in the same account.
    const walletBrowser = browser();
    const signIn = await siwsProof(walletBrowser, sol.key);
    await walletBrowser("/api/auth/siws/verify", { method: "POST", json: signIn.body });
    expect((await me(walletBrowser)).user.id).toBe(profile.user.id);

    // Someone else cannot link the same wallets.
    const bob = await signInWithEmail("bob.links@example.test");
    const stolenEvm = await siweProof(bob, evmKey);
    expect((await bob("/api/auth/siwe/link", { method: "POST", json: { message: stolenEvm.message, signature: stolenEvm.signature } })).status).toBe(409);
    const stolenSol = await siwsProof(bob, sol.key);
    expect((await bob("/api/auth/siws/link", { method: "POST", json: stolenSol.body })).status).toBe(409);
    expect((await me(bob)).wallets).toEqual([]);
  });

  it("hides one organization's credits from other users", async () => {
    const ada = await signInWithEmail("ada.private@example.test");
    const org = (await me(ada)).organizations[0]!.id;
    const eve = await signInWithEmail("eve.private@example.test");
    expect((await eve(`/v1/orgs/${org}/credits`)).status).toBe(404);
    expect((await browser()(`/v1/orgs/${org}/credits`)).status).toBe(401);
  });
});

describe("internal API", () => {
  it("requires a service token and debits by SKU with the documented status codes", async () => {
    const secret = token();
    await createServiceClient(db, "cubicle", ["cubicle"], secret);
    await setPrice(db, "cubicle.minute.cpu2-mem4", 3334);
    const ada = await signInWithEmail("ada.usage@example.test");
    const profile = await me(ada);
    const org = profile.organizations[0]!.id;
    await grant(db, { organizationId: org, amountMicro: 5000, idempotencyKey: `seed:${org}`, reason: "test" });

    const call = (path: string, init: RequestInit = {}, auth = `Bearer ${secret}`) =>
      fetch(base + path, { ...init, headers: { authorization: auth, "content-type": "application/json", ...(init.headers as Record<string, string>) } });
    expect((await call("/internal/v1/prices", {}, "Bearer nope")).status).toBe(401);
    expect(((await (await call("/internal/v1/prices")).json()) as { prices: { sku: string }[] }).prices.map((p) => p.sku)).toEqual(["cubicle.minute.cpu2-mem4"]);

    const usage = (key: string, body: object) => call("/internal/v1/usage", { method: "POST", headers: { "idempotency-key": key }, body: JSON.stringify(body) });
    const item = { organizationId: org, sku: "cubicle.minute.cpu2-mem4", units: 1 };
    const applied = await usage("usage:c1:0", item);
    expect(applied.status).toBe(200);
    expect(await applied.json()).toMatchObject({ status: "applied", balanceAfterMicro: 1666 });
    expect((await usage("usage:c1:0", item)).status).toBe(200);
    expect((await usage("usage:c1:0", { ...item, units: 2 })).status).toBe(409);
    expect((await usage("usage:c1:1", item)).status).toBe(402);
    expect((await usage("usage:c1:2", { ...item, sku: "plotform.generate.site" })).status).toBe(422);
    expect((await call("/internal/v1/usage", { method: "POST", body: JSON.stringify(item) })).status).toBe(400);

    const batch = await call("/internal/v1/usage/batch", { method: "POST", body: JSON.stringify({ items: [{ idempotencyKey: "usage:c1:0", ...item }, { idempotencyKey: "usage:c1:3", ...item }] }) });
    expect(((await batch.json()) as { outcomes: { status: string }[] }).outcomes.map((o) => o.status)).toEqual(["replayed", "insufficient_funds"]);

    const balanceResponse = (await (await call(`/internal/v1/orgs/${org}/balance`)).json()) as { balanceMicro: number };
    expect(balanceResponse.balanceMicro).toBe(1666);
    const user = (await (await call(`/internal/v1/users/${profile.user.id}`)).json()) as Me;
    expect(user.organizations.map((o) => o.id)).toEqual([org]);
  });
});

describe("OpenID Connect", () => {
  it("runs the authorization code flow for a trusted product and issues a JWKS-verifiable access token for its API", async () => {
    const redirect = "http://127.0.0.1:5173/api/auth/oauth2/callback/platform";
    // Signed-in users cannot register OAuth clients; only the operator can.
    const ada = await signInWithEmail("ada.clients@example.test");
    expect((await ada("/api/auth/oauth2/create-client", { method: "POST", json: { redirect_uris: ["https://evil.example/cb"] } })).status).toBe(401);
    const client = await registerTrustedClient(auth, { name: "Plotform", redirectUris: [redirect], resource: RESOURCE });

    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const query = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirect,
      scope: "openid profile email",
      state: "state-1",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: RESOURCE,
    });

    // Not signed in: the provider sends the browser to the sign-in page with a signed query.
    const b = browser();
    const loginUrl = await redirectTarget(await b(`/api/auth/oauth2/authorize?${query}`, { headers: { accept: "text/html" } }));
    expect(loginUrl.pathname).toBe("/sign-in");

    // The sign-in page signs in with the signed query attached, and gets sent on to the product.
    const email = "ada.oidc@example.test";
    await b("/api/auth/email-otp/send-verification-otp", { method: "POST", json: { email, type: "sign-in" } });
    const code = /code is (\d{6})/.exec(mail.filter((m) => m.to === email).at(-1)!.text)![1];
    const signedIn = await b("/api/auth/sign-in/email-otp", { method: "POST", json: { email, otp: code, oauth_query: loginUrl.search.slice(1) } });
    expect(signedIn.status).toBe(200);
    const back = await redirectTarget(signedIn);
    expect(`${back.origin}${back.pathname}`).toBe(redirect);
    expect(back.searchParams.get("state")).toBe("state-1");
    const authCode = back.searchParams.get("code")!;
    expect(authCode).toBeTruthy();

    const tokenResponse = await fetch(`${base}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: authCode,
        redirect_uri: redirect,
        client_id: client.client_id,
        client_secret: client.client_secret,
        code_verifier: verifier,
        resource: RESOURCE,
      }),
    });
    expect(tokenResponse.status).toBe(200);
    const tokens = (await tokenResponse.json()) as { access_token: string; id_token: string };
    expect(tokens.id_token).toBeTruthy();

    // A product API (Cubicle) verifies the access token with the published keys only.
    const { verifyAccessTokenRequest, requestToResourceInput } = await import("better-auth/oauth2");
    const payload = (await verifyAccessTokenRequest(
      requestToResourceInput(new Request(RESOURCE + "/v1/workspaces", { headers: { authorization: `Bearer ${tokens.access_token}` } })),
      { verifyOptions: { issuer: `${base}/api/auth`, audience: RESOURCE }, jwksUrl: `${base}/api/auth/jwks` },
    )) as { sub: string; aud: string | string[] };
    const profile = await me(b);
    expect(payload.sub).toBe(profile.user.id);
    expect([payload.aud].flat()).toContain(RESOURCE);

    // The sign-in page can also finish any sign-in method (here a Solana wallet) and
    // re-enter the original authorize URL, which then issues a code directly.
    const wallet = browser();
    const proof = await siwsProof(wallet);
    expect((await wallet("/api/auth/siws/verify", { method: "POST", json: proof.body })).status).toBe(200);
    const again = await redirectTarget(await wallet(`/api/auth/oauth2/authorize?${query}`, { headers: { accept: "text/html" } }));
    expect(`${again.origin}${again.pathname}`).toBe(redirect);
    expect(again.searchParams.get("code")).toBeTruthy();

    const discovery = (await (await fetch(`${base}/api/auth/.well-known/openid-configuration`)).json()) as { issuer: string; jwks_uri: string };
    expect(discovery.issuer).toBe(`${base}/api/auth`);
  });
});
