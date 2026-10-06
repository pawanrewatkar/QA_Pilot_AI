import { getDatabase } from "@/lib/database";

/** Polled by the crawl progress panel. */
export async function GET(_request: Request, ctx: RouteContext<"/api/crawl-runs/[id]">) {
  const { id } = await ctx.params;
  const crawl = await getDatabase().crawlRuns.getById(id);
  if (!crawl) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(crawl, { headers: { "Cache-Control": "no-store" } });
}
