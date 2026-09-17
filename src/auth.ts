import { oauthProvider } from "@better-auth/oauth-provider";
import { getMigrations } from "better-auth/db/migration";
import { betterAuth } from "better-auth";
import { randomBytes } from "node:crypto";
import { bearer, emailOTP, jwt, organization, siwe } from "better-auth/plugins";
import nodemailer from "nodemailer";
import { verifyMessage, type Hex } from "viem";
import { generateSiweNonce } from "viem/siwe";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { ensureAccount } from "./ledger.js";
import { siweLink } from "./siwe-link.js";
import { siws } from "./siws.js";

export type Mailer = { send(to: string, subject: string, text: string): Promise<void> };

export function smtpMailer(config: Config): Mailer {
  const transport = nodemailer.createTransport({ host: config.SMTP_HOST, port: config.SMTP_PORT, secure: false });
  return {
    send: async (to, subject, text) => {
      await transport.sendMail({ from: config.MAIL_FROM, to, subject, text });
    },
  };
}

export type AuthOptions = {
  db: Db;
  config: Config;
  mailer: Mailer;
  /** Protected resources (product API URLs) access tokens can be issued for. They become the JWT `aud`. */
  resources?: string[];
};

export const OPERATOR_HEADER = "x-platform-operator";

export function createAuth({ db, config, mailer, resources = [] }: AuthOptions) {
  const publicUrl = new URL(config.PUBLIC_URL);
  // OAuth clients and resources are managed only by the operator CLI in this
  // process. The secret never leaves memory, so no HTTP request can present it,
  // and signed-in users cannot register clients of their own.
  const operatorSecret = randomBytes(32).toString("base64url");
  const isOperator = ({ headers }: { headers?: Headers }) => headers?.get(OPERATOR_HEADER) === operatorSecret;
  const auth = betterAuth({
    appName: "Platform",
    database: db,
    secret: config.AUTH_SECRET,
    baseURL: config.PUBLIC_URL,
    basePath: "/api/auth",
    trustedOrigins: [config.PUBLIC_URL, ...config.TRUSTED_ORIGINS],
    // Cookies ignore ports, so every product on 127.0.0.1 shares a cookie jar. A
    // distinct prefix keeps this service's session from colliding with theirs.
    advanced: { cookiePrefix: "platform", useSecureCookies: publicUrl.protocol === "https:" },
    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
    emailAndPassword: { enabled: false },
    rateLimit: { enabled: config.NODE_ENV !== "test", window: 60, max: 60, storage: "database" },
    databaseHooks: {
      user: {
        create: {
          // Every user owns a personal organization, which is what holds their credits.
          after: async (user) => {
            const organization = await auth.api.createOrganization({
              body: { name: "Personal", slug: `personal-${user.id.toLowerCase().replace(/[^a-z0-9]/g, "")}`, userId: user.id },
            });
            if (organization) await ensureAccount(db, organization.id);
          },
        },
      },
    },
    plugins: [
      emailOTP({
        otpLength: 6,
        expiresIn: 300,
        allowedAttempts: 5,
        sendVerificationOTP: async ({ email, otp }) => {
          await mailer.send(email, "Your sign-in code", `Your sign-in code is ${otp}. It expires in 5 minutes.\n\nIf you did not ask for it, ignore this email.`);
        },
      }),
      siwe({
        domain: publicUrl.host,
        anonymous: true,
        getNonce: async () => generateSiweNonce(),
        // EOA signatures only. Smart-contract wallets (ERC-1271) are not accepted yet.
        verifyMessage: async ({ message, signature, address }) => verifyMessage({ address: address as Hex, message, signature: signature as Hex }),
      }),
      siweLink({ domain: publicUrl.host }),
      siws({ domain: publicUrl.host, uri: config.PUBLIC_URL, statement: "Sign in to your account." }),
      organization({ creatorRole: "owner", allowUserToCreateOrganization: true }),
      bearer(),
      jwt(),
      oauthProvider({
        loginPage: "/sign-in",
        consentPage: "/consent",
        scopes: ["openid", "profile", "email", "offline_access"],
        resources,
        allowDynamicClientRegistration: false,
        clientPrivileges: async (context) => isOperator(context),
        resourcePrivileges: async (context) => isOperator(context),
      }),
    ],
  });
  return Object.assign(auth, { operatorSecret });
}

export type Auth = ReturnType<typeof createAuth>;

/**
 * Creates the auth instance after its tables exist. better-auth seeds OAuth
 * resources when an instance initializes, so a first instance only supplies the
 * schema for migrations and the returned instance starts against migrated tables.
 */
export async function createMigratedAuth(options: AuthOptions): Promise<Auth> {
  await (await getMigrations(createAuth(options).options)).runMigrations();
  const auth = createAuth(options);
  await auth.$context;
  return auth;
}
