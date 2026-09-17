import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(databaseUrl: string): Db {
  return new pg.Pool({ connectionString: databaseUrl, max: 10 });
}

export async function transaction<T>(db: Db, run: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("begin");
    const result = await run(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

const migrationsDir = resolve(import.meta.dirname, "../migrations");

/** Applies migrations/*.sql in name order, each once, under an advisory lock. */
export async function migrate(db: Db): Promise<string[]> {
  const applied: string[] = [];
  await transaction(db, async (tx) => {
    await tx.query("select pg_advisory_xact_lock(hashtext('platform_migrations'))");
    await tx.query("create table if not exists platform_migrations (name text primary key, applied_at timestamptz not null default now())");
    const done = new Set((await tx.query<{ name: string }>("select name from platform_migrations")).rows.map((row) => row.name));
    const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      await tx.query(await readFile(resolve(migrationsDir, file), "utf8"));
      await tx.query("insert into platform_migrations (name) values ($1)", [file]);
      applied.push(file);
    }
  });
  return applied;
}
