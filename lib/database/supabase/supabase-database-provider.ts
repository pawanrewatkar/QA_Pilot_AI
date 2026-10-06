import { DatabaseNotImplementedError, type DatabaseProvider } from "../provider";

/**
 * Placeholder for the future Supabase (Postgres) implementation of DatabaseProvider.
 *
 * Implementation notes for a later phase:
 * - Port lib/database/schema.ts to Postgres migrations (TEXT ids → uuid, TEXT timestamps → timestamptz,
 *   JSON TEXT columns → jsonb). Keep every CHECK constraint, especially the test_results
 *   "verdict requires executed_at" rule.
 * - Use the service-role key only on the server / worker; never ship it to the browser.
 * - Re-run tests/database.test.ts against this provider to prove parity.
 */
export function createSupabaseDatabaseProvider(): DatabaseProvider {
  throw new DatabaseNotImplementedError("supabase");
}
