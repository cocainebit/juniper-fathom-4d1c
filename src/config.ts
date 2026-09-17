import { z } from "zod";

const optional = z
  .string()
  .optional()
  .transform((value) => (value ? value : undefined));

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8760),
  HOST: z.string().default("127.0.0.1"),
  PUBLIC_URL: z.url().default("http://127.0.0.1:8760"),
  DATABASE_URL: z.string().min(1),
  AUTH_SECRET: z.string().min(32),
  PAYLOAD_KEY: z
    .string()
    .refine((value) => Buffer.from(value, "base64").length === 32, "PAYLOAD_KEY must be 32 bytes, base64"),
  TRUSTED_ORIGINS: z
    .string()
    .default("")
    .transform((value) => value.split(",").map((origin) => origin.trim()).filter(Boolean)),
  SMTP_HOST: z.string().default("127.0.0.1"),
  SMTP_PORT: z.coerce.number().int().default(8764),
  MAIL_FROM: z.string().default("Platform <accounts@localhost.test>"),
  FACILITATOR: optional,
  CDP_API_KEY_ID: optional,
  CDP_API_KEY_SECRET: optional,
  PAY_TO_EVM: optional,
  PAY_TO_SOLANA: optional,
  EVM_RPC_URL: optional,
  EVM_NETWORK: z.string().regex(/^eip155:\d+$/).default("eip155:84532"),
  EVM_USDC: optional,
  EVM_CONFIRMATIONS: z.coerce.number().int().min(1).max(64).default(3),
  SOLANA_RPC_URL: optional,
  SOLANA_NETWORK: z.string().regex(/^solana:[1-9A-HJ-NP-Za-km-z]{32}$/).default("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"),
  SOLANA_USDC: optional,
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    // Report which variables are wrong without echoing their values.
    const problems = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`Invalid configuration:\n  ${problems.join("\n  ")}`);
  }
  const config = parsed.data;
  if (config.NODE_ENV === "production") {
    const mainnets = config.EVM_NETWORK === "eip155:8453" || config.SOLANA_NETWORK === "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
    if (mainnets && !config.PUBLIC_URL.startsWith("https://")) throw new Error("PUBLIC_URL must be https when a mainnet is configured.");
  }
  return config;
}
