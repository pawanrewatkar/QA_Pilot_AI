import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { MIGRATIONS } from "../schema";

export type SqliteDatabase = Database.Database;

export const IN_MEMORY = ":memory:";

/** Opens (creating if needed) a SQLite database with the pragmas the app relies on. */
export function openSqlite(filePath: string): SqliteDatabase {
  if (filePath !== IN_MEMORY) {
    fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  }
  const db = new Database(filePath);
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  if (filePath !== IN_MEMORY) {
    // WAL lets the web app read while the worker process writes.
    db.pragma("journal_mode = WAL");
  }
  return db;
}

/** Applies pending migrations inside a transaction each. Returns the resulting schema version. */
export function runMigrations(db: SqliteDatabase): number {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);

  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[]).map((r) => r.version),
  );
  const record = db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)");

  for (const migration of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
    if (applied.has(migration.version)) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      record.run(migration.version, migration.name, new Date().toISOString());
    })();
  }

  return getSchemaVersion(db) ?? 0;
}

export function getSchemaVersion(db: SqliteDatabase): number | null {
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number | null } | undefined;
  return row?.v ?? null;
}
