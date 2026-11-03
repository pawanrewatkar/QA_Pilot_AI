import type { SqlExecutor } from "./executor";

/**
 * SQL fragments that differ between SQLite and PostgreSQL. Everything else the repositories use is standard SQL
 * understood by both (`IS NOT DISTINCT FROM`, `ON CONFLICT DO NOTHING`, `NULLS FIRST`, `RETURNING`, CASE sums).
 */

/** Text value of a top-level key in a JSON text column (`json_extract` in SQLite, `->>` in PostgreSQL). */
export function jsonText(sql: Pick<SqlExecutor, "dialect">, column: string, key: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Unsafe JSON key: ${key}`);
  return sql.dialect === "postgres" ? `(${column}::jsonb ->> '${key}')` : `json_extract(${column}, '$.${key}')`;
}

/** Case-insensitive LIKE: SQLite's LIKE already ignores ASCII case; PostgreSQL needs ILIKE. */
export function ilike(sql: Pick<SqlExecutor, "dialect">): "LIKE" | "ILIKE" {
  return sql.dialect === "postgres" ? "ILIKE" : "LIKE";
}

/** Case-insensitive ordering of a text column (SQLite `COLLATE NOCASE`; PostgreSQL `lower(...)`). */
export function nocase(sql: Pick<SqlExecutor, "dialect">, column: string): string {
  return sql.dialect === "postgres" ? `lower(${column})` : `${column} COLLATE NOCASE`;
}

/** Names of the columns of a table (SQLite `PRAGMA table_info`; PostgreSQL information_schema). */
export async function tableColumns(sql: SqlExecutor, table: string): Promise<string[]> {
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error(`Unsafe table name: ${table}`);
  const rows =
    sql.dialect === "postgres"
      ? await sql.all<{ name: string }>("SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ? ORDER BY ordinal_position", [table])
      : await sql.all<{ name: string }>(`PRAGMA table_info(${table})`);
  return rows.map((r) => r.name);
}
