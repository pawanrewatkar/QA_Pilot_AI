import { GitCompareArrows, History } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Pagination, readPage } from "@/components/shared/pagination";
import { readProjectParam } from "@/components/shared/project-filter";
import { RunStatusBadge } from "@/components/shared/status-badges";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Label, NativeSelect } from "@/components/ui/form-controls";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requestDb } from "@/lib/server/db";
import { cn, formatDateTime } from "@/lib/utils";
import { TEST_RUN_STATUSES, type RunHistoryRecord, type TestRunStatus } from "@/types";

export const metadata: Metadata = { title: "History" };

const PAGE_SIZE = 20;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const ACTION_VARIANT: Record<string, "success" | "default" | "destructive" | "secondary"> = {
  created: "success",
  updated: "default",
  deleted: "destructive",
};

function Ratio({ value, label }: { value: { failed: number; executed: number } | null; label: string }) {
  if (!value) return <span className="text-muted-foreground" title={`${label} was not tested`}>—</span>;
  return (
    <span className={cn("tabular-nums", value.failed ? "text-destructive-text" : "")} title={`${value.failed} failed of ${value.executed} executed ${label} checks`}>
      {value.failed}/{value.executed}
    </span>
  );
}

function RunRow({ r }: { r: RunHistoryRecord }) {
  const c = r.counts;
  const href = r.runType === "EXTERNAL_TEST_CASE" ? `/external-test-cases/${r.id}` : `/test-runs/${r.id}`;
  return (
    <TableRow className="align-top">
      <TableCell className="min-w-48">
        <Link href={href} className="font-medium hover:underline">{r.name ?? `Run ${r.id.slice(0, 8)}`}</Link>
        {r.runType === "EXTERNAL_TEST_CASE" ? <Badge variant="outline" className="ml-1.5">External test cases</Badge> : null}
        <p className="text-xs text-muted-foreground">{formatDateTime(r.completedAt ?? r.createdAt)}</p>
        <p className="text-xs text-muted-foreground md:hidden">{r.projectName}</p>
      </TableCell>
      <TableCell className="hidden md:table-cell">
        <Link href={`/projects/${r.projectId}`} className="hover:underline">{r.projectName}</Link>
        <p className="max-w-48 truncate font-mono text-xs text-muted-foreground">{r.website}</p>
      </TableCell>
      <TableCell><RunStatusBadge status={r.status} /></TableCell>
      <TableCell className="text-right tabular-nums">{r.pages}</TableCell>
      <TableCell className="text-right tabular-nums">{r.totalTests}</TableCell>
      <TableCell className="text-right text-xs tabular-nums whitespace-nowrap">
        <span className="text-success-text">{c.PASS}</span> / <span className="text-destructive-text">{c.FAIL}</span> / <span className="text-warning-text">{c.WARNING}</span> /{" "}
        <span className="text-muted-foreground">{c["NOT EXECUTED"]}</span>
      </TableCell>
      <TableCell className="hidden text-right text-xs tabular-nums lg:table-cell">
        <span className="font-medium">{r.bugs}</span>
        {r.newBugs ? <span className="text-muted-foreground"> ({r.newBugs} new)</span> : null}
        {r.bugs ? (
          <div className="text-muted-foreground" title="Critical / High / Medium / Low">
            {r.severity.CRITICAL}/{r.severity.HIGH}/{r.severity.MEDIUM}/{r.severity.LOW}
          </div>
        ) : null}
      </TableCell>
      <TableCell className="hidden text-right text-xs tabular-nums xl:table-cell">
        {r.performanceScore !== null ? Math.round(r.performanceScore * 100) : "—"}
        {r.lcpMs !== null ? <div className="text-muted-foreground">LCP {Math.round(r.lcpMs)} ms</div> : null}
      </TableCell>
      <TableCell className="hidden text-right text-xs xl:table-cell"><Ratio value={r.accessibility} label="accessibility" /></TableCell>
      <TableCell className="hidden text-right text-xs xl:table-cell"><Ratio value={r.seo} label="SEO" /></TableCell>
      <TableCell>
        <div className="flex justify-end gap-1">
          <Button variant="outline" size="sm" asChild>
            <Link href={href}>Open</Link>
          </Button>
          {r.status !== "PENDING" && r.status !== "RUNNING" ? (
            <Button variant="ghost" size="sm" asChild>
              <Link href={`/test-runs/${r.id}/compare`} aria-label={`Compare ${r.name ?? "run"} with the previous run`}>
                <GitCompareArrows />
              </Link>
            </Button>
          ) : null}
        </div>
      </TableCell>
    </TableRow>
  );
}

export default async function HistoryPage({ searchParams }: PageProps<"/history">) {
  const sp = await searchParams;
  const tab = first(sp.tab) === "activity" ? "activity" : "runs";
  const projectId = readProjectParam(sp.project);
  const status = TEST_RUN_STATUSES.find((s) => s === first(sp.status)) as TestRunStatus | undefined;
  const search = first(sp.q)?.slice(0, 200) || undefined;
  const page = readPage(sp.page);
  const db = await requestDb();
  const query = { projectId, status, search };
  const [runs, total, entries, projects] = await Promise.all([
    tab === "runs" ? db.history.listRuns({ ...query, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }) : Promise.resolve([]),
    tab === "runs" ? db.history.countRuns(query) : Promise.resolve(0),
    tab === "activity" ? db.activity.list({ projectId, limit: 500 }) : Promise.resolve([]),
    db.projects.list({ sort: "name" }),
  ]);
  const filtered = !!(projectId || status || search);
  const tabHref = (t: string) => `/history?tab=${t}${projectId ? `&project=${projectId}` : ""}`;

  return (
    <div className="space-y-6">
      <PageHeader title="History" description="Every test run with its recorded totals, plus the audit trail of changes. Open a run to see its results or compare it with an earlier run." />
      <nav aria-label="History views" className="flex gap-1 border-b">
        {[
          { id: "runs", label: "Test runs" },
          { id: "activity", label: "Activity log" },
        ].map((t) => (
          <Link
            key={t.id}
            href={tabHref(t.id)}
            aria-current={tab === t.id ? "page" : undefined}
            className={cn("-mb-px border-b-2 px-3 py-2 text-sm", tab === t.id ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground")}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      <form method="get" className="flex flex-wrap items-end gap-3 rounded-xl border bg-card p-4">
        <input type="hidden" name="tab" value={tab} />
        {tab === "runs" ? (
          <div className="grid min-w-56 flex-1 gap-1.5">
            <Label htmlFor="q">Search</Label>
            <Input id="q" name="q" type="search" placeholder="Run, project or website" defaultValue={search ?? ""} />
          </div>
        ) : null}
        <div className="grid gap-1.5">
          <Label htmlFor="project">Project</Label>
          <NativeSelect id="project" name="project" defaultValue={projectId ?? ""}>
            <option value="">All projects</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </NativeSelect>
        </div>
        {tab === "runs" ? (
          <div className="grid gap-1.5">
            <Label htmlFor="status">Run status</Label>
            <NativeSelect id="status" name="status" defaultValue={status ?? ""}>
              <option value="">All</option>
              {TEST_RUN_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </NativeSelect>
          </div>
        ) : null}
        <Button type="submit" variant="secondary">Apply</Button>
        {filtered ? <Button variant="ghost" asChild><Link href={tabHref(tab).replace(/&project=[^&]+/, "")}>Reset</Link></Button> : null}
      </form>

      {tab === "runs" ? (
        runs.length === 0 ? (
          <EmptyState icon={History} title={filtered ? "No matching runs" : "No test runs yet"} description={filtered ? "Change the filters." : "Runs appear here once they are started from a project."} />
        ) : (
          <Card className="overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Run / date</TableHead>
                  <TableHead className="hidden md:table-cell">Project / website</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Pages</TableHead>
                  <TableHead className="text-right">Tests</TableHead>
                  <TableHead className="text-right" title="PASS / FAIL / WARNING / NOT EXECUTED">P / F / W / NE</TableHead>
                  <TableHead className="hidden text-right lg:table-cell" title="Bugs observed (C/H/M/L)">Bugs</TableHead>
                  <TableHead className="hidden text-right xl:table-cell" title="Average performance score of measured pages">Perf.</TableHead>
                  <TableHead className="hidden text-right xl:table-cell" title="Failed / executed accessibility checks">A11y</TableHead>
                  <TableHead className="hidden text-right xl:table-cell" title="Failed / executed SEO checks">SEO</TableHead>
                  <TableHead><span className="sr-only">Actions</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((r) => <RunRow key={r.id} r={r} />)}
              </TableBody>
            </Table>
            <div className="border-t p-4">
              <Pagination basePath="/history" params={{ tab: "runs", project: projectId, status, q: search }} page={page} pageSize={PAGE_SIZE} total={total} />
            </div>
          </Card>
        )
      ) : entries.length === 0 ? (
        <EmptyState icon={History} title="No activity yet" description="Actions such as creating a project, running tests or generating reports are recorded here." />
      ) : (
        <Card className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>When</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Summary</TableHead>
                <TableHead className="hidden md:table-cell">Project</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{formatDateTime(a.createdAt)}</TableCell>
                  <TableCell>
                    <Badge variant={ACTION_VARIANT[a.action] ?? "secondary"}>
                      {a.entityType.replace(/_/g, " ")} {a.action}
                    </Badge>
                  </TableCell>
                  <TableCell className="min-w-64">{a.summary}</TableCell>
                  <TableCell className="hidden md:table-cell">
                    {a.projectId && a.projectName ? (
                      <Link href={`/projects/${a.projectId}`} className="hover:underline">{a.projectName}</Link>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
