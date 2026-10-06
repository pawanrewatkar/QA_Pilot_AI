import { getDatabase } from "@/lib/database";

/** Polled by the live test-run progress panel. */
export async function GET(_request: Request, ctx: RouteContext<"/api/test-runs/[id]">) {
  const { id } = await ctx.params;
  const run = await getDatabase().testRuns.getDetail(id);
  if (!run) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(run, { headers: { "Cache-Control": "no-store" } });
}
