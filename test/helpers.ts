import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import pg from "pg";
import { migrate, type Db } from "../src/db.js";

if (existsSync(".env")) process.loadEnvFile(".env");

/** A throwaway Postgres schema with all migrations applied. */
export async function createTestDb(): Promise<{ db: Db; schema: string; drop: () => Promise<void> }> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set; run scripts/setup-local.ts and start the database");
  const schema = `test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`create schema ${schema}`);
  await admin.end();
  const db = new pg.Pool({ connectionString: url, max: 20, options: `-c search_path=${schema}` });
  await migrate(db);
  return {
    db,
    schema,
    drop: async () => {
      await db.end();
      const cleanup = new pg.Client({ connectionString: url });
      await cleanup.connect();
      await cleanup.query(`drop schema ${schema} cascade`);
      await cleanup.end();
    },
  };
}

export const token = () => randomBytes(32).toString("base64url");

/**
 * A throwaway database (not just a schema) with platform migrations applied.
 * better-auth's migrator inspects every schema it can see, so suites that run
 * better-auth get their own database.
 */
export async function createTestDatabase(): Promise<{ db: Db; url: string; drop: () => Promise<void> }> {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error("DATABASE_URL is not set; run scripts/setup-local.ts and start the database");
  const name = `platform_test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();
  const url = new URL(base);
  url.pathname = `/${name}`;
  const db = new pg.Pool({ connectionString: url.toString(), max: 20 });
  await migrate(db);
  return {
    db,
    url: url.toString(),
    drop: async () => {
      await db.end();
      const cleanup = new pg.Client({ connectionString: base });
      await cleanup.connect();
      await cleanup.query(`drop database if exists ${name} with (force)`);
      await cleanup.end();
    },
  };
}
