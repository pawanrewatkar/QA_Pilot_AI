import { Bug } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Pagination, readPage } from "@/components/shared/pagination";
import { readProjectParam } from "@/components/shared/project-filter";
import { BugStatusBadge, SeverityBadge } from "@/components/shared/status-badges";
import { moduleLabel, viewportLabel } from "@/components/test-runs/results-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Label, NativeSelect } from "@/components/ui/form-controls";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requestDb } from "@/lib/server/db";
import { formatDateTime } from "@/lib/utils";
import { BUG_PRIORITIES, BUG_SEVERITIES, BUG_STATUSES, type BugPriority, type BugQuery, type BugSeverity, type BugStatus } from "@/types";

export const metadata: Metadata = { title: "Bugs" };

const PAGE_SIZE = 25;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const pick = <T extends string>(list: readonly T[], v: string | undefined) => list.find((x) => x === v);

export default async function BugsPage({ searchParams }: PageProps<"/bugs">) {
  const sp = await searchParams;
  const db = await requestDb();
  const projectId = readProjectParam(sp.project);
  const runId = readProjectParam(sp.run);
  const facets = await db.bugs.facets(projectId);
  const query: BugQuery = {
    projectId,
    testRunId: runId,
    search: first(sp.q)?.slice(0, 200) || undefined,
    severity: pick(BUG_SEVERITIES, first(sp.severity)) as BugSeverity | undefined,
    priority: pick(BUG_PRIORITIES, first(sp.priority)) as BugPriority | undefined,
    status: pick(BUG_STATUSES, first(sp.status)) as BugStatus | undefined,
    pageId: facets.pages.find((p) => p.id === first(sp.page_id))?.id,
    testType: facets.testTypes.find((t) => t === first(sp.type)),
    browser: facets.browsers.find((b) => b === first(sp.browser)),
    device: pick(["desktop", "mobile"] as const, first(sp.device)),
  };
  const page = readPage(sp.page);
  const [bugs, total, projects, run] = await Promise.all([
    db.bugs.list({ ...query, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    db.bugs.count(query),
    db.projects.list({ sort: "name" }),
    runId ? db.testRuns.getById(runId) : Promise.resolve(null),
  ]);
  const params = {
    project: projectId,
    run: runId,
    q: query.search,
    severity: query.severity,
    priority: query.priority,
    status: query.status,
    page_id: query.pageId,
    type: query.testType,
    browser: query.browser,
    device: query.device,
  };
  const filtered = Object.values(params).some(Boolean);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Bugs"
        description="Defects created only from verified failures, each with its evidence. Recurrences are merged by a deterministic fingerprint (page + test case identity); bugs are never marked resolved automatically."
      />
      {run ? (
        <p className="text-sm text-muted-foreground">
          Showing bugs observed in run <Link className="text-foreground hover:underline" href={`/test-runs/${run.id}`}>{run.id.slice(0, 8)}</Link> ·{" "}
          <Link className="hover:underline" href="/bugs">show all</Link>
        </p>
      ) : null}
      <form method="get" className="grid gap-3 rounded-xl border bg-card p-4 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
        {runId ? <input type="hidden" name="run" value={runId} /> : null}
        <div className="grid gap-1.5 sm:col-span-2">
          <Label htmlFor="q">Search</Label>
          <Input id="q" name="q" type="search" placeholder="Title, bug ID, URL or actual result" defaultValue={query.search ?? ""} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="project">Project</Label>
          <NativeSelect id="project" name="project" defaultValue={projectId ?? ""}>
            <option value="">All projects</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="severity">Severity</Label>
          <NativeSelect id="severity" name="severity" defaultValue={query.severity ?? ""}>
            <option value="">All</option>
            {BUG_SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="priority">Priority</Label>
          <NativeSelect id="priority" name="priority" defaultValue={query.priority ?? ""}>
            <option value="">All</option>
            {BUG_PRIORITIES.map((s) => <option key={s} value={s}>{s}</option>)}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="status">Status</Label>
          <NativeSelect id="status" name="status" defaultValue={query.status ?? ""}>
            <option value="">All</option>
            {BUG_STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5 sm:col-span-2">
          <Label htmlFor="page_id">Page</Label>
          <NativeSelect id="page_id" name="page_id" defaultValue={query.pageId ?? ""}>
            <option value="">All pages</option>
            {facets.pages.map((p) => <option key={p.id} value={p.id}>{p.url}</option>)}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="type">Test type</Label>
          <NativeSelect id="type" name="type" defaultValue={query.testType ?? ""}>
            <option value="">All</option>
            {facets.testTypes.map((t) => <option key={t} value={t}>{moduleLabel(t)}</option>)}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="browser">Browser</Label>
          <NativeSelect id="browser" name="browser" defaultValue={query.browser ?? ""}>
            <option value="">All</option>
            {facets.browsers.map((b) => <option key={b} value={b}>{b}</option>)}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="device">Device</Label>
          <NativeSelect id="device" name="device" defaultValue={query.device ?? ""}>
            <option value="">All</option>
            <option value="desktop">Desktop</option>
            <option value="mobile">Mobile</option>
          </NativeSelect>
        </div>
        <div className="flex items-end gap-2">
          <Button type="submit" variant="secondary">Apply</Button>
          {filtered ? <Button variant="ghost" asChild><Link href="/bugs">Reset</Link></Button> : null}
        </div>
      </form>

      {bugs.length === 0 ? (
        <EmptyState
          icon={Bug}
          title={filtered ? "No matching bugs" : "No bugs recorded"}
          description={filtered ? "Change or reset the filters." : "Bugs are only created from checks that actually executed and failed, with screenshots or logs as evidence. Warnings and checks that could not run never create bugs."}
        />
      ) : (
        <Card className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-24">Bug ID</TableHead>
                <TableHead>Title</TableHead>
                <TableHead>Severity</TableHead>
                <TableHead className="hidden sm:table-cell">Priority</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden lg:table-cell">Test type</TableHead>
                <TableHead className="hidden xl:table-cell">Device / browser</TableHead>
                <TableHead className="hidden md:table-cell">Last seen</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {bugs.map((b) => (
                <TableRow key={b.id} className="align-top">
                  <TableCell className="font-mono text-xs whitespace-nowrap">
                    <Link href={`/bugs/${b.id}`} className="hover:underline">{b.code ?? b.id.slice(0, 8)}</Link>
                  </TableCell>
                  <TableCell className="min-w-64">
                    <Link href={`/bugs/${b.id}`} className="font-medium hover:underline">{b.title}</Link>
                    <p className="max-w-md truncate font-mono text-xs text-muted-foreground">{b.pageUrl ?? "—"}</p>
                    <p className="text-xs text-muted-foreground">
                      {b.projectName}
                      {b.occurrenceCount > 1 ? <> · seen {b.occurrenceCount}×</> : null}
                    </p>
                  </TableCell>
                  <TableCell><SeverityBadge severity={b.severity} /></TableCell>
                  <TableCell className="hidden sm:table-cell"><Badge variant="outline">{b.priority}</Badge></TableCell>
                  <TableCell><BugStatusBadge status={b.status} /></TableCell>
                  <TableCell className="hidden lg:table-cell">{b.testType ? moduleLabel(b.testType) : "—"}</TableCell>
                  <TableCell className="hidden text-xs xl:table-cell">
                    {b.viewport ? viewportLabel(b.viewport) : "—"}
                    <div className="text-muted-foreground">{b.browser ?? ""}</div>
                  </TableCell>
                  <TableCell className="hidden whitespace-nowrap text-muted-foreground md:table-cell">{formatDateTime(b.lastSeenAt ?? b.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="border-t p-4">
            <Pagination basePath="/bugs" params={params} page={page} pageSize={PAGE_SIZE} total={total} />
          </div>
        </Card>
      )}
    </div>
  );
}
