import path from "node:path";
import { z } from "zod";

/**
 * Server-side environment configuration. Every value has a local default so the
 * app runs with no .env file at all. Never import this from client components.
 */
const envSchema = z.object({
  DATABASE_PROVIDER: z.enum(["local", "supabase"]).default("local"),
  DATABASE_PATH: z.string().min(1).default("./data/qa-pilot.db"),
  /** PostgreSQL connection string, used only when DATABASE_PROVIDER=supabase. Contains a password: never log it. */
  DATABASE_URL: z.string().optional(),
  /** PostgreSQL pool settings (DATABASE_PROVIDER=supabase only). */
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(5),
  DATABASE_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(10_000),
  DATABASE_QUERY_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(30_000),
  /** PEM certificate(s) to verify the PostgreSQL server against (e.g. Supabase's root CA). Server-only. */
  DATABASE_SSL_CA: z.string().optional(),
  STORAGE_PROVIDER: z.enum(["local", "supabase"]).default("local"),
  STORAGE_PATH: z.string().min(1).default("./data/storage"),
  /** Supabase Storage (STORAGE_PROVIDER=supabase): private bucket name and per-object size limit. */
  STORAGE_BUCKET: z.string().min(3).max(63).default("qa-pilot-artifacts"),
  STORAGE_MAX_OBJECT_MB: z.coerce.number().positive().max(5_000).default(50),
  MAX_UPLOAD_MB: z.coerce.number().positive().max(100).default(10),
  /** Folder from which External Test Case Testing may read workbooks by local path. Paths outside it are refused. */
  EXTERNAL_TEST_CASES_DIR: z.string().min(1).default("./data/test-cases"),
  AI_PROVIDER: z.enum(["local", "anthropic"]).default("local"),
  ANTHROPIC_API_KEY: z.string().optional(),
  SUPABASE_URL: z.string().optional(),
  /** Server-only Supabase secret key (sb_secret_…) for Storage; SUPABASE_SERVICE_ROLE_KEY is the legacy name. */
  SUPABASE_SECRET_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  FIGMA_ACCESS_TOKEN: z.string().optional(),
  PAGESPEED_API_KEY: z.string().optional(),
  EMAIL_PROVIDER: z.enum(["local", "smtp"]).default("local"),
  SMTP_URL: z.string().optional(),
  /** Worker only: stop claiming new jobs after this many minutes (for time-limited runners such as GitHub Actions). */
  WORKER_MAX_RUNTIME_MINUTES: z.coerce.number().positive().max(360).optional(),
});

export type AppEnv = z.infer<typeof envSchema>;

/** Treats empty strings as unset so `KEY=` in .env behaves like an absent key. */
function cleaned(source: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(source).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim() !== ""),
  );
}

export function readEnv(source: Record<string, string | undefined> = process.env): AppEnv {
  const parsed = envSchema.safeParse(cleaned(source));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  return parsed.data;
}

export function resolveFromRoot(p: string): string {
  // Runtime-configured path: exclude from build-time file tracing.
  return path.isAbsolute(p) ? p : path.resolve(/*turbopackIgnore: true*/ process.cwd(), p);
}
