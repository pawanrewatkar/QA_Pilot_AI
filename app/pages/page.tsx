import { FileText } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { readProjectParam } from "@/components/shared/project-filter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Label, NativeSelect } from "@/components/ui/form-controls";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requestDb } from "@/lib/server/db";
import { PAGE_CRAWL_STATUSES, PAGE_TYPE_LABELS, PAGE_TYPES, type PageCrawlStatus, type PageType } from "@/types";

export const metadata: Metadata = { title: "Pages" };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function PagesPage({ searchParams }: PageProps<"/pages">) {
  const sp = await searchParams;
  const projectId = readProjectParam(sp.project);
  const pageType = PAGE_TYPES.find((t) => t === first(sp.type)) as PageType | undefined;
  const crawlStatus = PAGE_CRAWL_STATUSES.find((s) => s === first(sp.status)) as PageCrawlStatus | undefined;
  const search = (first(sp.q) ?? "").slice(0, 200);
  const db = await requestDb();
  const [pages, projects] = await Promise.all([db.pages.list({ projectId, pageType, crawlStatus, search, limit: 1000 }), db.projects.list({ sort: "name" })]);
  const filtered = !!(projectId || pageType || crawlStatus || search);

  return (
    <div className="space-y-6">
      <PageHeader title="Pages" description="Pages discovered by the crawler (navigation, sitemap, robots.txt) or added manually, with their detected page type." />
      {projects.length ? (
        <form method="get" className="grid gap-3 rounded-xl border bg-card p-4 sm:grid-cols-2 lg:grid-cols-[1fr_auto_auto_auto_auto] lg:items-end">
          <div className="grid gap-1.5">
            <Label htmlFor="q">Search</Label>
            <Input id="q" name="q" type="search" defaultValue={search} placeholder="URL, name or title" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="project">Project</Label>
            <NativeSelect id="project" name="project" defaultValue={projectId ?? ""}>
              <option value="">All projects</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </NativeSelect>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="type">Page type</Label>
            <NativeSelect id="type" name="type" defaultValue={pageType ?? ""}>
              <option value="">All types</option>
              {PAGE_TYPES.map((t) => <option key={t} value={t}>{PAGE_TYPE_LABELS[t]}</option>)}
            </NativeSelect>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="status">Crawl status</Label>
            <NativeSelect id="status" name="status" defaultValue={crawlStatus ?? ""}>
              <option value="">All</option>
              {PAGE_CRAWL_STATUSES.map((s) => <option key={s} value={s}>{s.charAt(0) + s.slice(1).toLowerCase()}</option>)}
            </NativeSelect>
          </div>
          <div className="flex gap-2">
            <Button type="submit" variant="secondary">Apply</Button>
            {filtered ? <Button variant="ghost" asChild><Link href="/pages">Reset</Link></Button> : null}
          </div>
        </form>
      ) : null}
      {pages.length === 0 ? (
        <EmptyState
          icon={FileText}
          title={filtered ? "No matching pages" : "No pages discovered"}
          description={filtered ? "Change the filters." : "Open a project and use Pages & crawl to discover its pages or add URLs manually."}
          action={!filtered && projects.length ? <Button asChild variant="outline"><Link href={`/projects/${projects[0].id}/pages`}>Pages &amp; crawl</Link></Button> : undefined}
        />
      ) : (
        <Card className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Page</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden md:table-cell">HTTP</TableHead>
                <TableHead className="hidden md:table-cell">Project</TableHead>
                <TableHead className="hidden lg:table-cell">Selected</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pages.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="max-w-96">
                    <p className="truncate font-medium">{p.name ?? p.title ?? "—"}</p>
                    <p className="truncate font-mono text-xs text-muted-foreground">{p.url}</p>
                    {p.errorMessage ? <p className="truncate text-xs text-destructive">{p.errorMessage}</p> : null}
                  </TableCell>
                  <TableCell><Badge variant="secondary">{PAGE_TYPE_LABELS[p.pageType]}</Badge></TableCell>
                  <TableCell className="text-xs">{p.crawlStatus.charAt(0) + p.crawlStatus.slice(1).toLowerCase()}</TableCell>
                  <TableCell className="hidden tabular-nums md:table-cell">{p.httpStatus ?? "—"}</TableCell>
                  <TableCell className="hidden md:table-cell"><Link href={`/projects/${p.projectId}/pages`} className="hover:underline">{p.projectName}</Link></TableCell>
                  <TableCell className="hidden lg:table-cell">{p.isSelected ? "Yes" : "No"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
