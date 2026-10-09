import { FileSpreadsheet } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { ExecutionWizard } from "@/components/external-tests/execution-wizard";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Pagination, readPage } from "@/components/shared/pagination";
import { RunStatusBadge } from "@/components/shared/status-badges";
import { WorkerStatusBanner } from "@/components/shared/worker-status";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { readEnv, resolveFromRoot } from "@/lib/config/env";
import { requestDb } from "@/lib/server/db";
import { formatDateTime } from "@/lib/utils";

export const metadata: Metadata = { title: "External Test Case Testing" };

const PAGE_SIZE = 10;

export default async function ExternalTestCasesPage({ searchParams }: PageProps<"/external-test-cases">) {
  const sp = await searchParams;
  const page = readPage(sp.page);
  const db = await requestDb();
  const env = readEnv();
  const [projects, executions, total, worker] = await Promise.all([
    db.projects.list({ sort: "name" }),
    db.externalTests.list({ limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    db.externalTests.count(),
    db.workers.status(),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="External Test Case Testing"
        description="Run your own test cases from an Excel workbook against a website. Steps are executed in real browsers, actual behaviour is compared with the expected result, and the results are written back to Excel."
      />
      <WorkerStatusBanner initial={worker} />

      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle>Executions</CardTitle>
          <CardDescription>Every execution is also a test run, so it appears in History with its evidence and bugs.</CardDescription>
        </CardHeader>
        {executions.length === 0 ? (
          <CardContent>
            <EmptyState compact icon={FileSpreadsheet} title="No executions yet" description="Set up an execution below: website, workbook, worksheet, column mapping, devices and output." />
          </CardContent>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Execution</TableHead>
                  <TableHead className="hidden md:table-cell">Website / workbook</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right" title="PASS / FAIL / HUMAN INTERACTION / NOT EXECUTED / NOT APPLICABLE">P / F / H / NE / NA</TableHead>
                  <TableHead className="hidden lg:table-cell">Date</TableHead>
                  <TableHead><span className="sr-only">Actions</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {executions.map((e) => (
                  <TableRow key={e.runId} className="align-top">
                    <TableCell className="min-w-48">
                      <Link href={`/external-test-cases/${e.runId}`} className="font-medium hover:underline">{e.name ?? e.runId.slice(0, 8)}</Link>
                      <p className="text-xs text-muted-foreground">{e.totalCases} test case(s) · {e.projectName}</p>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <p className="max-w-64 truncate font-mono text-xs">{e.websiteUrl}</p>
                      <p className="max-w-64 truncate text-xs text-muted-foreground">{e.sourceName} · {e.worksheet}</p>
                    </TableCell>
                    <TableCell><RunStatusBadge status={e.runStatus} /></TableCell>
                    <TableCell className="text-right text-xs whitespace-nowrap tabular-nums">
                      <span className="text-success-text">{e.counts.PASS}</span> / <span className="text-destructive-text">{e.counts.FAIL}</span> / <span className="text-warning-text">{e.counts["HUMAN INTERACTION"]}</span> /{" "}
                      {e.counts["NOT EXECUTED"]} / {e.counts["NOT APPLICABLE"]}
                    </TableCell>
                    <TableCell className="hidden whitespace-nowrap text-muted-foreground lg:table-cell">{formatDateTime(e.createdAt)}</TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1.5">
                        <Button variant="outline" size="sm" asChild>
                          <Link href={`/external-test-cases/${e.runId}`}>Open</Link>
                        </Button>
                        {e.outputFileName ? (
                          <Button variant="outline" size="sm" asChild>
                            <a href={`/api/external-test-cases/${e.runId}/download`} aria-label={`Download results of ${e.name ?? "execution"}`}>Excel</a>
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className="border-t p-4">
              <Pagination basePath="/external-test-cases" params={{}} page={page} pageSize={PAGE_SIZE} total={total} />
            </div>
          </>
        )}
      </Card>

      <h2 className="text-lg font-semibold">New execution</h2>
      <ExecutionWizard
        projects={projects.map((p) => ({ id: p.id, name: p.name, websiteUrl: p.websiteUrl }))}
        localDir={resolveFromRoot(env.EXTERNAL_TEST_CASES_DIR)}
        maxUploadMb={env.MAX_UPLOAD_MB}
        today={new Date().toISOString().slice(0, 10)}
      />
    </div>
  );
}
