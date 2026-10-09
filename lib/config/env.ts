import path from "node:path";
import { z } from "zod";

/**
 * Server-side environment configuration. Every value has a local default so the
 * app runs with no .env file at all. Never import this from client components.
 */
const envSchema = z.object({
  DATABASE_PROVIDER: z.enum(["local", "supabase"]).default("local"),
  DATABASE_PATH: z.string().min(1).default("./data/qa-pilot.db"),
  STORAGE_PROVIDER: z.enum(["local"]).default("local"),
  STORAGE_PATH: z.string().min(1).default("./data/storage"),
  MAX_UPLOAD_MB: z.coerce.number().positive().max(100).default(10),
  /** Folder from which External Test Case Testing may read workbooks by local path. Paths outside it are refused. */
  EXTERNAL_TEST_CASES_DIR: z.string().min(1).default("./data/test-cases"),
  AI_PROVIDER: z.enum(["local", "anthropic"]).default("local"),
  ANTHROPIC_API_KEY: z.string().optional(),
  SUPABASE_URL: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  FIGMA_ACCESS_TOKEN: z.string().optional(),
  PAGESPEED_API_KEY: z.string().optional(),
  EMAIL_PROVIDER: z.enum(["local", "smtp"]).default("local"),
  SMTP_URL: z.string().optional(),
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
