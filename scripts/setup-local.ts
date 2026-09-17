import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

// Writes .env with random local secrets. Never overwrites an existing value.
const example = readFileSync(".env.example", "utf8");
const current = existsSync(".env") ? readFileSync(".env", "utf8") : "";
const has = (key: string) => new RegExp(`^${key}=.+`, "m").test(current);
const password = randomBytes(18).toString("base64url");
const generated: Record<string, string> = {
  POSTGRES_PASSWORD: password,
  DATABASE_URL: `postgres://platform:${password}@127.0.0.1:8763/platform`,
  AUTH_SECRET: randomBytes(32).toString("base64url"),
  PAYLOAD_KEY: randomBytes(32).toString("base64"),
};
if (has("POSTGRES_PASSWORD") && !has("DATABASE_URL")) throw Error("POSTGRES_PASSWORD is set without DATABASE_URL; fix .env by hand.");
const lines = example.split("\n").map((line) => {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (!match) return line;
  const [, key] = match;
  const existing = new RegExp(`^${key}=(.*)$`, "m").exec(current);
  if (existing && existing[1]) return `${key}=${existing[1]}`;
  if (key && generated[key]) return `${key}=${generated[key]}`;
  return line;
});
writeFileSync(".env", lines.join("\n"), { mode: 0o600 });
console.log("Wrote .env (mode 600). Secrets were generated locally and not printed.");
