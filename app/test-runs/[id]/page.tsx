import { Bug, FileChartColumn, GitCompareArrows, ListChecks } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { createBugsFromRunAction } from "@/app/bugs/actions";
import { generateReportAction } from "@/app/reports/actions";
import { EmptyState } from "@/components/shared/empty-state";
import { SubmitButton } from "@/components/shared/submit-button";
import { PageHeader } from "@/components/shared/page-header";
import { WorkerStatusBanner } from "@/components/shared/worker-status";
import { moduleLabel, ResultsTable, viewportLabel } from "@/components/test-runs/results-table";
import { RunProgress } from "@/components/test-runs/run-progress";
import { DetailTabs, DetailView } from "@/components/test-runs/detail-view";
import { DETAIL_VIEWS, getDetailView } from "@/lib/constants/detail-views";
import { VIEWPORTS } from "@/lib/constants/testing";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label, NativeSelect } from "@/components/ui/form-controls";
import { requestDb } from "@/lib/server/db";
import { BROWSERS, TEST_RESULT_STATUSES, type BrowserName, type TestResultStatus } from "@/types";

export const metadata: Metadata = { title: "Test run" };

const PAGE_SIZE = 200;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function TestRunPage({ params, searchParams }: PageProps<"/test-runs/[id]">) {
  const { id } = await params;
  const sp = await searchParams;
  const db = await requestDb();
  const run = await db.testRuns.getDetail(id);
  if (!run) notFound();

  const status = TEST_RESULT_STATUSES.find((s) => s === first(sp.status)) as TestResultStatus | undefined;
  const browser = BROWSERS.find((b) => b === first(sp.browser)) as BrowserName | undefined;
  const viewport = run.viewports.find((v) => v === first(sp.viewport));
  const moduleFilter = first(sp.module);
  const pageNum = Math.max(1, Number(first(sp.page)) || 1);
  const query = { status, browser, viewport, module: moduleFilter || undefined };
  const [results, total, worker, pages] = await Promise.all([
    db.testResults.listByRun(id, { ...query, limit: PAGE_SIZE, offset: (pageNum - 1) * PAGE_SIZE }),
    db.testResults.countByRun(id, query),
    db.workers.status(),
    db.pages.getByIds(run.projectId, run.pageIds),
  ]);
  const finished = run.status !== "PENDING" && run.status !== "RUNNING";
  const [bugCount, bundles, previousRunId] = await Promise.all([
    db.bugs.count({ testRunId: id }),
    db.reports.listBundles({ testRunId: id, limit: 1 }),
    finished ? db.history.previousRunId(id) : Promise.resolve(null),
  ]);
  const latestReport = bundles[0];
  const detailView = getDetailView(first(sp.view));
  const detailFilters = {
    pageId: first(sp.page_id) || undefined,
    browser: first(sp.browser) || undefined,
    viewport: first(sp.viewport) || undefined,
    status: first(sp.status) || undefined,
    extra: first(sp.extra) || undefined,
  };
  const [detail, ...viewTotals] = await Promise.all([
    detailView ? db.testResults.listDetails(id, detailView.id, { ...detailFilters, limit: 500 }) : Promise.resolve(null),
    ...DETAIL_VIEWS.map((v) => db.testResults.listDetails(id, v.id, { limit: 1 }).then((r) => r.total)),
  ]);
  const tabs = [{ id: "results", label: "Results", total: await db.testResults.countByRun(id) }, ...DETAIL_VIEWS.map((v, i) => ({ id: v.id, label: v.label, total: viewTotals[i] }))];
  const detailViewports = run.modules.includes("responsive") ? VIEWPORTS.map((v) => v.id) : run.viewports;
  const filtered = !!(status || browser || viewport || moduleFilter);
  const modulesWithResults = ["page-load", ...run.modules];
  const qs = (p: number) => {
    const s = new URLSearchParams();
    if (status) s.set("status", status);
    if (browser) s.set("browser", browser);
    if (viewport) s.set("viewport", viewport);
    if (moduleFilter) s.set("module", moduleFilter);
    s.set("page", String(p));
    return `?${s.toString()}`;
  };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <>
            <Link href="/test-runs" className="hover:underline">Test Runs</Link> / <Link href={`/projects/${run.projectId}`} className="hover:underline">{run.projectName}</Link>
          </>
        }
        title={run.name ?? `Test run ${run.id.slice(0, 8)}`}
        description={`${run.pageIds.length} pages × ${run.browsers.length} browsers × ${run.viewports.length} viewports · ${run.modules.length} modules`}
        actions={
          <>
            <Button variant="outline" asChild>
              <Link href={`/test-cases?run=${run.id}`}>
                <ListChecks /> Test cases
              </Link>
            </Button>
            <Button variant="outline" asChild>
              <Link href={`/bugs?run=${run.id}`}>
                <Bug /> Bugs ({bugCount})
              </Link>
            </Button>
            {finished && previousRunId ? (
              <Button variant="outline" asChild>
                <Link href={`/test-runs/${run.id}/compare`}>
                  <GitCompareArrows /> Compare
                </Link>
              </Button>
            ) : null}
            {finished ? (
              <form action={generateReportAction}>
                <input type="hidden" name="testRunId" value={run.id} />
                <SubmitButton pendingLabel="Requesting…">
                  <FileChartColumn /> Generate report
                </SubmitButton>
              </form>
            ) : null}
          </>
        }
      />
      {run.status === "PENDING" || run.status === "RUNNING" ? <WorkerStatusBanner initial={worker} /> : null}
      {/* Remount when server state changes so the live panel never shows a stale status. */}
      <RunProgress key={`${run.status}-${run.cancelRequested}`} initial={run} />

      {finished ? (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-card px-4 py-3 text-sm">
          <span className="text-muted-foreground">
            {bugCount
              ? `${bugCount} bug${bugCount === 1 ? "" : "s"} observed in this run (from verified failures only).`
              : run.counts.FAIL
                ? "This run has verified failures but no bugs yet (runs from before bug tracking)."
                : "No verified failures, so no bugs were created."}
          </span>
          {run.counts.FAIL ? (
            <form action={createBugsFromRunAction}>
              <input type="hidden" name="testRunId" value={run.id} />
              <SubmitButton variant="outline" size="sm" pendingLabel="Checking…">
                {bugCount ? "Re-check bugs" : "Create bugs from failures"}
              </SubmitButton>
            </form>
          ) : null}
          {latestReport ? (
            <span className="ml-auto text-muted-foreground">
              Latest report: <Link href="/reports" className="text-foreground hover:underline">{latestReport.status === "GENERATING" ? "generating…" : latestReport.status.toLowerCase()}</Link>
            </span>
          ) : null}
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Run configuration</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 text-sm md:grid-cols-2">
          <div>
            <p className="mb-1.5 text-muted-foreground">Modules</p>
            <div className="flex flex-wrap gap-1">{run.modules.map((m) => <Badge key={m} variant="secondary">{moduleLabel(m)}</Badge>)}</div>
          </div>
          <div className="grid gap-3">
            <div>
              <p className="mb-1.5 text-muted-foreground">Browsers &amp; viewports</p>
              <div className="flex flex-wrap gap-1">
                {run.browsers.map((b) => <Badge key={b} variant="outline">{b}</Badge>)}
                {run.viewports.map((v) => <Badge key={v} variant="outline">{viewportLabel(v)}</Badge>)}
              </div>
            </div>
            <p className="text-muted-foreground">
              Real form submissions: <span className="text-foreground">{run.options.allowFormSubmission ? "allowed (once per form)" : "disabled (validation tested with submissions intercepted)"}</span> ·
              up to {run.options.maxLinksPerPage} links per page · {run.options.navigationTimeoutMs / 1000}s navigation timeout
            </p>
          </div>
          <details className="md:col-span-2">
            <summary className="cursor-pointer text-muted-foreground">Selected pages ({pages.length})</summary>
            <ul className="mt-2 grid gap-1 font-mono text-xs">{pages.map((p) => <li key={p.id} className="truncate">{p.url}</li>)}</ul>
          </details>
        </CardContent>
      </Card>

      <DetailTabs runId={run.id} active={detailView?.id ?? "results"} counts={tabs} />
      {detailView && detail ? (
        <DetailView runId={run.id} view={detailView} rows={detail.rows} total={detail.total} pages={pages.map((p) => ({ id: p.id, url: p.url }))} browsers={run.browsers} viewports={detailViewports} filters={detailFilters} />
      ) : (
      <Card>
        <CardHeader className="gap-3">
          <CardTitle>Results</CardTitle>
          <form method="get" className="flex flex-wrap items-end gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="f-status">Status</Label>
              <NativeSelect id="f-status" name="status" defaultValue={status ?? ""}>
                <option value="">All</option>
                {TEST_RESULT_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </NativeSelect>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="f-module">Type</Label>
              <NativeSelect id="f-module" name="module" defaultValue={moduleFilter ?? ""}>
                <option value="">All</option>
                {modulesWithResults.map((m) => <option key={m} value={m}>{moduleLabel(m)}</option>)}
              </NativeSelect>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="f-browser">Browser</Label>
              <NativeSelect id="f-browser" name="browser" defaultValue={browser ?? ""}>
                <option value="">All</option>
                {run.browsers.map((b) => <option key={b} value={b}>{b}</option>)}
              </NativeSelect>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="f-viewport">Viewport</Label>
              <NativeSelect id="f-viewport" name="viewport" defaultValue={viewport ?? ""}>
                <option value="">All</option>
                {run.viewports.map((v) => <option key={v} value={v}>{viewportLabel(v)}</option>)}
              </NativeSelect>
            </div>
            <Button type="submit" variant="secondary">Apply</Button>
            {filtered ? <Button variant="ghost" asChild><Link href={`/test-runs/${id}`}>Reset</Link></Button> : null}
          </form>
        </CardHeader>
        <CardContent className="space-y-3 p-0 pb-4">
          <p className="px-5 text-sm text-muted-foreground">
            {total} result{total === 1 ? "" : "s"}
            {filtered ? " match the filters" : ""}. Failures and warnings are listed first; expand a row for steps, verification and evidence.
          </p>
          {results.length === 0 ? (
            <div className="px-5">
              <EmptyState
                compact
                icon={ListChecks}
                title={filtered ? "No matching results" : run.status === "PENDING" || run.status === "RUNNING" ? "No results yet" : "No results recorded"}
                description={filtered ? "Change the filters." : run.status === "PENDING" || run.status === "RUNNING" ? "Results appear here as checks complete." : "This run did not record any results."}
              />
            </div>
          ) : (
            <ResultsTable results={results} />
          )}
          {total > PAGE_SIZE ? (
            <div className="flex items-center justify-between px-5 text-sm">
              <span className="text-muted-foreground">
                Page {pageNum} of {Math.ceil(total / PAGE_SIZE)}
              </span>
              <div className="flex gap-2">
                {pageNum > 1 ? <Button variant="outline" size="sm" asChild><Link href={qs(pageNum - 1)}>Previous</Link></Button> : null}
                {pageNum * PAGE_SIZE < total ? <Button variant="outline" size="sm" asChild><Link href={qs(pageNum + 1)}>Next</Link></Button> : null}
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>
      )}
    </div>
  );
}
