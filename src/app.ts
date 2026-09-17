import { resolve } from "node:path";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import express, { type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import { z } from "zod";
import type { Auth } from "./auth.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { authenticateService, balance, debit, debitBatch, debitItemSchema, pricesFor, recentEntries, type ServiceClient } from "./ledger.js";

/** What the HTTP layer needs from the invoice service. */
export type InvoiceApi = {
  create(input: { organizationId: string; userId: string; network: string; amountMicro: number; idempotencyKey: string }): Promise<HttpResult>;
  get(id: string): Promise<{ organizationId: string; body: unknown } | null>;
  pay(id: string, paymentSignature: string | undefined): Promise<HttpResult>;
};
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

export function createApp({ db, auth, config, invoices }: { db: Db; auth: Auth; config: Config; invoices?: InvoiceApi }) {
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
  app.get("/sign-in", (_req, res) => res.sendFile(resolve(publicDir, "sign-in.html")));
  app.get("/consent", (_req, res) => res.sendFile(resolve(publicDir, "consent.html")));
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

  v1.get("/orgs/:orgId/credits", async (req, res: Response<unknown, Locals>) => {
    const organizationId = req.params.orgId!;
    if (!(await roleIn(organizationId, res.locals.user!.id))) return fail(res, 404, "not_found", "Organization not found.");
    res.json({ organizationId, balanceMicro: await balance(db, organizationId), entries: await recentEntries(db, organizationId) });
  });

  if (invoices) {
    const createBody = z.object({ amountMicro: z.number().int(), network: z.string().min(1).max(80) });
    v1.post("/orgs/:orgId/invoices", async (req, res: Response<unknown, Locals>) => {
      const organizationId = req.params.orgId!;
      const role = await roleIn(organizationId, res.locals.user!.id);
      if (!role) return fail(res, 404, "not_found", "Organization not found.");
      if (role !== "owner" && role !== "admin") return fail(res, 403, "forbidden", "Only owners and admins can add credits.");
      const key = req.get("idempotency-key");
      if (!key || key.length > 200) return fail(res, 400, "invalid_request", "Send an Idempotency-Key header of at most 200 characters.");
      const parsed = createBody.safeParse(req.body);
      if (!parsed.success) return fail(res, 400, "invalid_request", "Send amountMicro and network.");
      send(res, await invoices.create({ organizationId, userId: res.locals.user!.id, idempotencyKey: key, ...parsed.data }));
    });
    v1.get("/invoices/:id", async (req, res: Response<unknown, Locals>) => {
      const invoice = await invoices.get(req.params.id!);
      if (!invoice || !(await roleIn(invoice.organizationId, res.locals.user!.id))) return fail(res, 404, "not_found", "Invoice not found.");
      res.json(invoice.body);
    });
  }

  // Paying an invoice is open to any x402 v2 client; the payer needs no account.
  if (invoices) {
    app.post("/v1/invoices/:id/pay", limiter(120), async (req: Request<{ id: string }>, res) => {
      send(res, await invoices.pay(req.params.id, req.get("payment-signature") ?? undefined));
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

  internal.get("/orgs/:orgId/balance", async (req, res) => {
    res.json({ organizationId: req.params.orgId, balanceMicro: await balance(db, req.params.orgId!), asOf: new Date().toISOString() });
  });

  const singleStatus = { applied: 200, replayed: 200, conflict: 409, insufficient_funds: 402, unknown_sku: 422 } as const;
  internal.post("/usage", async (req, res: Response<unknown, Locals>) => {
    const parsed = debitItemSchema.safeParse({ ...req.body, idempotencyKey: req.get("idempotency-key") });
    if (!parsed.success) return fail(res, 400, "invalid_request", "Send an Idempotency-Key header and organizationId, sku and units.");
    const outcome = await debit(db, res.locals.service!, parsed.data);
    res.status(singleStatus[outcome.status]).json(outcome);
  });

  const batchBody = z.object({ items: z.array(debitItemSchema).min(1).max(500) });
  internal.post("/usage/batch", async (req, res: Response<unknown, Locals>) => {
    const parsed = batchBody.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, "invalid_request", "Send items: [{ idempotencyKey, organizationId, sku, units }], at most 500.");
    res.json({ outcomes: await debitBatch(db, res.locals.service!, parsed.data.items) });
  });

  internal.get("/users/:sub", async (req, res) => {
    const id = req.params.sub!;
    const user = (await db.query(`select id, name, email, "emailVerified" as "emailVerified" from "user" where id = $1`, [id])).rows[0];
    if (!user) return fail(res, 404, "not_found", "User not found.");
    const [evm, solana, organizations] = await Promise.all([
      db.query(`select address, "chainId" as "chainId" from "walletAddress" where "userId" = $1`, [id]),
      db.query(`select address from "solanaWallet" where "userId" = $1`, [id]),
      db.query(`select o.id, o.name, m.role from member m join organization o on o.id = m."organizationId" where m."userId" = $1`, [id]),
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
