import { CircleCheck, ExternalLink, FolderKanban, Pencil, Plus, Search, SearchX } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { DeleteProjectDialog } from "@/components/projects/delete-project-dialog";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Label, NativeSelect } from "@/components/ui/form-controls";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requestDb } from "@/lib/server/db";
import { formatDate, pluralize } from "@/lib/utils";
import { displayHost } from "@/lib/validation/url";
import type { ProjectFilter, ProjectSort } from "@/types";

export const metadata: Metadata = { title: "Projects" };

const FILTERS: { id: ProjectFilter; label: string }[] = [
  { id: "all", label: "All projects" },
  { id: "with-figma", label: "With Figma URL" },
  { id: "with-document", label: "With reference document" },
  { id: "with-test-email", label: "With test email" },
  { id: "never-run", label: "Never tested" },
];

const SORTS: { id: ProjectSort; label: string }[] = [
  { id: "updated", label: "Recently updated" },
  { id: "created", label: "Recently created" },
  { id: "name", label: "Name (A–Z)" },
];

function pick<T extends string>(value: string | string[] | undefined, allowed: readonly { id: T }[], fallback: T): T {
  const v = Array.isArray(value) ? value[0] : value;
  return allowed.some((a) => a.id === v) ? (v as T) : fallback;
}

export default async function ProjectsPage({ searchParams }: PageProps<"/projects">) {
  const params = await searchParams;
  const q = (Array.isArray(params.q) ? params.q[0] : params.q)?.slice(0, 200) ?? "";
  const filter = pick(params.filter, FILTERS, "all");
  const sort = pick(params.sort, SORTS, "updated");

  const db = await requestDb();
  const [projects, total] = await Promise.all([db.projects.list({ search: q, filter, sort }), db.projects.count()]);
  const isFiltered = q !== "" || filter !== "all";

  return (
    <div className="space-y-6">
      <PageHeader
        title="Projects"
        description="Each project represents one website and connects its pages, configurations, runs, results, bugs and reports."
        actions={
          <Button asChild>
            <Link href="/projects/new">
              <Plus /> New project
            </Link>
          </Button>
        }
      />

      {params.deleted ? (
        <Alert variant="success">
          <CircleCheck />
          <AlertTitle>Project deleted.</AlertTitle>
        </Alert>
      ) : null}

      {total === 0 ? (
        <EmptyState
          icon={FolderKanban}
          title="No projects yet"
          description="Create a project with the website URL you want to test. You can add a Figma link, reference document and test email later."
          action={
            <Button asChild>
              <Link href="/projects/new">
                <Plus /> Create project
              </Link>
            </Button>
          }
        />
      ) : (
        <>
          <form method="get" role="search" className="grid gap-3 rounded-xl border bg-card p-4 sm:grid-cols-[1fr_auto_auto_auto] sm:items-end">
            <div className="grid gap-1.5">
              <Label htmlFor="q">Search</Label>
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input id="q" name="q" type="search" defaultValue={q} placeholder="Name, URL or description" className="pl-9" />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="filter">Filter</Label>
              <NativeSelect id="filter" name="filter" defaultValue={filter}>
                {FILTERS.map((f) => (
                  <option key={f.id} value={f.id}>{f.label}</option>
                ))}
              </NativeSelect>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="sort">Sort</Label>
              <NativeSelect id="sort" name="sort" defaultValue={sort}>
                {SORTS.map((s) => (
                  <option key={s.id} value={s.id}>{s.label}</option>
                ))}
              </NativeSelect>
            </div>
            <div className="flex gap-2">
              <Button type="submit" variant="secondary">Apply</Button>
              {isFiltered ? (
                <Button variant="ghost" asChild>
                  <Link href="/projects">Reset</Link>
                </Button>
              ) : null}
            </div>
          </form>

          <p className="text-sm text-muted-foreground" aria-live="polite">
            {isFiltered ? `${pluralize(projects.length, "project")} match of ${total}` : pluralize(total, "project")}
          </p>

          {projects.length === 0 ? (
            <EmptyState icon={SearchX} title="No matching projects" description="Try a different search term or filter." action={<Button variant="outline" asChild><Link href="/projects">Clear filters</Link></Button>} />
          ) : (
            <Card className="overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Project</TableHead>
                    <TableHead>Website</TableHead>
                    <TableHead className="hidden md:table-cell">Inputs</TableHead>
                    <TableHead className="hidden sm:table-cell">Runs</TableHead>
                    <TableHead className="hidden lg:table-cell">Updated</TableHead>
                    <TableHead><span className="sr-only">Actions</span></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {projects.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="max-w-64">
                        <Link href={`/projects/${p.id}`} className="font-medium hover:underline">{p.name}</Link>
                        {p.description ? <p className="truncate text-xs text-muted-foreground">{p.description}</p> : null}
                      </TableCell>
                      <TableCell>
                        <a href={p.websiteUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
                          {displayHost(p.websiteUrl)} <ExternalLink className="size-3" aria-hidden />
                          <span className="sr-only">(opens in new tab)</span>
                        </a>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <div className="flex flex-wrap gap-1">
                          {p.figmaUrl ? <Badge variant="secondary">Figma</Badge> : null}
                          {p.referenceDocument ? <Badge variant="secondary">Document</Badge> : null}
                          {p.testEmail ? <Badge variant="secondary">Test email</Badge> : null}
                          {!p.figmaUrl && !p.referenceDocument && !p.testEmail ? <span className="text-xs text-muted-foreground">—</span> : null}
                        </div>
                      </TableCell>
                      <TableCell className="hidden tabular-nums sm:table-cell">{p.testRunCount}</TableCell>
                      <TableCell className="hidden text-muted-foreground lg:table-cell">{formatDate(p.updatedAt)}</TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-1">
                          <Button variant="ghost" size="icon" asChild className="text-muted-foreground">
                            <Link href={`/projects/${p.id}/edit`} aria-label={`Edit ${p.name}`}>
                              <Pencil />
                            </Link>
                          </Button>
                          <DeleteProjectDialog projectId={p.id} projectName={p.name} compact />
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
