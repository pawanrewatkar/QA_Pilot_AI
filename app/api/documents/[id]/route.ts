import { routeDb } from "@/lib/server/db";
import { getStorage } from "@/lib/storage";

/** Streams a stored reference document back to the user as a download. */
export async function GET(_request: Request, ctx: RouteContext<"/api/documents/[id]">) {
  const access = routeDb();
  if (access.denied) return access.denied;
  const { id } = await ctx.params;
  const doc = await access.db.documents.getById(id);
  if (!doc) return new Response("Not found", { status: 404 });

  const bytes = await getStorage().get(doc.storageKey);
  if (!bytes) return new Response("File missing from storage", { status: 410 });

  const asciiName = doc.fileName.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
  return new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]), {
    headers: {
      "Content-Type": doc.mimeType,
      "Content-Length": String(bytes.byteLength),
      "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(doc.fileName)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
