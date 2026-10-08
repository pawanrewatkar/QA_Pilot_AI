import { FolderKanban, Globe } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { WorkerStatusBanner } from "@/components/shared/worker-status";
import { TestRunForm } from "@/components/test-runs/test-run-form";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { normalizeCrawlUrl } from "@/lib/crawler/normalize";
import { requestDb } from "@/lib/server/db";
import { displayHost } from "@/lib/validation/url";

export const metadata: Metadata = { title: "New test run" };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function NewTestRunPage({ searchParams }: PageProps<"/test-runs/new">) {
  const sp = await searchParams;
  const projectId = first(sp.project);
  const configId = first(sp.config) ?? null;
  const db = await requestDb();

  if (!projectId) {
    const projects = await db.projects.list({ sort: "name" });
    return (
      <div className="space-y-6">
        <PageHeader eyebrow={<Link href="/test-runs" className="hover:underline">Test Runs</Link>} title="New test run" description="Choose the project to test." />
        {projects.length === 0 ? (
          <EmptyState icon={FolderKanban} title="No projects yet" description="Create a project first." action={<Button asChild><Link href="/projects/new">Create project</Link></Button>} />
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {projects.map((p) => (
              <Card key={p.id} className="flex items-center justify-between gap-3 p-4">
                <div className="min-w-0">
                  <p className="truncate font-medium">{p.name}</p>
                  <p className="truncate text-sm text-muted-foreground">{displayHost(p.websiteUrl)} · {p.pageCount} pages</p>
                </div>
                <Button asChild variant="outline" size="sm">
                  <Link href={`/test-runs/new?project=${p.id}`}>Select</Link>
                </Button>
              </Card>
            ))}
          </div>
        )}
      </div>
    );
  }

  const project = await db.projects.getById(projectId);
  if (!project) notFound();
  const [configurations, pages, worker] = await Promise.all([
    db.testConfigurations.listByProject(project.id),
    db.pages.list({ projectId: project.id, limit: 5000 }),
    db.workers.status(),
  ]);

  const testable = pages.filter((p) => p.crawlStatus !== "FAILED" && p.crawlStatus !== "SKIPPED");
  const byNormalized = new Map(testable.map((p) => [normalizeCrawlUrl(p.url), p.id]));
  const configurationPages: Record<string, string[]> = {};
  for (const c of configurations) {
    if (c.scope === "SELECTED_PAGES") configurationPages[c.id] = c.selectedPageIds.filter((id) => testable.some((p) => p.id === id));
    else if (c.scope === "MANUAL_URLS") configurationPages[c.id] = c.manualUrls.map((u) => byNormalized.get(normalizeCrawlUrl(u))).filter((id): id is string => !!id);
    else configurationPages[c.id] = testable.filter((p) => p.isSelected).map((p) => p.id);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <>
            <Link href="/test-runs" className="hover:underline">Test Runs</Link> / <Link href={`/projects/${project.id}`} className="hover:underline">{project.name}</Link>
          </>
        }
        title="New test run"
        description={`Executes real browser tests against ${displayHost(project.websiteUrl)}. Results appear live as each check completes.`}
      />
      <WorkerStatusBanner initial={worker} />
      {testable.length === 0 ? (
        <EmptyState
          icon={Globe}
          title="No pages to test yet"
          description="Crawl the website or add URLs manually before starting a test run."
          action={<Button asChild><Link href={`/projects/${project.id}/pages`}>Go to Pages &amp; crawl</Link></Button>}
        />
      ) : (
        <TestRunForm
          project={{ id: project.id, name: project.name, hasTestEmail: project.testEmail !== null }}
          configurations={configurations}
          pages={pages}
          configurationPages={configurationPages}
          initialConfigurationId={configId}
        />
      )}
    </div>
  );
}
