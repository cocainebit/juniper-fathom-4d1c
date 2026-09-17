import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import { getAddress, verifyMessage, type Hex } from "viem";
import { parseSiweMessage } from "viem/siwe";
import { z } from "zod";

/**
 * Links an Ethereum wallet to the signed-in user. The better-auth SIWE plugin
 * signs a wallet in (creating a user); it cannot attach a wallet to an account
 * that already exists, which is what an email user needs to make one account
 * across products. The nonce comes from the SIWE plugin's /siwe/nonce and is
 * consumed here, so a signature is usable exactly once.
 */

const bodySchema = z.object({ message: z.string().min(1).max(4000), signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/) });

export const siweLink = (options: { domain: string }) =>
  ({
    id: "siwe-link",
    endpoints: {
      siweLink: createAuthEndpoint("/siwe/link", { method: "POST", body: bodySchema, use: [sessionMiddleware], requireRequest: true }, async (ctx) => {
        const parsed = parseSiweMessage(ctx.body.message);
        const unauthorized = (message: string) => APIError.fromStatus("UNAUTHORIZED", { message });
        if (!parsed.address || !parsed.nonce || !parsed.chainId) throw unauthorized("Malformed sign-in message");
        if (parsed.domain !== options.domain) throw unauthorized("Sign-in message is for another domain");
        const now = Date.now();
        if (parsed.expirationTime && now >= parsed.expirationTime.getTime()) throw unauthorized("Sign-in message expired");
        if (parsed.notBefore && now < parsed.notBefore.getTime()) throw unauthorized("Sign-in message is not valid yet");
        // Nonces are issued by the SIWE plugin under this identifier.
        if (!(await ctx.context.internalAdapter.consumeVerificationValue(`siwe:${parsed.nonce}`))) throw unauthorized("Invalid or expired nonce");
        const address = getAddress(parsed.address);
        // EOA signatures only. Smart-contract wallets (ERC-1271) are not accepted yet.
        if (!(await verifyMessage({ address, message: ctx.body.message, signature: ctx.body.signature as Hex }))) throw unauthorized("Invalid signature");

        const userId = ctx.context.session.user.id;
        const owned = await ctx.context.adapter.findOne<{ userId: string }>({ model: "walletAddress", where: [{ field: "address", value: address }] });
        if (owned && owned.userId !== userId) throw APIError.fromStatus("CONFLICT", { message: "This wallet belongs to another account" });
        const sameChain = await ctx.context.adapter.findOne({ model: "walletAddress", where: [{ field: "address", value: address }, { field: "chainId", value: parsed.chainId }] });
        if (!sameChain) {
          await ctx.context.adapter.create({ model: "walletAddress", data: { userId, address, chainId: parsed.chainId, isPrimary: !owned, createdAt: new Date() } });
          await ctx.context.internalAdapter.createAccount({ userId, providerId: "siwe", accountId: `${address}:${parsed.chainId}` });
        }
        return ctx.json({ linked: true, address, chainId: parsed.chainId });
      }),
    },
  }) satisfies BetterAuthPlugin;
