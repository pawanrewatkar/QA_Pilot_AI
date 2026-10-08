"use client";

import { CircleAlert, CircleCheck, Globe, LoaderCircle, Square } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useId } from "react";
import { cancelCrawlAction, startCrawlAction, type CrawlFormState } from "@/app/projects/[id]/pages/actions";
import { RunStatusBadge } from "@/components/shared/status-badges";
import { SubmitButton } from "@/components/shared/submit-button";
import { usePolling } from "@/components/shared/use-polling";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, Input, Label, NativeSelect, Textarea } from "@/components/ui/form-controls";
import { Progress } from "@/components/ui/progress";
import { CRAWL_LIMITS, DEFAULT_CRAWL_CONFIG } from "@/lib/constants/crawl";
import { formatDateTime } from "@/lib/utils";
import type { CrawlRun } from "@/types";

const ACTIVE = new Set(["PENDING", "RUNNING"]);

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function CrawlProgress({ initial }: { initial: CrawlRun }) {
  const router = useRouter();
  const { data: crawl, error } = usePolling<CrawlRun>(`/api/crawl-runs/${initial.id}`, {
    initial,
    active: ACTIVE.has(initial.status),
    intervalMs: 1200,
    isDone: (c) => !ACTIVE.has(c.status),
  });
  const done = !ACTIVE.has(crawl.status);
  useEffect(() => {
    if (done && ACTIVE.has(initial.status)) router.refresh();
  }, [done, initial.status, router]);

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2">
            {done ? <Globe className="size-4 text-muted-foreground" aria-hidden /> : <LoaderCircle className="size-4 animate-spin text-primary" aria-hidden />}
            {done ? "Last crawl" : crawl.status === "PENDING" ? "Crawl queued" : "Crawling…"}
          </CardTitle>
          <CardDescription>
            {crawl.resolvedStartUrl ?? crawl.startUrl} · started {formatDateTime(crawl.startedAt ?? crawl.createdAt)}
            {crawl.completedAt ? ` · finished ${formatDateTime(crawl.completedAt)}` : ""}
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <RunStatusBadge status={crawl.status} />
          {!done ? (
            <form action={cancelCrawlAction}>
              <input type="hidden" name="crawlRunId" value={crawl.id} />
              <input type="hidden" name="projectId" value={crawl.projectId} />
              <SubmitButton variant="outline" size="sm" disabled={crawl.cancelRequested} pendingLabel="Stopping…">
                <Square /> {crawl.cancelRequested ? "Stopping…" : "Stop crawl"}
              </SubmitButton>
            </form>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-4" aria-live="polite">
        {!done ? <Progress value={crawl.pagesCrawled + crawl.pagesFailed} max={Math.max(crawl.pagesDiscovered, 1)} label="Crawl progress" /> : null}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Stat label="Discovered" value={crawl.pagesDiscovered} />
          <Stat label="Crawled" value={crawl.pagesCrawled} />
          <Stat label="Failed" value={crawl.pagesFailed} />
          <Stat label="Skipped" value={crawl.pagesSkipped} />
          <Stat label="Depth" value={`${crawl.currentDepth} / ${crawl.config.maxDepth}`} />
        </div>
        {!done && crawl.currentUrl ? (
          <p className="truncate text-sm text-muted-foreground">
            Current URL: <span className="font-mono text-xs text-foreground">{crawl.currentUrl}</span>
          </p>
        ) : null}
        {crawl.status === "PENDING" ? <p className="text-sm text-muted-foreground">Waiting for the worker to pick up this crawl…</p> : null}
        {crawl.status === "COMPLETED" ? (
          <Alert variant="success">
            <CircleCheck />
            <AlertTitle>
              Crawl completed: {crawl.pagesCrawled} pages crawled, {crawl.pagesFailed} failed, {crawl.pagesSkipped} skipped (deepest level {crawl.maxDepthReached}).
            </AlertTitle>
          </Alert>
        ) : null}
        {crawl.status === "FAILED" ? (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertTitle>Crawl failed: {crawl.errorMessage}</AlertTitle>
          </Alert>
        ) : null}
        {crawl.status === "CANCELLED" ? <p className="text-sm text-muted-foreground">The crawl was stopped. Pages found before stopping are kept.</p> : null}
        {error && !done ? <p className="text-xs text-destructive-text">Progress update failed: {error}</p> : null}
      </CardContent>
    </Card>
  );
}

function CrawlConfigForm({ projectId, websiteUrl }: { projectId: string; websiteUrl: string }) {
  const uid = useId();
  const [state, action] = useActionState<CrawlFormState, FormData>(startCrawlAction.bind(null, projectId), { errors: {}, startedId: null });
  const e = state.errors;
  const id = (n: string) => `${uid}-${n}`;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Crawl configuration</CardTitle>
        <CardDescription>
          Discovers pages on <span className="font-medium text-foreground">{new URL(websiteUrl).host}</span> through navigation, header, footer, CTA,
          breadcrumb and pagination links, navigating buttons, robots.txt and sitemap.xml. The crawler stays on this site and never follows logout or delete links.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} className="grid gap-5" noValidate>
          {e.form ? (
            <Alert variant="destructive">
              <CircleAlert />
              <AlertTitle>{e.form}</AlertTitle>
            </Alert>
          ) : null}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field id={id("depth")} label="Maximum depth" required error={e.maxDepth} hint={`Link hops from the start page (0–${CRAWL_LIMITS.maxDepth}).`}>
              <Input id={id("depth")} name="maxDepth" type="number" min={0} max={CRAWL_LIMITS.maxDepth} defaultValue={DEFAULT_CRAWL_CONFIG.maxDepth} />
            </Field>
            <Field id={id("pages")} label="Maximum pages" required error={e.maxPages} hint={`Up to ${CRAWL_LIMITS.maxPages}.`}>
              <Input id={id("pages")} name="maxPages" type="number" min={1} max={CRAWL_LIMITS.maxPages} defaultValue={DEFAULT_CRAWL_CONFIG.maxPages} />
            </Field>
            <Field id={id("timeout")} label="Page timeout (seconds)" required error={e.timeoutSeconds}>
              <Input id={id("timeout")} name="timeoutSeconds" type="number" min={5} max={120} defaultValue={DEFAULT_CRAWL_CONFIG.timeoutMs / 1000} />
            </Field>
            <Field id={id("retries")} label="Retries per page" required error={e.retries} hint="For timeouts and connection errors.">
              <Input id={id("retries")} name="retries" type="number" min={0} max={CRAWL_LIMITS.maxRetries} defaultValue={DEFAULT_CRAWL_CONFIG.retries} />
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field id={id("excl")} label="Exclusions" error={e.exclusions} hint="One per line. Substring (e.g. /tag/) or wildcard (e.g. /blog/*/comments).">
              <Textarea id={id("excl")} name="exclusions" rows={4} className="font-mono text-xs" placeholder={"/wp-admin\n/tag/\n*?replytocom=*"} />
            </Field>
            <div className="grid content-start gap-4">
              <Field id={id("query")} label="Query parameters" required error={e.queryParams} hint="How URLs that differ only by query string are treated.">
                <NativeSelect id={id("query")} name="queryParams" defaultValue={DEFAULT_CRAWL_CONFIG.queryParams}>
                  <option value="strip-tracking">Ignore tracking parameters (utm_*, gclid, …)</option>
                  <option value="keep">Keep all parameters</option>
                  <option value="strip-all">Ignore all parameters</option>
                </NativeSelect>
              </Field>
              <fieldset className="grid gap-2.5">
                <legend className="mb-1 text-sm font-medium">Rules</legend>
                <div className="flex items-center gap-2">
                  <Checkbox id={id("robots")} name="respectRobotsTxt" defaultChecked />
                  <Label htmlFor={id("robots")} className="font-normal">Respect robots.txt</Label>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox id={id("sitemap")} name="useSitemap" defaultChecked />
                  <Label htmlFor={id("sitemap")} className="font-normal">Use sitemap.xml</Label>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox id={id("subs")} name="includeSubdomains" />
                  <Label htmlFor={id("subs")} className="font-normal">Include subdomains</Label>
                </div>
                <p className="text-xs text-muted-foreground">Same-domain restriction is always on.</p>
              </fieldset>
            </div>
          </div>
          <div className="flex justify-end">
            <SubmitButton pendingLabel="Queuing…">
              <Globe /> Start crawl
            </SubmitButton>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export function CrawlPanel({ projectId, websiteUrl, latest }: { projectId: string; websiteUrl: string; latest: CrawlRun | null }) {
  const active = latest && ACTIVE.has(latest.status);
  return (
    <div className="space-y-4">
      {latest ? <CrawlProgress key={`${latest.id}-${latest.status}-${latest.cancelRequested}`} initial={latest} /> : null}
      {!active ? <CrawlConfigForm projectId={projectId} websiteUrl={websiteUrl} /> : null}
    </div>
  );
}
