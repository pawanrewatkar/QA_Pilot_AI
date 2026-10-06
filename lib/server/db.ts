import "server-only";
import { connection } from "next/server";
import { getDatabase } from "@/lib/database";

/**
 * Database accessor for Server Components. better-sqlite3 is synchronous, so without
 * `connection()` Next.js would run these queries once at build time and serve stale data.
 */
export async function requestDb() {
  await connection();
  return getDatabase();
}
