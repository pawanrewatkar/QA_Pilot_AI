import { Bug, ExternalLink, ListChecks } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ExecutionProgress } from "@/components/external-tests/execution-progress";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Pagination, readPage } from "@/components/shared/pagination";
import { ExternalStatusBadge } from "@/components/shared/status-badges";
import { viewportLabel } from "@/components/test-runs/results-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label, NativeSelect } from "@/components/ui/form-controls";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EXTERNAL_STATUSES, type ExternalStatus } from "@/lib/external-tests/types";
import { requestDb } from "@/lib/server/db";
import { cn, formatDateTime } from "@/lib/utils";

export const metadata: Metadata = { title: "External test case execution" };

const PAGE_SIZE = 50;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function ExternalExecutionPage({ params, searchParams }: PageProps<"/external-test-cases/[id]">) {
  const { id } = await params;
  const sp = await searchParams;
  const db = await requestDb();
  const execution = await db.externalTests.get(id);
  if (!execution) notFound();
  const status = EXTERNAL_STATUSES.find((s) => s === first(sp.status)) as ExternalStatus | undefined;
  const page = readPage(sp.page);
  const [{ rows, total }, bugCount] = await Promise.all([db.externalTests.listCases(id, { status, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }), db.bugs.count({ testRunId: id })]);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <>
            <Link href="/external-test-cases" className="hover:underline">External Test Case Testing</Link> / <Link href={`/projects/${execution.projectId}`} className="hover:underline">{execution.projectName}</Link>
          </>
        }
        title={execution.name ?? `Execution ${id.slice(0, 8)}`}
        description={
          <>
            <span className="font-mono">{execution.websiteUrl}</span> · {execution.sourceName} · worksheet “{execution.worksheet}” · {execution.browsers.join(", ")} ·{" "}
            {execution.viewports.map((v) => viewportLabel(v)).join(", ")}
          </>
        }
        actions={
          <>
            <Button variant="outline" asChild>
              <Link href={`/test-runs/${id}`}>
                <ListChecks /> Run evidence
              </Link>
            </Button>
            <Button variant="outline" asChild>
              <Link href={`/bugs?run=${id}`}>
                <Bug /> Bugs ({bugCount})
              </Link>
            </Button>
          </>
        }
      />

      <ExecutionProgress key={`${execution.runStatus}-${execution.cancelRequested}`} initial={execution} />

      {execution.resultColumns ? (
        <p className="text-sm text-muted-foreground">
          {execution.outputMode === "NEW_SHEET" ? "Results were written to the new sheet" : "Results were written to the existing sheet"} “{execution.resultColumns.sheet}” in the columns{" "}
          <span className="font-medium text-foreground">{execution.resultColumns.actual} / {execution.resultColumns.status} / {execution.resultColumns.date}</span>
          {execution.resultColumns.set > 1 ? " (earlier results in the workbook were kept)" : ""}.
        </p>
      ) : null}

      <Card className="overflow-hidden">
        <CardHeader className="gap-3">
          <div>
            <CardTitle>Test case results</CardTitle>
            <CardDescription>
              Actual results describe what was observed. With several devices or browsers, the case status is the weakest one (FAIL, then HUMAN INTERACTION, NOT EXECUTED, PASS, NOT APPLICABLE).
            </CardDescription>
          </div>
          <form method="get" className="flex flex-wrap items-end gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="f-status">Status</Label>
              <NativeSelect id="f-status" name="status" defaultValue={status ?? ""}>
                <option value="">All</option>
                {EXTERNAL_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </NativeSelect>
            </div>
            <Button type="submit" variant="secondary">Apply</Button>
            {status ? <Button variant="ghost" asChild><Link href={`/external-test-cases/${id}`}>Reset</Link></Button> : null}
          </form>
        </CardHeader>
        {rows.length === 0 ? (
          <CardContent>
            <EmptyState compact icon={ListChecks} title={status ? "No matching test cases" : "No results yet"} description={status ? "Change the filter." : "Results appear as each test case is evaluated in every selected device."} />
          </CardContent>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-14">Row</TableHead>
                <TableHead>Test case</TableHead>
                <TableHead className="hidden lg:table-cell">Expected result</TableHead>
                <TableHead>Actual result</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id} className="align-top">
                  <TableCell className="tabular-nums text-muted-foreground">{r.rowNumber}</TableCell>
                  <TableCell className="min-w-48">
                    {r.caseRef ? <p className="font-mono text-xs text-muted-foreground">{r.caseRef}</p> : null}
                    <p className="font-medium">{r.title}</p>
                    {r.steps ? (
                      <details className="mt-1 text-xs">
                        <summary className="cursor-pointer text-muted-foreground">Steps</summary>
                        <p className="mt-1 whitespace-pre-wrap">{r.steps}</p>
                      </details>
                    ) : (
                      <p className="text-xs text-muted-foreground">No steps in the sheet</p>
                    )}
                  </TableCell>
                  <TableCell className="hidden max-w-72 text-sm whitespace-pre-wrap lg:table-cell">{r.expected ?? "—"}</TableCell>
                  <TableCell className="min-w-64 text-sm">
                    {r.observations.length ? (
                      <ul className="space-y-2">
                        {r.observations.map((o) => (
                          <li key={`${o.browser}-${o.viewport}`} className={cn("rounded-md border p-2", o.status === "HUMAN INTERACTION" && "border-warning/50 bg-warning/10")}>
                            <div className="mb-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                              <ExternalStatusBadge status={o.status} />
                              {viewportLabel(o.viewport)} · {o.browser}
                              {o.screenshotKey ? (
                                <a href={`/api/artifacts?key=${encodeURIComponent(o.screenshotKey)}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary underline underline-offset-2">
                                  screenshot <ExternalLink className="size-3" aria-hidden />
                                </a>
                              ) : null}
                            </div>
                            <p className="whitespace-pre-wrap">{o.actual}</p>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <span className="text-muted-foreground">{r.actual ?? "Waiting…"}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {r.status ? <ExternalStatusBadge status={r.status} /> : <Badge variant="outline">pending</Badge>}
                    {r.executedAt && r.status ? <p className="mt-1 text-xs whitespace-nowrap text-muted-foreground">{formatDateTime(r.executedAt)}</p> : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <div className="border-t p-4">
          <Pagination basePath={`/external-test-cases/${id}`} params={{ status }} page={page} pageSize={PAGE_SIZE} total={total} />
        </div>
      </Card>
    </div>
  );
}
