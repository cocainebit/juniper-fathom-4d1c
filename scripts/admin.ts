import { randomBytes, randomUUID } from "node:crypto";
import { createMigratedAuth } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { createPool, migrate } from "../src/db.js";
import { balance, createServiceClient, grant, setPrice } from "../src/ledger.js";
import { registerTrustedClient } from "../src/operator.js";

const usage = `Usage: pnpm admin <command>

  service create <id> <sku-prefix>[,<sku-prefix>...]   Create or rotate a product's service token (printed once)
  service revoke <id>
  price set <sku> <unit-price-micro> [description]      Micro-USDC per unit; 1 USDC = 1000000
  price disable <sku>
  price list
  credits grant <organization-id> <amount-micro> <reason>   Operator adjustment, recorded in the ledger
  credits balance <organization-id>
  client create <name> <redirect-uri> [resource-url]    Register a product as a trusted OAuth client (secret printed once)
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
  } else if (area === "credits" && action === "grant") {
    need(3);
    const micro = Number(args[1]);
    const outcome = await grant(db, { organizationId: args[0]!, amountMicro: micro, idempotencyKey: `adjust:${randomUUID()}`, reason: `operator: ${args.slice(2).join(" ")}` });
    console.log(outcome);
  } else if (area === "credits" && action === "balance") {
    need(1);
    console.log(`${await balance(db, args[0]!)} micro-USDC`);
  } else if (area === "client" && action === "create") {
    need(2);
    const resources = args[2] ? [args[2]] : [];
    const auth = await createMigratedAuth({ db, config, mailer: { send: async () => {} }, resources });
    const client = await registerTrustedClient(auth, { name: args[0]!, redirectUris: [args[1]!], resource: args[2] });
    console.log(`OAuth client for ${args[0]} (the secret is not shown again):\nclient_id=${client.client_id}\nclient_secret=${client.client_secret}`);
  } else {
    console.error(usage);
    process.exitCode = 2;
  }
} finally {
  await db.end();
}
