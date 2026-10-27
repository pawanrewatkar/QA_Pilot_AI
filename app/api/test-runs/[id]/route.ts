import { routeDb } from "@/lib/server/db";

/** Polled by the live test-run progress panel. */
export async function GET(_request: Request, ctx: RouteContext<"/api/test-runs/[id]">) {
  const access = routeDb();
  if (access.denied) return access.denied;
  const { id } = await ctx.params;
  const run = await access.db.testRuns.getDetail(id);
  if (!run) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(run, { headers: { "Cache-Control": "no-store" } });
}
