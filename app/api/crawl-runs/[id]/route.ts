import { routeDb } from "@/lib/server/db";

/** Polled by the crawl progress panel. */
export async function GET(_request: Request, ctx: RouteContext<"/api/crawl-runs/[id]">) {
  const access = routeDb();
  if (access.denied) return access.denied;
  const { id } = await ctx.params;
  const crawl = await access.db.crawlRuns.getById(id);
  if (!crawl) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(crawl, { headers: { "Cache-Control": "no-store" } });
}
