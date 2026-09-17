import { randomBytes } from "node:crypto";
import { createMigratedAuth } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { createPool, migrate } from "../src/db.js";
import { createServiceClient, setPrice } from "../src/catalog.js";
import { registerTrustedClient } from "../src/operator.js";

const usage = `Usage: pnpm admin <command>

  service create <id> <sku-prefix>[,<sku-prefix>...]   Create or rotate a product's service token (printed once)
  service revoke <id>
  price set <sku> <unit-price-micro> [description]      Micro-USDC per unit; 1 USDC = 1000000
  price disable <sku>
  price list
  client create <name> <redirect-uri> [resource-url] [--public]
                                                       Register a product as a trusted OAuth client (secret printed once).
                                                       --public: no secret, PKCE only, for a product that exchanges its code in the browser.
`;

const [area, action, ...args] = process.argv.slice(2);
const config = loadConfig();
const db = createPool(config.DATABASE_URL);
await migrate(db);
const need = (count: number) => {
  if (args.length < count) {
    console.error(usage);
    process.exit(2);
  }
};

try {
  if (area === "service" && action === "create") {
    need(2);
    const secret = randomBytes(32).toString("base64url");
    await createServiceClient(db, args[0]!, args[1]!.split(","), secret);
    console.log(`Service token for ${args[0]} (store it in that product's secrets; it is not shown again):\n${secret}`);
  } else if (area === "service" && action === "revoke") {
    need(1);
    const { rowCount } = await db.query("update service_clients set revoked_at = now() where id = $1 and revoked_at is null", [args[0]]);
    console.log(rowCount ? `Revoked ${args[0]}.` : `No active service named ${args[0]}.`);
  } else if (area === "price" && action === "set") {
    need(2);
    const micro = Number(args[1]);
    if (!Number.isSafeInteger(micro) || micro <= 0) throw new Error("unit price must be a positive integer of micro-USDC");
    await setPrice(db, args[0]!, micro, args.slice(2).join(" "));
    console.log(`${args[0]} = ${micro} micro-USDC per unit.`);
  } else if (area === "price" && action === "disable") {
    need(1);
    const { rowCount } = await db.query("update price_catalog set active = false, updated_at = now() where sku = $1", [args[0]]);
    console.log(rowCount ? `Disabled ${args[0]}.` : `No SKU ${args[0]}.`);
  } else if (area === "price" && action === "list") {
    const { rows } = await db.query("select sku, unit_price_micro, active, description from price_catalog order by sku");
    console.table(rows);
  } else if (area === "client" && action === "create") {
    need(2);
    // A product whose browser does the code exchange registers public: no secret to leak.
    const isPublic = args.includes("--public");
    const rest = args.filter((argument) => argument !== "--public");
    const resources = rest[2] ? [rest[2]] : [];
    const auth = await createMigratedAuth({ db, config, mailer: { send: async () => {} }, resources });
    const client = await registerTrustedClient(auth, { name: rest[0]!, redirectUris: [rest[1]!], resource: rest[2], kind: isPublic ? "public" : "confidential" });
    console.log(
      isPublic
        ? `Public OAuth client for ${rest[0]} (PKCE only, no secret):\nclient_id=${client.client_id}`
        : `OAuth client for ${rest[0]} (the secret is not shown again):\nclient_id=${client.client_id}\nclient_secret=${client.client_secret}`,
    );
  } else {
    console.error(usage);
    process.exitCode = 2;
  }
} finally {
  await db.end();
}
