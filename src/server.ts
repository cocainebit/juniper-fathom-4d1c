import { createApp } from "./app.js";
import { createMigratedAuth, smtpMailer } from "./auth.js";
import { loadConfig } from "./config.js";
import { createPool, migrate } from "./db.js";
import { createPayments } from "./payments.js";

const config = loadConfig();
const db = createPool(config.DATABASE_URL);
await migrate(db);
const resources = (process.env.OAUTH_RESOURCES ?? "").split(",").map((value) => value.trim()).filter(Boolean);
const auth = await createMigratedAuth({ db, config, mailer: smtpMailer(config), resources });
const payments = await createPayments(db, config);
console.log(payments ? `Payments enabled: ${payments.options.map((option) => option.label).join(", ")}` : "Payments are not configured (FACILITATOR, PAY_TO_*, *_RPC_URL); charges cannot be paid.");
const app = createApp({ db, auth, config, payments });
app.listen(config.PORT, config.HOST, () => {
  console.log(`Platform listening on http://${config.HOST}:${config.PORT}`);
});
