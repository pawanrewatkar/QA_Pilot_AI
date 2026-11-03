/**
 * Read-only connection check for the hosted PostgreSQL database (scripts/pg-connection-check.ts).
 *
 * It proves three things without changing anything: the connection string points to the Supabase session pooler, the
 * connection is encrypted with a verified certificate (CA and host name), and the database answers. Everything runs
 * in one READ ONLY transaction that is rolled back. Output never contains the password, the connection string, the
 * host name or the CA certificate.
 */

/** Supabase session pooler host, e.g. `aws-0-ap-northeast-1.pooler.supabase.com`. */
const POOLER_HOST = /^aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com$/;

/** Why `url` is not a Supabase session pooler connection string (empty when it is). Messages never contain values. */
export function sessionPoolerProblems(url: string): string[] {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return ["DATABASE_URL could not be parsed."];
  }
  const problems: string[] = [];
  if (/^db\..+\.supabase\.co$/.test(u.hostname)) {
    problems.push("DATABASE_URL is the direct connection (db.<project-ref>.supabase.co, IPv6 only). Use the session pooler string: Dashboard → Connect → Session pooler.");
  } else if (!POOLER_HOST.test(u.hostname)) {
    problems.push("DATABASE_URL host is not a Supabase pooler host (aws-<n>-<region>.pooler.supabase.com).");
  }
  if (u.port !== "5432") problems.push(`DATABASE_URL port must be 5432 (session pooler)${u.port === "6543" ? "; 6543 is the transaction pooler" : ""}.`);
  if (!/^postgres\.[a-z0-9]+$/.test(decodeURIComponent(u.username))) problems.push("DATABASE_URL user must be postgres.<project-ref> (the pooler user name).");
  if (!u.password) problems.push("DATABASE_URL has no password.");
  return problems;
}

/** The only statements the check sends, in order. Nothing writes; the transaction is read-only and rolled back. */
export const CHECK_STATEMENTS = {
  begin: "BEGIN READ ONLY",
  ping: "SELECT 1 AS ok",
  server: "SELECT current_setting('server_version') AS server_version, current_database() AS database, current_setting('transaction_read_only') AS read_only",
  schema:
    "SELECT (SELECT count(*)::int FROM information_schema.tables WHERE table_schema = 'public') AS public_tables, to_regclass('public.qa_pilot_migrations') IS NOT NULL AS migrations_table",
  rollback: "ROLLBACK",
} as const;

export interface TlsInfo {
  encrypted: boolean;
  /** The certificate chain and host name were verified (Node's `authorized`). */
  authorized: boolean;
  protocol: string | null;
  cipher: string | null;
}

export interface CheckClient {
  query(text: string): Promise<{ rows: Record<string, unknown>[] }>;
  tls(): TlsInfo | null;
}

export interface CheckReport {
  tls: TlsInfo;
  ping: boolean;
  serverVersion: string;
  database: string;
  readOnly: boolean;
  publicTables: number;
  migrationsTable: boolean;
}

/** Refuses to send a single query unless the connection is encrypted and verified; always rolls back. */
export async function runReadOnlyCheck(client: CheckClient): Promise<CheckReport> {
  const tls = client.tls();
  if (!tls?.encrypted) throw new ConnectionCheckError("The connection is not encrypted; refusing to continue.");
  if (!tls.authorized) throw new ConnectionCheckError("The server certificate was not verified; refusing to continue.");
  await client.query(CHECK_STATEMENTS.begin);
  try {
    const ping = (await client.query(CHECK_STATEMENTS.ping)).rows[0];
    const server = (await client.query(CHECK_STATEMENTS.server)).rows[0];
    const schema = (await client.query(CHECK_STATEMENTS.schema)).rows[0];
    return {
      tls,
      ping: Number(ping?.ok) === 1,
      serverVersion: String(server?.server_version ?? ""),
      database: String(server?.database ?? ""),
      readOnly: server?.read_only === "on",
      publicTables: Number(schema?.public_tables ?? 0),
      migrationsTable: schema?.migrations_table === true,
    };
  } finally {
    await client.query(CHECK_STATEMENTS.rollback);
  }
}

export class ConnectionCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectionCheckError";
  }
}

const TLS_CODES: Record<string, string> = {
  SELF_SIGNED_CERT_IN_CHAIN: "the certificate chain does not lead to DATABASE_SSL_CA (wrong or outdated CA certificate)",
  DEPTH_ZERO_SELF_SIGNED_CERT: "the server certificate is self-signed and not DATABASE_SSL_CA",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "the server certificate is not signed by DATABASE_SSL_CA (wrong CA certificate)",
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "the server certificate's issuer is not DATABASE_SSL_CA (wrong CA certificate)",
  CERT_HAS_EXPIRED: "the server certificate has expired",
  CERT_NOT_YET_VALID: "the server certificate is not valid yet",
  ERR_TLS_CERT_ALTNAME_INVALID: "the server certificate does not match the host name",
};

/**
 * A one-line, value-free explanation of a connection failure. Known causes are described; anything else shows the
 * error code and its message with every `secrets` value (password, URL, host, CA) replaced.
 */
export function describeConnectionError(error: unknown, secrets: string[]): string {
  const e = error as { code?: string; message?: string; name?: string };
  const code = e?.code ?? "";
  if (TLS_CODES[code]) return `TLS verification failed (${code}): ${TLS_CODES[code]}. Nothing was sent to the database.`;
  if (/does not support SSL/i.test(e?.message ?? "")) return "The server does not offer TLS; the connection was refused (never downgraded to unencrypted).";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return `DNS lookup failed (${code}): check the pooler host in DATABASE_URL.`;
  if (code === "ECONNREFUSED" || code === "ETIMEDOUT" || code === "ENETUNREACH" || code === "EHOSTUNREACH") return `Network connection failed (${code}).`;
  if (code === "28P01" || code === "28000") return `Authentication failed (${code}): check the user and password in DATABASE_URL.`;
  if (code === "3D000") return "The database in DATABASE_URL does not exist (3D000).";
  if (/timeout/i.test(e?.message ?? "")) return "Timed out connecting to the database.";
  if (e instanceof ConnectionCheckError) return e.message;
  let text = `${e?.name ?? "Error"}${code ? ` (${code})` : ""}: ${e?.message ?? String(error)}`;
  for (const s of secrets.filter((v) => v && v.length >= 4).sort((a, b) => b.length - a.length)) text = text.split(s).join("<hidden>");
  return text.replace(/postgres(ql)?:\/\/\S+/gi, "<connection string>").replace(/-----BEGIN [\s\S]+?-----END [A-Z ]+-----/g, "<certificate>");
}
