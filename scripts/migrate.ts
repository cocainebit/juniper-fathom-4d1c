import { createMigratedAuth } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { createPool, migrate } from "../src/db.js";

const config = loadConfig();
const db = createPool(config.DATABASE_URL);
const applied = await migrate(db);
await createMigratedAuth({ db, config, mailer: { send: async () => {} } });
console.log(applied.length ? `Applied ${applied.join(", ")} and auth migrations.` : "Platform migrations up to date; auth migrations applied.");
await db.end();
