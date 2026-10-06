import { CirclePlay, Plus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { ProjectFilter, readProjectParam } from "@/components/shared/project-filter";
import { RunStatusBadge } from "@/components/shared/status-badges";
import { WorkerStatusBanner } from "@/components/shared/worker-status";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requestDb } from "@/lib/server/db";
import { formatDateTime } from "@/lib/utils";

export const metadata: Metadata = { title: "Test Runs" };

export default async function TestRunsPage({ searchParams }: PageProps<"/test-runs">) {
  const projectId = readProjectParam((await searchParams).project);
  const db = await requestDb();
  const [runs, projects, worker] = await Promise.all([db.testRuns.list({ projectId, limit: 200 }), db.projects.list({ sort: "name" }), db.workers.status()]);
  const details = await Promise.all(runs.map((r) => db.testRuns.getDetail(r.id)));
  const hasActive = runs.some((r) => r.status === "PENDING" || r.status === "RUNNING");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Test Runs"
        description="Every execution of real browser tests. Run status (Pending → Running → Completed / Failed / Cancelled) is tracked separately from individual result verdicts."
        actions={
          <Button asChild disabled={projects.length === 0}>
            <Link href={projectId ? `/test-runs/new?project=${projectId}` : "/test-runs/new"}>
              <Plus /> New test run
            </Link>
          </Button>
        }
      />
      {hasActive ? <WorkerStatusBanner initial={worker} /> : <WorkerStatusBanner initial={worker} compact />}
      <ProjectFilter projects={projects} selected={projectId} basePath="/test-runs" />
      {runs.length === 0 ? (
        <EmptyState
          icon={CirclePlay}
          title="No test runs yet"
          description="Crawl a project's website (or add URLs), then start a test run to execute real browser checks."
          action={projects.length ? <Button asChild><Link href="/test-runs/new"><Plus /> New test run</Link></Button> : <Button asChild variant="outline"><Link href="/projects/new">Create a project</Link></Button>}
        />
      ) : (
        <Card className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Run</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden sm:table-cell">Progress</TableHead>
                <TableHead>Results</TableHead>
                <TableHead className="hidden md:table-cell">Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((r, i) => {
                const d = details[i]!;
                return (
                  <TableRow key={r.id}>
                    <TableCell>
                      <Link href={`/test-runs/${r.id}`} className="font-medium hover:underline">{d.name ?? `Run ${r.id.slice(0, 8)}`}</Link>
                      <p className="text-xs text-muted-foreground">
                        {r.projectName} · {d.pageIds.length} pages · {d.browsers.join(", ")}
                      </p>
                    </TableCell>
                    <TableCell><RunStatusBadge status={r.status} /></TableCell>
                    <TableCell className="hidden tabular-nums sm:table-cell">{d.progressCompleted}/{d.progressTotal}</TableCell>
                    <TableCell className="text-xs whitespace-nowrap tabular-nums">
                      <span className="text-success">{d.counts.PASS} pass</span> · <span className="text-destructive">{d.counts.FAIL} fail</span> · <span>{d.counts.WARNING} warn</span>
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground md:table-cell">{formatDateTime(r.createdAt)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
