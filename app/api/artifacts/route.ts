import { getDatabase } from "@/lib/database";
import { getStorage } from "@/lib/storage";
import { assertValidStorageKey } from "@/lib/storage/provider";

/** Serves screenshot evidence. Only keys recorded by a test run can be read. */
export async function GET(request: Request) {
  const key = new URL(request.url).searchParams.get("key") ?? "";
  try {
    assertValidStorageKey(key);
  } catch {
    return new Response("Invalid key", { status: 400 });
  }
  if (!key.startsWith("runs/") || !(await getDatabase().testResults.isKnownArtifact(key))) return new Response("Not found", { status: 404 });
  const bytes = await getStorage().get(key);
  if (!bytes) return new Response("File missing from storage", { status: 410 });
  return new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]), {
    headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff" },
  });
}
