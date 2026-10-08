import { normalizeCrawlUrl } from "@/lib/crawler/normalize";
import type { DatabaseProvider } from "@/lib/database/provider";
import { parseCrawlConfig, type CrawlFieldErrors } from "@/lib/validation/crawl";
import { parseManualUrls } from "@/lib/validation/test-config";
import { parseTestRunForm, type TestRunFieldErrors } from "@/lib/validation/test-run";
import type { CrawlRun, TestRun } from "@/types";

/** Crawl and test-run use-cases shared by server actions and tests. */

export async function startCrawl(db: DatabaseProvider, projectId: string, raw: Record<string, unknown>): Promise<{ ok: true; crawl: CrawlRun } | { ok: false; errors: CrawlFieldErrors }> {
  const project = await db.projects.getById(projectId);
  if (!project) return { ok: false, errors: { form: "Project not found." } };
  const latest = await db.crawlRuns.latest(projectId);
  if (latest && (latest.status === "PENDING" || latest.status === "RUNNING")) {
    return { ok: false, errors: { form: "A crawl is already in progress for this project." } };
  }
  const parsed = parseCrawlConfig(raw);
  if (!parsed.ok) return parsed;
  const crawl = await db.crawlRuns.createAndEnqueue(projectId, project.websiteUrl, parsed.config);
  await db.activity.record({
    projectId,
    entityType: "crawl",
    entityId: crawl.id,
    action: "started",
    summary: `Crawl queued for ${project.websiteUrl} (depth ${parsed.config.maxDepth}, up to ${parsed.config.maxPages} pages)`,
  });
  return { ok: true, crawl };
}

export async function addManualPages(db: DatabaseProvider, projectId: string, text: string): Promise<{ ok: true; added: number; existing: number } | { ok: false; error: string }> {
  const project = await db.projects.getById(projectId);
  if (!project) return { ok: false, error: "Project not found." };
  const { urls, errors } = parseManualUrls(text, project.websiteUrl);
  if (errors.length) return { ok: false, error: errors.slice(0, 5).join("\n") };
  if (!urls.length) return { ok: false, error: "Enter at least one URL." };
  let added = 0;
  let existing = 0;
  for (const url of urls) {
    const normalized = normalizeCrawlUrl(url);
    if (!normalized) continue;
    const r = await db.pages.addManual(projectId, url, normalized);
    if (r.created) added++;
    else existing++;
  }
  if (added) await db.activity.record({ projectId, entityType: "page", entityId: null, action: "created", summary: `${added} page${added === 1 ? "" : "s"} added manually` });
  return { ok: true, added, existing };
}

export async function createTestRun(db: DatabaseProvider, raw: unknown): Promise<{ ok: true; run: TestRun } | { ok: false; errors: TestRunFieldErrors }> {
  const parsed = parseTestRunForm(raw);
  if (!parsed.ok) return parsed;
  const form = parsed.data;
  const project = await db.projects.getById(form.projectId);
  if (!project) return { ok: false, errors: { projectId: "Project not found." } };

  const pages = await db.pages.getByIds(project.id, form.pageIds);
  if (pages.length !== form.pageIds.length) return { ok: false, errors: { pageIds: "One or more selected pages no longer belong to this project." } };

  let configurationName: string | null = null;
  if (form.configurationId) {
    const config = await db.testConfigurations.getById(form.configurationId);
    if (!config || config.projectId !== project.id) return { ok: false, errors: { configurationId: "Configuration not found for this project." } };
    configurationName = config.name;
  }

  const run = await db.testRuns.createAndEnqueue({
    projectId: project.id,
    configurationId: form.configurationId,
    name: form.name,
    modules: form.modules,
    browsers: form.browsers,
    viewports: form.viewports,
    pageIds: pages.map((p) => p.id),
    configurationName,
    options: {
      allowFormSubmission: form.allowFormSubmission,
      maxLinksPerPage: form.maxLinksPerPage,
      navigationTimeoutMs: form.navigationTimeoutSeconds * 1000,
      typographyMode: form.typographyMode,
      content: { mode: form.contentMode, exclusions: [...new Set(form.contentExclusions)], customSelectors: form.contentCustomSelectors },
      performance: { formFactors: form.performanceFormFactors.length ? [...new Set(form.performanceFormFactors)] : ["desktop"] },
      reports: { formats: form.reportFormats },
    },
  });
  await db.activity.record({
    projectId: project.id,
    entityType: "test_run",
    entityId: run.id,
    action: "created",
    summary: `Test run queued: ${pages.length} pages × ${form.browsers.length} browsers × ${form.viewports.length} viewports, ${form.modules.length} modules${form.allowFormSubmission ? " (real form submissions allowed)" : ""}`,
  });
  return { ok: true, run };
}
