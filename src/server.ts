import { createApp } from "./app.js";
import { createMigratedAuth, smtpMailer } from "./auth.js";
import { loadConfig } from "./config.js";
import { createPool, migrate } from "./db.js";

const config = loadConfig();
const db = createPool(config.DATABASE_URL);
await migrate(db);
const resources = (process.env.OAUTH_RESOURCES ?? "").split(",").map((value) => value.trim()).filter(Boolean);
const auth = await createMigratedAuth({ db, config, mailer: smtpMailer(config), resources });
const app = createApp({ db, auth, config });
app.listen(config.PORT, config.HOST, () => {
  console.log(`Platform listening on http://${config.HOST}:${config.PORT}`);
});
