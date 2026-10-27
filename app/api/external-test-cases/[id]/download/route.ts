import { routeDb } from "@/lib/server/db";
import { getStorage } from "@/lib/storage";

/** Downloads the result workbook of an external test-case execution. */
export async function GET(_request: Request, ctx: RouteContext<"/api/external-test-cases/[id]/download">) {
  const access = routeDb();
  if (access.denied) return access.denied;
  const { id } = await ctx.params;
  const file = await access.db.externalTests.getOutputFile(id);
  if (!file) return new Response("The result workbook is not available yet.", { status: 404 });
  const bytes = await getStorage().get(file.storageKey);
  if (!bytes) return new Response("File missing from storage", { status: 410 });
  const safeName = file.fileName.replace(/[^A-Za-z0-9._-]/g, "_");
  return new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${safeName}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
