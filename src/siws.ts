import { createHash, randomBytes } from "node:crypto";
import { getAddressDecoder } from "@solana/kit";
import { parseSignInMessage, verifySignIn } from "@solana/wallet-standard-util";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { z } from "zod";

/**
 * Sign In With Solana for better-auth, verified with @solana/wallet-standard-util
 * against the wallet's real `solana:signIn` output.
 *
 * The server builds and stores the sign-in input (domain, uri, nonce, times), so
 * nothing the browser sends back can change what was asked for. `verifySignIn`
 * checks the signature and that the signed message matches that input, but it
 * does not tie the message's address to the signing key when the input leaves
 * the address out, and it does not check expiry. Both are enforced here.
 */

type SolanaSignInInput = Parameters<typeof verifySignIn>[0];

const PREFIX = "siws:";
const LIFETIME_MS = 5 * 60 * 1000;
const bytes = z.string().min(1).max(4096).transform((value, ctx) => {
  const buffer = Buffer.from(value, "base64");
  if (buffer.length === 0) ctx.addIssue({ code: "custom", message: "expected base64" });
  return new Uint8Array(buffer);
});
const outputSchema = z.object({
  nonce: z.string().min(8).max(64),
  publicKey: bytes,
  signedMessage: bytes,
  signature: bytes,
});

export type SiwsOptions = { domain: string; uri: string; statement?: string };

const placeholderEmail = (address: string) =>
  `sol-${createHash("sha256").update(address).digest("hex").slice(0, 32)}@wallet.invalid`;

/** Verifies a sign-in output against the stored input. Returns the proven address or throws. */
export function verifySiwsOutput(input: SolanaSignInInput, output: z.infer<typeof outputSchema>, now = Date.now()): string {
  if (output.publicKey.length !== 32) throw APIError.fromStatus("UNAUTHORIZED", { message: "Invalid Solana public key" });
  const address = getAddressDecoder().decode(output.publicKey);
  const parsed = parseSignInMessage(output.signedMessage);
  if (!parsed || parsed.address !== address) throw APIError.fromStatus("UNAUTHORIZED", { message: "Signed message address does not match the signing key" });
  const ok = verifySignIn(input, {
    account: { address, publicKey: output.publicKey, chains: [], features: [] },
    signedMessage: output.signedMessage,
    signature: output.signature,
  });
  if (!ok) throw APIError.fromStatus("UNAUTHORIZED", { message: "Invalid Solana sign-in signature" });
  if (!input.expirationTime || now >= Date.parse(input.expirationTime)) throw APIError.fromStatus("UNAUTHORIZED", { message: "Sign-in request expired" });
  return address;
}

export const siws = (options: SiwsOptions) =>
  ({
    id: "siws",
    schema: {
      solanaWallet: {
        fields: {
          userId: { type: "string", references: { model: "user", field: "id" }, required: true, index: true },
          address: { type: "string", required: true, unique: true },
          createdAt: { type: "date", required: true },
        },
      },
    },
    endpoints: {
      /** Issues the sign-in input the wallet must sign. */
      siwsInput: createAuthEndpoint("/siws/input", { method: "POST", body: z.object({}).strict().optional() }, async (ctx) => {
        const now = Date.now();
        const input: SolanaSignInInput = {
          domain: options.domain,
          uri: options.uri,
          version: "1",
          nonce: randomBytes(16).toString("hex"),
          issuedAt: new Date(now).toISOString(),
          expirationTime: new Date(now + LIFETIME_MS).toISOString(),
          ...(options.statement ? { statement: options.statement } : {}),
        };
        await ctx.context.internalAdapter.createVerificationValue({
          identifier: `${PREFIX}${input.nonce}`,
          value: JSON.stringify(input),
          expiresAt: new Date(now + LIFETIME_MS),
        });
        return ctx.json({ input });
      }),

      /** Signs in (creating the user on first use) with a verified sign-in output. */
      siwsVerify: createAuthEndpoint("/siws/verify", { method: "POST", body: outputSchema, requireRequest: true }, async (ctx) => {
        const address = await consume(ctx, ctx.body);
        const existing = await ctx.context.adapter.findOne<{ userId: string }>({ model: "solanaWallet", where: [{ field: "address", value: address }] });
        let user = existing ? await ctx.context.internalAdapter.findUserById(existing.userId) : null;
        if (!user) {
          user = await ctx.context.internalAdapter.createUser({ name: `${address.slice(0, 4)}...${address.slice(-4)}`, email: placeholderEmail(address), emailVerified: false }, { method: "siws" });
          await ctx.context.adapter.create({ model: "solanaWallet", data: { userId: user.id, address, createdAt: new Date() } });
          await ctx.context.internalAdapter.createAccount({ userId: user.id, providerId: "siws", accountId: address });
        }
        const session = await ctx.context.internalAdapter.createSession(user.id);
        if (!session) throw APIError.fromStatus("INTERNAL_SERVER_ERROR");
        await setSessionCookie(ctx, { session, user });
        return ctx.json({ token: session.token, user: { id: user.id, address } });
      }),

      /** Links a Solana wallet to the signed-in user. A wallet belongs to exactly one user. */
      siwsLink: createAuthEndpoint("/siws/link", { method: "POST", body: outputSchema, use: [sessionMiddleware], requireRequest: true }, async (ctx) => {
        const address = await consume(ctx, ctx.body);
        const userId = ctx.context.session.user.id;
        const existing = await ctx.context.adapter.findOne<{ userId: string }>({ model: "solanaWallet", where: [{ field: "address", value: address }] });
        if (existing && existing.userId !== userId) throw APIError.fromStatus("CONFLICT", { message: "This wallet belongs to another account" });
        if (!existing) {
          await ctx.context.adapter.create({ model: "solanaWallet", data: { userId, address, createdAt: new Date() } });
          await ctx.context.internalAdapter.createAccount({ userId, providerId: "siws", accountId: address });
        }
        return ctx.json({ linked: true, address });
      }),
    },
  }) satisfies BetterAuthPlugin;

type EndpointContext = {
  context: {
    internalAdapter: {
      findVerificationValue(identifier: string): Promise<{ value: string } | null>;
      consumeVerificationValue(identifier: string): Promise<unknown>;
    };
  };
};

/** Consumes the stored input for this nonce exactly once and verifies the output against it. */
async function consume(ctx: EndpointContext, body: z.infer<typeof outputSchema>): Promise<string> {
  const identifier = `${PREFIX}${body.nonce}`;
  const stored = await ctx.context.internalAdapter.findVerificationValue(identifier);
  if (!stored || !(await ctx.context.internalAdapter.consumeVerificationValue(identifier)))
    throw APIError.fromStatus("UNAUTHORIZED", { message: "Invalid or expired sign-in request" });
  return verifySiwsOutput(JSON.parse(stored.value) as SolanaSignInInput, body);
}
