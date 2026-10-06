/** Creates the local SQLite database if needed and applies pending migrations. */
import { readEnv, resolveFromRoot } from "@/lib/config/env";
import { openSqlite, runMigrations } from "@/lib/database/local/sqlite-client";

const env = readEnv();
if (env.DATABASE_PROVIDER !== "local") {
  console.error("db:migrate only supports DATABASE_PROVIDER=local.");
  process.exit(1);
}

const file = resolveFromRoot(env.DATABASE_PATH);
const db = openSqlite(file);
const version = runMigrations(db);
const tables = db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get() as { c: number };
db.close();
console.log(`Database ready at ${file} (schema version ${version}, ${tables.c} tables).`);
