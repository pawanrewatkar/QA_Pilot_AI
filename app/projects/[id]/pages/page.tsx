import { CirclePlay } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CrawlPanel } from "@/components/crawl/crawl-panel";
import { PagesTable } from "@/components/crawl/pages-table";
import { PageHeader } from "@/components/shared/page-header";
import { WorkerStatusBanner } from "@/components/shared/worker-status";
import { Button } from "@/components/ui/button";
import { requestDb } from "@/lib/server/db";

export const metadata: Metadata = { title: "Pages & crawl" };

export default async function ProjectPagesPage({ params }: PageProps<"/projects/[id]/pages">) {
  const { id } = await params;
  const db = await requestDb();
  const project = await db.projects.getById(id);
  if (!project) notFound();
  const [latest, pages, worker] = await Promise.all([db.crawlRuns.latest(id), db.pages.list({ projectId: id, limit: 5000 }), db.workers.status()]);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <>
            <Link href="/projects" className="hover:underline">Projects</Link> /{" "}
            <Link href={`/projects/${id}`} className="hover:underline">{project.name}</Link>
          </>
        }
        title="Pages & crawl"
        description="Discover the website's pages, review their detected types, and choose which ones to test."
        actions={
          <Button asChild disabled={pages.length === 0}>
            <Link href={`/test-runs/new?project=${id}`}>
              <CirclePlay /> New test run
            </Link>
          </Button>
        }
      />
      <WorkerStatusBanner initial={worker} />
      <CrawlPanel projectId={id} websiteUrl={project.websiteUrl} latest={latest} />
      <PagesTable projectId={id} pages={pages} websiteHost={new URL(project.websiteUrl).host} />
    </div>
  );
}
