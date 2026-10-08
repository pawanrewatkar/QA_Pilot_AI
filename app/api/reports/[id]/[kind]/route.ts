import { getDatabase } from "@/lib/database";
import { REPORT_CONTENT_TYPES } from "@/lib/reports/paths";
import { getStorage } from "@/lib/storage";

/**
 * Serves a generated report file. `?download=1` forces a download; otherwise PDF and HTML open in
 * the browser. HTML is served with a sandbox CSP so the report cannot act on this app's origin.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/reports/[id]/[kind]">) {
  const { id, kind } = await ctx.params;
  if (!Object.hasOwn(REPORT_CONTENT_TYPES, kind)) return new Response("Unknown report type", { status: 404 });
  const file = await getDatabase().reports.getFile(id, kind);
  if (!file) return new Response("Report not found", { status: 404 });
  const bytes = await getStorage().get(file.storageKey);
  if (!bytes) return new Response("File missing from storage", { status: 410 });
  const download = new URL(request.url).searchParams.get("download") === "1" || kind.endsWith("EXCEL");
  const safeName = file.fileName.replace(/[^A-Za-z0-9._-]/g, "_");
  const headers: Record<string, string> = {
    "Content-Type": REPORT_CONTENT_TYPES[kind as keyof typeof REPORT_CONTENT_TYPES],
    "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${safeName}"`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  };
  if (kind === "HTML") headers["Content-Security-Policy"] = "sandbox allow-scripts allow-popups; default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'";
  return new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]), { headers });
}
