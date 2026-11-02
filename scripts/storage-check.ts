/**
 * Read-only check of the Supabase Storage bucket the app would use (STORAGE_PROVIDER=supabase):
 *
 *   npx tsx --env-file=.env.supabase.local scripts/storage-check.ts
 *
 * Reads the bucket's settings only (getBucket): it must exist and be private; its size limit and allowed file types
 * are compared with what the app stores. It does not list, read, upload, change or delete anything, and never prints
 * the project URL or key.
 */
import { createClient } from "@supabase/supabase-js";
import { readEnv } from "@/lib/config/env";
import { supabaseStorageConfig } from "@/lib/storage/select";
import { contentTypeFor } from "@/lib/storage/supabase-storage-provider";

const STORED_TYPES = ["x.png", "x.pdf", "x.html", "x.xlsx", "x.json", "x.eml", "x.docx", "x.md", "x.txt"].map(contentTypeFor);

const env = readEnv();
let config: ReturnType<typeof supabaseStorageConfig>;
try {
  config = supabaseStorageConfig({ ...env, NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const client = createClient(config.url, config.key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
const { data, error } = await client.storage.getBucket(config.bucket);
if (error || !data) {
  const e = (error ?? {}) as { status?: number; statusCode?: string };
  console.error(`Bucket "${config.bucket}" could not be read (${e.status ?? e.statusCode ?? "error"}): it may not exist, or the key is not a secret key.`);
  process.exit(1);
}
const limit = data.file_size_limit ?? null;
const allowed = data.allowed_mime_types ?? null;
console.log(`Bucket: ${data.name}`);
console.log(`Private: ${data.public ? "NO — public objects are readable by anyone with the URL" : "yes"}`);
console.log(`File size limit: ${limit === null ? "project default" : `${limit} bytes`} (app limit: ${config.maxObjectBytes} bytes)`);
console.log(`Allowed file types: ${allowed?.length ? allowed.join(", ") : "any"}`);
const problems: string[] = [];
if (data.public) problems.push("the bucket is public; make it private before use");
if (typeof limit === "number" && limit < config.maxObjectBytes) problems.push("the bucket's size limit is below STORAGE_MAX_OBJECT_MB; large reports would be rejected");
const blocked = allowed?.length ? STORED_TYPES.filter((t) => !allowed.some((a) => a === t || a === t.split(";")[0] || (a.endsWith("/*") && t.startsWith(a.slice(0, -1))))) : [];
if (blocked.length) problems.push(`these file types the app stores are not allowed: ${blocked.join(", ")}`);
console.log(problems.length ? `Problems:\n- ${problems.join("\n- ")}` : "Ready: private, and accepts every file type and size the app stores.");
process.exitCode = problems.length ? 2 : 0;
