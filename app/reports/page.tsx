import { FileChartColumn } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { ProjectFilter, readProjectParam } from "@/components/shared/project-filter";
import { ReportStatusBadge } from "@/components/shared/status-badges";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requestDb } from "@/lib/server/db";
import { formatBytes, formatDateTime } from "@/lib/utils";

export const metadata: Metadata = { title: "Reports" };

export default async function ReportsPage({ searchParams }: PageProps<"/reports">) {
  const projectId = readProjectParam((await searchParams).project);
  const db = await requestDb();
  const [reports, projects] = await Promise.all([db.reports.list({ projectId, limit: 200 }), db.projects.list({ sort: "name" })]);

  return (
    <div className="space-y-6">
      <PageHeader title="Reports" description="Excel, PDF and other reports generated from completed test runs." />
      <ProjectFilter projects={projects} selected={projectId} basePath="/reports" />
      {reports.length === 0 ? (
        <EmptyState
          icon={FileChartColumn}
          title="No reports generated"
          description="Reports are generated from completed runs using the formats chosen in each test configuration. Report generation is enabled in a later phase."
        />
      ) : (
        <Card className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>File</TableHead>
                <TableHead>Format</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden md:table-cell">Project</TableHead>
                <TableHead className="hidden md:table-cell">Size</TableHead>
                <TableHead className="hidden lg:table-cell">Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {reports.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">{r.fileName ?? "—"}</TableCell>
                  <TableCell><Badge variant="secondary">{r.format}</Badge></TableCell>
                  <TableCell><ReportStatusBadge status={r.status} /></TableCell>
                  <TableCell className="hidden md:table-cell"><Link href={`/projects/${r.projectId}`} className="hover:underline">{r.projectName}</Link></TableCell>
                  <TableCell className="hidden tabular-nums md:table-cell">{formatBytes(r.sizeBytes)}</TableCell>
                  <TableCell className="hidden text-muted-foreground lg:table-cell">{formatDateTime(r.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
