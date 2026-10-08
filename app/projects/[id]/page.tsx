import { Bug, CircleCheck, CirclePlay, Download, ExternalLink, FileText, Globe, Info, Pencil, Plus, Settings2 } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { RunStatusBadge, SeverityBadge, BugStatusBadge } from "@/components/shared/status-badges";
import { DeleteProjectDialog } from "@/components/projects/delete-project-dialog";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TEST_SCOPE_OPTIONS } from "@/lib/constants/testing";
import { requestDb } from "@/lib/server/db";
import { formatBytes, formatDateTime, pluralize } from "@/lib/utils";
import { PAGE_TYPE_LABELS } from "@/types";

export async function generateMetadata({ params }: PageProps<"/projects/[id]">): Promise<Metadata> {
  const { id } = await params;
  const project = await (await requestDb()).projects.getById(id);
  return { title: project?.name ?? "Project not found" };
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1 py-3 sm:grid-cols-[180px_1fr] sm:gap-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm break-words">{children}</dd>
    </div>
  );
}

const notSet = <span className="text-muted-foreground">Not provided</span>;

export default async function ProjectDetailPage({ params, searchParams }: PageProps<"/projects/[id]">) {
  const { id } = await params;
  const sp = await searchParams;
  const db = await requestDb();
  const project = await db.projects.getById(id);
  if (!project) notFound();

  const [configurations, runs, pages, bugs] = await Promise.all([
    db.testConfigurations.listByProject(id),
    db.testRuns.list({ projectId: id, limit: 20 }),
    db.pages.list({ projectId: id, limit: 50 }),
    db.bugs.list({ projectId: id, limit: 20 }),
  ]);

  const banner = sp.created ? "Project created." : sp.updated ? "Project updated." : null;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<Link href="/projects" className="hover:underline">Projects</Link>}
        title={project.name}
        description={
          <a href={project.websiteUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:text-foreground">
            {project.websiteUrl} <ExternalLink className="size-3" aria-hidden />
            <span className="sr-only">(opens in new tab)</span>
          </a>
        }
        actions={
          <>
            <Button variant="outline" asChild>
              <Link href={`/projects/${id}/edit`}>
                <Pencil /> Edit
              </Link>
            </Button>
            <DeleteProjectDialog projectId={id} projectName={project.name} />
            <Button variant="outline" asChild>
              <Link href={`/projects/${id}/configure`}>
                <Settings2 /> Configure tests
              </Link>
            </Button>
            <Button variant="outline" asChild>
              <Link href={`/projects/${id}/pages`}>
                <Globe /> Pages &amp; crawl
              </Link>
            </Button>
            <Button asChild>
              <Link href={`/test-runs/new?project=${id}`}>
                <CirclePlay /> New test run
              </Link>
            </Button>
          </>
        }
      />

      {banner ? (
        <Alert variant="success">
          <CircleCheck />
          <AlertTitle>{banner}</AlertTitle>
        </Alert>
      ) : null}

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="configurations">Configurations ({configurations.length})</TabsTrigger>
          <TabsTrigger value="runs">Runs ({runs.length})</TabsTrigger>
          <TabsTrigger value="pages">Pages ({project.pageCount})</TabsTrigger>
          <TabsTrigger value="bugs">Bugs ({bugs.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>Project details</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="divide-y">
                <DetailRow label="Website URL">{project.websiteUrl}</DetailRow>
                <DetailRow label="Description">{project.description ? <span className="whitespace-pre-line">{project.description}</span> : notSet}</DetailRow>
                <DetailRow label="Figma URL">
                  {project.figmaUrl ? (
                    <a href={project.figmaUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{project.figmaUrl}</a>
                  ) : (
                    notSet
                  )}
                </DetailRow>
                <DetailRow label="Reference document">
                  {project.referenceDocument ? (
                    <span className="flex flex-wrap items-center gap-2">
                      <FileText className="size-4 text-muted-foreground" aria-hidden />
                      {project.referenceDocument.fileName}
                      <span className="text-muted-foreground">({formatBytes(project.referenceDocument.sizeBytes)})</span>
                      <a href={`/api/documents/${project.referenceDocument.id}`} className="inline-flex items-center gap-1 text-primary hover:underline">
                        <Download className="size-3.5" aria-hidden /> Download
                      </a>
                    </span>
                  ) : (
                    notSet
                  )}
                </DetailRow>
                <DetailRow label="Test email">{project.testEmail ?? notSet}</DetailRow>
                <DetailRow label="Created">{formatDateTime(project.createdAt)}</DetailRow>
                <DetailRow label="Last updated">{formatDateTime(project.updatedAt)}</DetailRow>
              </dl>
            </CardContent>
          </Card>
          <div className="grid content-start gap-4">
            <Card>
              <CardHeader>
                <CardTitle>Summary</CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-3 text-sm">
                <div><p className="text-muted-foreground">Configurations</p><p className="text-xl font-semibold tabular-nums">{configurations.length}</p></div>
                <div><p className="text-muted-foreground">Test runs</p><p className="text-xl font-semibold tabular-nums">{project.testRunCount}</p></div>
                <div><p className="text-muted-foreground">Pages</p><p className="text-xl font-semibold tabular-nums">{project.pageCount}</p></div>
                <div><p className="text-muted-foreground">Open bugs</p><p className="text-xl font-semibold tabular-nums">{project.openBugCount}</p></div>
              </CardContent>
            </Card>
            <Alert>
              <Info />
              <div>
                <AlertTitle>How testing works</AlertTitle>
                <p className="mt-1 text-muted-foreground">
                  Crawl the site on <Link href={`/projects/${id}/pages`} className="text-primary underline underline-offset-2">Pages &amp; crawl</Link>, then start a test run. Results only appear for checks the browser actually executed.
                </p>
              </div>
            </Alert>
          </div>
        </TabsContent>

        <TabsContent value="configurations">
          {configurations.length === 0 ? (
            <EmptyState
              icon={Settings2}
              title="No test configurations"
              description="Choose scope, modules, browsers, viewports and report options for this project."
              action={<Button asChild><Link href={`/projects/${id}/configure`}><Plus /> New configuration</Link></Button>}
            />
          ) : (
            <Card className="overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Name</TableHead>
                    <TableHead>Scope</TableHead>
                    <TableHead className="hidden md:table-cell">Coverage</TableHead>
                    <TableHead className="hidden lg:table-cell">Updated</TableHead>
                    <TableHead><span className="sr-only">Actions</span></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {configurations.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell className="font-medium">{c.name}</TableCell>
                      <TableCell><Badge variant="secondary">{TEST_SCOPE_OPTIONS.find((s) => s.id === c.scope)?.label}</Badge></TableCell>
                      <TableCell className="hidden text-muted-foreground md:table-cell">
                        {pluralize(c.modules.length, "module")} · {pluralize(c.browsers.length, "browser")} · {pluralize(c.viewports.length, "viewport")}
                      </TableCell>
                      <TableCell className="hidden text-muted-foreground lg:table-cell">{formatDateTime(c.updatedAt)}</TableCell>
                      <TableCell className="text-right">
                        <Button variant="outline" size="sm" asChild>
                          <Link href={`/projects/${id}/configure?config=${c.id}`}>Edit</Link>
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="runs">
          {runs.length === 0 ? (
            <EmptyState icon={CirclePlay} title="No test runs" description="Start a test run to execute real browser checks on this project's pages." action={<Button asChild><Link href={`/test-runs/new?project=${id}`}><CirclePlay /> New test run</Link></Button>} />
          ) : (
            <Card className="overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Created</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Started</TableHead>
                    <TableHead>Completed</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {runs.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell><Link href={`/test-runs/${r.id}`} className="font-medium hover:underline">{formatDateTime(r.createdAt)}</Link></TableCell>
                      <TableCell><RunStatusBadge status={r.status} /></TableCell>
                      <TableCell>{formatDateTime(r.startedAt)}</TableCell>
                      <TableCell>{formatDateTime(r.completedAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="pages">
          {pages.length === 0 ? (
            <EmptyState icon={FileText} title="No pages discovered" description="Crawl the website or add URLs manually." action={<Button asChild><Link href={`/projects/${id}/pages`}><Globe /> Pages &amp; crawl</Link></Button>} />
          ) : (
            <Card className="overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Page</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>HTTP</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pages.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="max-w-80"><p className="truncate font-medium">{p.name ?? p.title ?? "—"}</p><p className="truncate font-mono text-xs text-muted-foreground">{p.url}</p></TableCell>
                      <TableCell><Badge variant="secondary">{PAGE_TYPE_LABELS[p.pageType]}</Badge></TableCell>
                      <TableCell className="tabular-nums">{p.httpStatus ?? "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="bugs">
          {bugs.length === 0 ? (
            <EmptyState icon={Bug} title="No bugs recorded" description="Bugs are created only from failed checks that were actually executed." />
          ) : (
            <Card className="overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-24">Bug ID</TableHead>
                    <TableHead>Title</TableHead>
                    <TableHead>Severity</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {bugs.map((b) => (
                    <TableRow key={b.id}>
                      <TableCell className="font-mono text-xs"><Link href={`/bugs/${b.id}`} className="hover:underline">{b.code ?? b.id.slice(0, 8)}</Link></TableCell>
                      <TableCell><Link href={`/bugs/${b.id}`} className="hover:underline">{b.title}</Link></TableCell>
                      <TableCell><SeverityBadge severity={b.severity} /></TableCell>
                      <TableCell><BugStatusBadge status={b.status} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
