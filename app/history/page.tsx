import { History } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { ProjectFilter, readProjectParam } from "@/components/shared/project-filter";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requestDb } from "@/lib/server/db";
import { formatDateTime } from "@/lib/utils";

export const metadata: Metadata = { title: "History" };

const ACTION_VARIANT: Record<string, "success" | "default" | "destructive" | "secondary"> = {
  created: "success",
  updated: "default",
  deleted: "destructive",
};

export default async function HistoryPage({ searchParams }: PageProps<"/history">) {
  const projectId = readProjectParam((await searchParams).project);
  const db = await requestDb();
  const [entries, projects] = await Promise.all([db.activity.list({ projectId, limit: 500 }), db.projects.list({ sort: "name" })]);

  return (
    <div className="space-y-6">
      <PageHeader title="History" description="Audit trail of changes to projects, configurations and, in later phases, test runs and reports." />
      <ProjectFilter projects={projects} selected={projectId} basePath="/history" />
      {entries.length === 0 ? (
        <EmptyState icon={History} title="No history yet" description="Actions such as creating a project or saving a configuration are recorded here." />
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
