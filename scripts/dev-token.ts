/**
 * Mints a real access token for a throwaway account, so a product can verify its own
 * token checking against this service without a browser.
 *
 *   pnpm tsx scripts/dev-token.ts --resource http://127.0.0.1:8000
 *   pnpm tsx scripts/dev-token.ts --resource http://127.0.0.1:8000 --wallet
 *
 * Local development only. It creates a throwaway user in this machine's database, runs
 * the ordinary authorization code flow with PKCE against the running service, and prints
 * the token with the account it belongs to. Nothing here bypasses the provider: the token
 * is issued the same way a product's own sign-in issues one, so whatever verifies it is
 * verifying the real thing. It never touches an account that already exists.
 */
import { createHash, randomBytes } from "node:crypto";
import { getAddress } from "viem";
import { loadConfig } from "../src/config.js";
import { createMigratedAuth } from "../src/auth.js";
import { createPool, migrate } from "../src/db.js";
import { registerTrustedClient } from "../src/operator.js";

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
};
const wallet = argv.includes("--wallet");
const resource = flag("resource");
if (!resource) {
  console.error("Usage: pnpm tsx scripts/dev-token.ts --resource <product API url> [--wallet]");
  process.exit(2);
}

const config = loadConfig();
if (config.NODE_ENV === "production") throw new Error("dev-token is for local development only");
const base = config.PUBLIC_URL.replace(/\/+$/, "");
const db = createPool(config.DATABASE_URL);
await migrate(db);
const auth = await createMigratedAuth({ db, config, mailer: { send: async () => {} }, resources: [resource] });

try {
  const context = await auth.$context;
  const tag = randomBytes(4).toString("hex");
  // A wallet account carries a placeholder address, which is exactly the shape a product
  // has to cope with: it can never link such an account by email.
  const email = wallet ? `siwe-${tag}@wallet.invalid` : `dev-${tag}@example.test`;
  const user = await context.internalAdapter.createUser(
    { name: wallet ? "Dev wallet account" : "Dev account", email, emailVerified: !wallet },
    { method: "dev-token" } as never,
  );
  // Real sign-ins store the checksummed form, so a product testing against this sees the same shape.
  const address = getAddress(`0x${randomBytes(20).toString("hex")}`);
  if (wallet) {
    await db.query(`insert into "walletAddress" (id, "userId", address, "chainId", "isPrimary", "createdAt") values ($1, $2, $3, $4, true, now())`, [
      `wal_${randomBytes(12).toString("hex")}`,
      user.id,
      address,
      8453,
    ]);
  }

  // A throwaway client for this token only, so no product's registration is touched.
  const redirect = "http://127.0.0.1:1/dev-token";
  const client = await registerTrustedClient(auth, { name: `Dev token ${tag}`, redirectUris: [redirect], resource });

  const verifier = randomBytes(32).toString("base64url");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: redirect,
    scope: "openid profile email",
    state: tag,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    resource,
  });

  // The code stays bound to the session that authorized it, so the session outlives the
  // exchange and is deleted at the end.
  const session = await context.internalAdapter.createSession(user.id);
  const authorized = await fetch(`${base}/api/auth/oauth2/authorize?${query}`, {
    headers: { authorization: `Bearer ${session.token}`, accept: "application/json" },
    redirect: "manual",
  });
  const location =
    authorized.status === 302 ? authorized.headers.get("location") : ((await authorized.json()) as { url?: string }).url;
  if (!location) throw new Error(`the provider did not return a redirect (status ${authorized.status})`);
  const code = new URL(location, base).searchParams.get("code");
  if (!code) throw new Error(`no authorization code in ${location}`);

  const tokenResponse = await fetch(`${base}/api/auth/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirect,
      client_id: client.client_id,
      client_secret: client.client_secret,
      code_verifier: verifier,
    }),
  });
  const token = (await tokenResponse.json()) as { access_token?: string; expires_in?: number; token_type?: string; error?: string };
  await context.internalAdapter.deleteSession(session.token);
  if (!token.access_token) throw new Error(`token endpoint said ${JSON.stringify(token)}`);

  console.log(`sub           ${user.id}`);
  console.log(`email         ${wallet ? "(none: placeholder address, reads as null over the API)" : email}`);
  if (wallet) console.log(`eip155        ${address} (chain 8453)`);
  console.log(`audience      ${resource}`);
  console.log(`issuer        ${base}/api/auth`);
  console.log(`expires in    ${token.expires_in ?? "unknown"} seconds`);
  console.log(`access_token  ${token.access_token}`);
} finally {
  await db.end();
}
