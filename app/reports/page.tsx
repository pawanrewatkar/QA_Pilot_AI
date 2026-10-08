import { Download, Eye, FileChartColumn, Trash2 } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { deleteReportAction } from "@/app/reports/actions";
import { AutoRefresh } from "@/components/shared/auto-refresh";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Pagination, readPage } from "@/components/shared/pagination";
import { readProjectParam } from "@/components/shared/project-filter";
import { ReportStatusBadge } from "@/components/shared/status-badges";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Label, NativeSelect } from "@/components/ui/form-controls";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { REPORT_KIND_LABELS } from "@/lib/reports/paths";
import { requestDb } from "@/lib/server/db";
import { formatBytes, formatDateTime } from "@/lib/utils";
import { REPORT_STATUSES, type ReportBundleRecord, type ReportKind, type ReportStatus } from "@/types";

export const metadata: Metadata = { title: "Reports" };

const PAGE_SIZE = 20;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function FileLink({ bundle, kind, view }: { bundle: ReportBundleRecord; kind: ReportKind; view?: boolean }) {
  const file = bundle.files.find((f) => f.kind === kind);
  const label = view ? "View" : `Download ${REPORT_KIND_LABELS[kind]}`;
  // Formats not selected for this report are not offered.
  if (!file && bundle.status !== "GENERATING") return null;
  if (!file || file.status !== "READY") {
    return (
      <Button variant="outline" size="sm" disabled title={file?.errorMessage ?? (bundle.status === "GENERATING" ? "Generating…" : "Not available")}>
        {view ? <Eye /> : <Download />} {label}
      </Button>
    );
  }
  const href = `/api/reports/${bundle.id}/${kind}${view ? "" : "?download=1"}`;
  return (
    <Button variant={view ? "default" : "outline"} size="sm" asChild>
      <a href={href} target={view ? "_blank" : undefined} rel={view ? "noopener" : undefined} title={`${file.fileName ?? ""} · ${formatBytes(file.sizeBytes)}`}>
        {view ? <Eye /> : <Download />} {label}
      </a>
    </Button>
  );
}

export default async function ReportsPage({ searchParams }: PageProps<"/reports">) {
  const sp = await searchParams;
  const projectId = readProjectParam(sp.project);
  const status = REPORT_STATUSES.find((s) => s === first(sp.status)) as ReportStatus | undefined;
  const search = first(sp.q)?.slice(0, 200) || undefined;
  const page = readPage(sp.page);
  const db = await requestDb();
  const query = { projectId, status, search };
  const [bundles, total, projects] = await Promise.all([
    db.reports.listBundles({ ...query, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    db.reports.countBundles(query),
    db.projects.list({ sort: "name" }),
  ]);
  const filtered = !!(projectId || status || search);
  const generating = bundles.some((b) => b.status === "GENERATING");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Report Center"
        description="PDF, standalone HTML, testing Excel and bug Excel reports generated from finished test runs. Reports contain only recorded results; secrets and personal data are redacted."
        actions={
          <Button variant="outline" asChild>
            <Link href="/history">Generate from a run</Link>
          </Button>
        }
      />
      <AutoRefresh active={generating} />
      <form method="get" className="flex flex-wrap items-end gap-3 rounded-xl border bg-card p-4">
        <div className="grid min-w-56 flex-1 gap-1.5">
          <Label htmlFor="q">Search</Label>
          <Input id="q" name="q" type="search" placeholder="Report, project or website" defaultValue={search ?? ""} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="project">Project</Label>
          <NativeSelect id="project" name="project" defaultValue={projectId ?? ""}>
            <option value="">All projects</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="status">Status</Label>
          <NativeSelect id="status" name="status" defaultValue={status ?? ""}>
            <option value="">All</option>
            {REPORT_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </NativeSelect>
        </div>
        <Button type="submit" variant="secondary">Apply</Button>
        {filtered ? <Button variant="ghost" asChild><Link href="/reports">Reset</Link></Button> : null}
      </form>

      {bundles.length === 0 ? (
        <EmptyState
          icon={FileChartColumn}
          title={filtered ? "No matching reports" : "No reports generated"}
          description={filtered ? "Change the filters." : "Open a finished test run (or the History page) and choose “Generate report”. The worker builds the PDF, HTML and Excel files."}
        />
      ) : (
        <Card className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Report</TableHead>
                <TableHead className="hidden md:table-cell">Project / website</TableHead>
                <TableHead className="hidden lg:table-cell">Test run</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden md:table-cell">Created</TableHead>
                <TableHead><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {bundles.map((b) => (
                <TableRow key={b.id} className="align-top">
                  <TableCell className="min-w-56">
                    <p className="font-medium">{b.name}</p>
                    <p className="text-xs text-muted-foreground">Date: {formatDateTime(b.completedAt ?? b.createdAt)}</p>
                    {b.errorMessage ? (
                      <Alert variant={b.status === "FAILED" ? "destructive" : "warning"} className="mt-2 py-2 text-xs whitespace-pre-line">{b.errorMessage}</Alert>
                    ) : null}
                    <div className="mt-2 flex flex-wrap gap-1.5 md:hidden">
                      <span className="text-xs text-muted-foreground">{b.projectName}</span>
                    </div>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <Link href={`/projects/${b.projectId}`} className="hover:underline">{b.projectName}</Link>
                    <p className="max-w-56 truncate font-mono text-xs text-muted-foreground">{b.website}</p>
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">
                    {b.testRunId ? <Link href={`/test-runs/${b.testRunId}`} className="hover:underline">{b.testRunName}</Link> : <span className="text-muted-foreground">Deleted run</span>}
                  </TableCell>
                  <TableCell><ReportStatusBadge status={b.status} /></TableCell>
                  <TableCell className="hidden whitespace-nowrap text-muted-foreground md:table-cell">{formatDateTime(b.createdAt)}</TableCell>
                  <TableCell>
                    <div className="flex min-w-48 flex-wrap justify-end gap-1.5">
                      <FileLink bundle={b} kind="HTML" view />
                      <FileLink bundle={b} kind="PDF" />
                      <FileLink bundle={b} kind="HTML" />
                      <FileLink bundle={b} kind="TESTING_EXCEL" />
                      <FileLink bundle={b} kind="BUG_EXCEL" />
                      <ConfirmDialog
                        trigger={
                          <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" aria-label={`Delete report ${b.name}`}>
                            <Trash2 />
                          </Button>
                        }
                        title="Delete report?"
                        description={<>This deletes the generated files of <span className="font-medium text-foreground">{b.name}</span>. The test run and its results are kept, so the report can be generated again.</>}
                        action={deleteReportAction}
                        fields={{ bundleId: b.id }}
                        confirmLabel="Delete report"
                        pendingLabel="Deleting…"
                        destructive
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="border-t p-4">
            <Pagination basePath="/reports" params={{ project: projectId, status, q: search }} page={page} pageSize={PAGE_SIZE} total={total} />
          </div>
        </Card>
      )}
    </div>
  );
}
