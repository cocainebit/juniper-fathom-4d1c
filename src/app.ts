import { resolve } from "node:path";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import express, { type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import { z } from "zod";
import type { Auth } from "./auth.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { authenticateService, pricesFor, quote, unknownSkuMessage, type ServiceClient } from "./catalog.js";
import { ChargeError } from "./charges/service.js";
import type { Payments } from "./payments.js";

export type HttpResult = { status: number; headers?: Record<string, string>; body: unknown };

type SessionUser = { id: string; name: string; email: string; emailVerified: boolean };
type Locals = { user?: SessionUser; service?: ServiceClient };

export function fail(res: Response, status: number, code: string, message: string) {
  res.status(status).json({ error: { code, message } });
}

const send = (res: Response, result: HttpResult) => {
  for (const [name, value] of Object.entries(result.headers ?? {})) res.setHeader(name, value);
  res.status(result.status).json(result.body);
};

/** Wallet sign-ins create placeholder emails; never show them as a real address. */
const isPlaceholderEmail = (email: string) => email.endsWith("@wallet.invalid") || /@siwe\./.test(email) || email.startsWith("siwe-");

export function createApp({ db, auth, config, payments }: { db: Db; auth: Auth; config: Config; payments?: Payments | null }) {
  const charges = payments?.charges;
  const app = express();
  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { "script-src": ["'self'"], "connect-src": ["'self'"], "img-src": ["'self'", "data:"] } },
      crossOriginEmbedderPolicy: false,
    }),
  );

  // better-auth reads the raw body itself, so it is mounted before the JSON parser.
  app.all("/api/auth/*splat", toNodeHandler(auth));
  app.use(express.json({ limit: "64kb" }));

  const publicDir = resolve(import.meta.dirname, "../public");
  /** The payment sheet every product opens, so the prompt is the same everywhere. */
  const payUrl = (chargeId: string) => `${config.PUBLIC_URL.replace(/\/+$/, "")}/pay/${encodeURIComponent(chargeId)}`;
  app.get("/sign-in", (_req, res) => res.sendFile(resolve(publicDir, "sign-in.html")));
  app.get("/consent", (_req, res) => res.sendFile(resolve(publicDir, "consent.html")));
  app.get("/account", (_req, res) => res.sendFile(resolve(publicDir, "account.html")));
  app.get("/pay/:id", (_req, res) => res.sendFile(resolve(publicDir, "pay.html")));
  app.get("/", (_req, res) => res.redirect("/account"));
  app.use("/assets", express.static(resolve(publicDir, "assets"), { index: false, maxAge: config.NODE_ENV === "production" ? "1h" : 0 }));
  app.get("/healthz", async (_req, res) => {
    await db.query("select 1");
    res.json({ ok: true });
  });

  const limiter = (limit: number) => rateLimit({ windowMs: 60_000, limit, standardHeaders: "draft-7", legacyHeaders: false, skip: () => config.NODE_ENV === "test", handler: (_req, res) => fail(res, 429, "rate_limited", "Too many requests. Try again shortly.") });

  // ---- Public API: a signed-in user ----
  const v1 = express.Router();
  v1.use(limiter(300));
  v1.use(async (req: Request, res: Response<unknown, Locals>, next: NextFunction) => {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!session) return fail(res, 401, "unauthorized", "Sign in first.");
    res.locals.user = session.user as SessionUser;
    next();
  });
  const roleIn = async (organizationId: string, userId: string) =>
    (await db.query<{ role: string }>(`select role from member where "organizationId" = $1 and "userId" = $2`, [organizationId, userId])).rows[0]?.role;

  v1.get("/me", async (_req, res: Response<unknown, Locals>) => {
    const user = res.locals.user!;
    const [evm, solana, organizations] = await Promise.all([
      db.query(`select address, "chainId" as "chainId", "isPrimary" as "isPrimary" from "walletAddress" where "userId" = $1 order by "createdAt"`, [user.id]),
      db.query(`select address from "solanaWallet" where "userId" = $1 order by "createdAt"`, [user.id]),
      db.query(`select o.id, o.name, o.slug, m.role from member m join organization o on o.id = m."organizationId" where m."userId" = $1 order by o."createdAt"`, [user.id]),
    ]);
    res.json({
      user: { id: user.id, name: user.name, email: isPlaceholderEmail(user.email) ? null : user.email, emailVerified: user.emailVerified },
      wallets: [...evm.rows.map((row) => ({ chainFamily: "eip155", ...row })), ...solana.rows.map((row) => ({ chainFamily: "solana", ...row }))],
      organizations: organizations.rows,
    });
  });

  // What this person has paid for, across every product.
  v1.get("/payments", async (_req, res: Response<unknown, Locals>) => {
    res.json({ payments: charges ? await charges.listForUser(res.locals.user!.id) : [] });
  });


  // Which networks a charge can be paid on right now. Public: the payment sheet reads it
  // before anyone signs in, and it holds only networks and receiving addresses.
  app.get("/v1/payment-options", limiter(300), (_req, res) => {
    res.json({ options: payments?.options ?? [] });
  });

  // Paying is open to any x402 v2 client, so these need no session: the payer may be anyone.
  if (charges) {
    app.get("/v1/charges/:id", limiter(300), async (req: Request<{ id: string }>, res) => {
      const charge = await charges.get(req.params.id);
      if (!charge) return fail(res, 404, "not_found", "Charge not found.");
      const { organizationId: _organizationId, createdBy: _createdBy, ...rest } = charge;
      res.json(rest);
    });
    app.post("/v1/charges/:id/pay", limiter(120), async (req: Request<{ id: string }>, res) => {
      send(res, await charges.pay(req.params.id, req.get("payment-signature") ?? undefined));
    });
  }
  app.use("/v1", v1);

  // ---- Internal API: products, server to server ----
  const internal = express.Router();
  internal.use(limiter(6000));
  internal.use(async (req: Request, res: Response<unknown, Locals>, next: NextFunction) => {
    const header = req.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const service = token ? await authenticateService(db, token) : null;
    if (!service) return fail(res, 401, "unauthorized", "A valid service token is required.");
    res.locals.service = service;
    next();
  });

  internal.get("/prices", async (_req, res: Response<unknown, Locals>) => {
    res.json({ prices: await pricesFor(db, res.locals.service!) });
  });

  const chargeBody = z.object({
    sku: z.string().min(3).max(120),
    units: z.number().int().min(1).max(1_000_000).optional(),
    subject: z.string().min(1).max(200),
    description: z.string().max(200).optional(),
    userId: z.string().max(200).nullish(),
    organizationId: z.string().max(100).nullish(),
    network: z.string().max(80).optional(),
    expiresInSeconds: z.number().int().optional(),
  });
  internal.post("/charges", async (req, res: Response<unknown, Locals>) => {
    const key = req.get("idempotency-key");
    if (!key || key.length > 200) return fail(res, 400, "invalid_request", "Send an Idempotency-Key header of at most 200 characters.");
    const parsed = chargeBody.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, "invalid_request", "Send sku, subject and optionally units, description, userId, organizationId and network.");
    if (!charges) {
      // An unpriced SKU is free everywhere, including on a server with no payment rails,
      // so a product running against one is never told to collect money it cannot collect.
      const client = res.locals.service!;
      const quoted = await quote(db, client, parsed.data.sku);
      if (quoted.kind === "unknown") return fail(res, 422, "unknown_sku", unknownSkuMessage(client, parsed.data.sku));
      if (quoted.kind === "free") return res.json({ free: true });
      return fail(res, 503, "invalid_request", "Payments are not configured on this server.");
    }
    try {
      const result = await charges.create({ client: res.locals.service!, idempotencyKey: key, ...parsed.data });
      if (result.free) return res.json({ free: true });
      res.status(result.created ? 201 : 200).json({ free: false, created: result.created, charge: result.charge, payUrl: payUrl(result.charge.id), paymentUrl: result.charge.paymentUrl });
    } catch (error) {
      if (error instanceof ChargeError) return fail(res, error.httpStatus, error.code, error.message);
      throw error;
    }
  });

  internal.get("/charges/:id", async (req, res: Response<unknown, Locals>) => {
    if (!charges) return fail(res, 503, "invalid_request", "Payments are not configured on this server.");
    const charge = await charges.get(req.params.id!);
    if (!charge || charge.service !== res.locals.service!.id) return fail(res, 404, "not_found", "Charge not found.");
    res.json({ charge, payUrl: payUrl(charge.id) });
  });

  // The newest charge this product raised for a subject, so a retried action finds its payment.
  internal.get("/charges", async (req, res: Response<unknown, Locals>) => {
    if (!charges) return fail(res, 503, "invalid_request", "Payments are not configured on this server.");
    const subject = typeof req.query.subject === "string" ? req.query.subject : "";
    if (!subject) return fail(res, 400, "invalid_request", "Send subject.");
    const charge = await charges.findBySubject(res.locals.service!.id, subject);
    res.json({ charge, payUrl: charge ? payUrl(charge.id) : null });
  });

  internal.get("/users/:sub", async (req, res) => {
    const id = req.params.sub!;
    const user = (await db.query(`select id, name, email, "emailVerified" as "emailVerified" from "user" where id = $1`, [id])).rows[0];
    if (!user) return fail(res, 404, "not_found", "User not found.");
    const [evm, solana, organizations] = await Promise.all([
      db.query(`select address, "chainId" as "chainId" from "walletAddress" where "userId" = $1`, [id]),
      db.query(`select address from "solanaWallet" where "userId" = $1`, [id]),
      // The slug identifies the personal organization (`personal-<user id>`), which is
      // steadier for a product to match on than the position in this list.
      db.query(`select o.id, o.name, o.slug, m.role from member m join organization o on o.id = m."organizationId" where m."userId" = $1`, [id]),
    ]);
    res.json({
      user: { ...user, email: isPlaceholderEmail(user.email) ? null : user.email },
      wallets: [...evm.rows.map((row) => ({ chainFamily: "eip155", ...row })), ...solana.rows.map((row) => ({ chainFamily: "solana", ...row }))],
      organizations: organizations.rows,
    });
  });
  app.use("/internal/v1", internal);

  app.use((_req, res) => fail(res, 404, "not_found", "Not found."));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error(error);
    if (!res.headersSent) fail(res, 500, "internal", "Something went wrong.");
  });
  return app;
}
