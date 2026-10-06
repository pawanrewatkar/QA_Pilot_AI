import { Bug } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { ProjectFilter, readProjectParam } from "@/components/shared/project-filter";
import { BugStatusBadge, SeverityBadge } from "@/components/shared/status-badges";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requestDb } from "@/lib/server/db";
import { formatDateTime } from "@/lib/utils";

export const metadata: Metadata = { title: "Bugs" };

export default async function BugsPage({ searchParams }: PageProps<"/bugs">) {
  const projectId = readProjectParam((await searchParams).project);
  const db = await requestDb();
  const [bugs, projects] = await Promise.all([db.bugs.list({ projectId, limit: 500 }), db.projects.list({ sort: "name" })]);

  return (
    <div className="space-y-6">
      <PageHeader title="Bugs" description="Defects raised from failed checks, each linked to the executed result and its captured evidence." />
      <ProjectFilter projects={projects} selected={projectId} basePath="/bugs" />
      {bugs.length === 0 ? (
        <EmptyState icon={Bug} title="No bugs recorded" description="Bugs are only created from checks that actually executed and failed, with screenshots or logs as evidence." />
      ) : (
        <Card className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Title</TableHead>
                <TableHead>Severity</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden md:table-cell">Project</TableHead>
                <TableHead className="hidden lg:table-cell">Page</TableHead>
                <TableHead className="hidden lg:table-cell">Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {bugs.map((b) => (
                <TableRow key={b.id}>
                  <TableCell className="font-medium">{b.title}</TableCell>
                  <TableCell><SeverityBadge severity={b.severity} /></TableCell>
                  <TableCell><BugStatusBadge status={b.status} /></TableCell>
                  <TableCell className="hidden md:table-cell"><Link href={`/projects/${b.projectId}`} className="hover:underline">{b.projectName}</Link></TableCell>
                  <TableCell className="hidden max-w-64 truncate font-mono text-xs lg:table-cell">{b.pageUrl ?? "—"}</TableCell>
                  <TableCell className="hidden text-muted-foreground lg:table-cell">{formatDateTime(b.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
