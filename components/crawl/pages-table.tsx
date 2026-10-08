"use client";

import { CircleAlert, CircleCheck, ExternalLink, FileText, Plus, Search } from "lucide-react";
import { useActionState, useMemo, useOptimistic, useState, useTransition } from "react";
import { addManualUrlsAction, setPagesSelectedAction, type ManualUrlState } from "@/app/projects/[id]/pages/actions";
import { EmptyState } from "@/components/shared/empty-state";
import { SubmitButton } from "@/components/shared/submit-button";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input, Label, NativeSelect, Textarea } from "@/components/ui/form-controls";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PAGE_CRAWL_STATUSES, PAGE_TYPE_LABELS, PAGE_TYPES, type PageCrawlStatus, type PageRecord, type PageType } from "@/types";

const STATUS_VARIANT: Record<PageCrawlStatus, NonNullable<BadgeProps["variant"]>> = {
  CRAWLED: "success",
  DISCOVERED: "secondary",
  FAILED: "destructive",
  SKIPPED: "muted",
};

const SOURCE_LABEL: Record<string, string> = {
  start: "Start URL",
  header: "Header",
  navigation: "Navigation",
  footer: "Footer",
  cta: "CTA",
  button: "Button",
  breadcrumb: "Breadcrumb",
  pagination: "Pagination",
  content: "Content",
  sitemap: "Sitemap",
  "robots-sitemap": "robots.txt sitemap",
  redirect: "Redirect",
  manual: "Manual",
};

export function PagesTable({ projectId, pages, websiteHost }: { projectId: string; pages: PageRecord[]; websiteHost: string }) {
  const [search, setSearch] = useState("");
  const [type, setType] = useState<PageType | "">("");
  const [status, setStatus] = useState<PageCrawlStatus | "">("");
  const [, startTransition] = useTransition();
  const [optimistic, applyOptimistic] = useOptimistic(pages, (state: PageRecord[], change: { ids: Set<string>; selected: boolean }) =>
    state.map((p) => (change.ids.has(p.id) ? { ...p, isSelected: change.selected } : p)),
  );
  const [manual, manualAction] = useActionState<ManualUrlState, FormData>(addManualUrlsAction.bind(null, projectId), { error: null, message: null });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return optimistic.filter(
      (p) => (!type || p.pageType === type) && (!status || p.crawlStatus === status) && (!q || `${p.url} ${p.name ?? ""} ${p.title ?? ""}`.toLowerCase().includes(q)),
    );
  }, [optimistic, search, type, status]);

  const selectedCount = optimistic.filter((p) => p.isSelected && p.crawlStatus !== "FAILED" && p.crawlStatus !== "SKIPPED").length;
  const typeCounts = useMemo(() => {
    const m = new Map<PageType, number>();
    for (const p of optimistic) m.set(p.pageType, (m.get(p.pageType) ?? 0) + 1);
    return m;
  }, [optimistic]);

  const setSelected = (ids: string[], selected: boolean) => {
    if (!ids.length) return;
    startTransition(async () => {
      applyOptimistic({ ids: new Set(ids), selected });
      await setPagesSelectedAction(projectId, ids, selected);
    });
  };

  const allShownSelected = filtered.length > 0 && filtered.every((p) => p.isSelected);
  const someShownSelected = filtered.some((p) => p.isSelected);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle>Discovered pages</CardTitle>
            <CardDescription>
              {optimistic.length} pages · <span className="font-medium text-foreground">{selectedCount} selected for testing</span>. Selected pages are used when a run uses the
              “Entire Website” scope.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto_auto]">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input aria-label="Search pages" placeholder="Search URL, name or title" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" type="search" />
            </div>
            <NativeSelect aria-label="Filter by page type" value={type} onChange={(e) => setType(e.target.value as PageType | "")}>
              <option value="">All page types</option>
              {PAGE_TYPES.filter((t) => typeCounts.has(t)).map((t) => (
                <option key={t} value={t}>
                  {PAGE_TYPE_LABELS[t]} ({typeCounts.get(t)})
                </option>
              ))}
            </NativeSelect>
            <NativeSelect aria-label="Filter by crawl status" value={status} onChange={(e) => setStatus(e.target.value as PageCrawlStatus | "")}>
              <option value="">All statuses</option>
              {PAGE_CRAWL_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s.charAt(0) + s.slice(1).toLowerCase()}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">{filtered.length} shown</span>
            <Button variant="outline" size="sm" onClick={() => setSelected(filtered.filter((p) => !p.isSelected).map((p) => p.id), true)} disabled={allShownSelected}>
              Select shown
            </Button>
            <Button variant="outline" size="sm" onClick={() => setSelected(filtered.filter((p) => p.isSelected).map((p) => p.id), false)} disabled={!someShownSelected}>
              Deselect shown
            </Button>
          </div>

          {optimistic.length === 0 ? (
            <EmptyState icon={FileText} title="No pages yet" description="Start a crawl to discover pages automatically, or add URLs manually below." compact />
          ) : filtered.length === 0 ? (
            <EmptyState icon={Search} title="No matching pages" description="Change the search or filters." compact />
          ) : (
            <div className="overflow-hidden rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-10">
                      <Checkbox
                        aria-label="Select all shown pages"
                        checked={allShownSelected ? true : someShownSelected ? "indeterminate" : false}
                        onCheckedChange={(c) => setSelected(filtered.filter((p) => p.isSelected !== (c === true)).map((p) => p.id), c === true)}
                      />
                    </TableHead>
                    <TableHead>Page</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="hidden md:table-cell">HTTP</TableHead>
                    <TableHead className="hidden lg:table-cell">Found via</TableHead>
                    <TableHead className="hidden lg:table-cell">Depth</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((p) => (
                    <TableRow key={p.id} data-state={p.isSelected ? "selected" : undefined}>
                      <TableCell>
                        <Checkbox aria-label={`Select ${p.url}`} checked={p.isSelected} onCheckedChange={(c) => setSelected([p.id], c === true)} />
                      </TableCell>
                      <TableCell className="max-w-[28rem]">
                        <p className="truncate font-medium">{p.name ?? p.title ?? "—"}</p>
                        <a href={p.url} target="_blank" rel="noopener noreferrer" className="inline-flex max-w-full items-center gap-1 truncate font-mono text-xs text-muted-foreground hover:text-foreground">
                          <span className="truncate">{p.url.replace(/^https?:\/\//, "")}</span>
                          <ExternalLink className="size-3 shrink-0" aria-hidden />
                          <span className="sr-only">(opens in new tab)</span>
                        </a>
                        {p.description ? <p className="truncate text-xs text-muted-foreground">{p.description}</p> : null}
                        {p.errorMessage ? <p className="truncate text-xs text-destructive-text">{p.errorMessage}</p> : null}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary" title={p.pageTypeConfidence !== null ? `Confidence ${Math.round(p.pageTypeConfidence * 100)}%` : undefined}>
                          {PAGE_TYPE_LABELS[p.pageType]}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={STATUS_VARIANT[p.crawlStatus]}>{p.crawlStatus.charAt(0) + p.crawlStatus.slice(1).toLowerCase()}</Badge>
                      </TableCell>
                      <TableCell className="hidden tabular-nums md:table-cell">{p.httpStatus ?? "—"}</TableCell>
                      <TableCell className="hidden max-w-48 lg:table-cell">
                        <span className="text-xs text-muted-foreground">{p.discoverySources.map((s) => SOURCE_LABEL[s] ?? s).join(", ") || "—"}</span>
                      </TableCell>
                      <TableCell className="hidden tabular-nums lg:table-cell">{p.depth ?? "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Add URLs manually</CardTitle>
          <CardDescription>One per line. URLs must be on {websiteHost} (or its subdomains). Added pages are selected for testing.</CardDescription>
        </CardHeader>
        <CardContent>
          <form action={manualAction} className="grid gap-3">
            <Label htmlFor="manual-urls" className="sr-only">
              URLs
            </Label>
            <Textarea id="manual-urls" name="urls" rows={3} className="font-mono text-xs" placeholder={`https://${websiteHost}/landing-page`} aria-invalid={!!manual.error} />
            {manual.error ? (
              <Alert variant="destructive">
                <CircleAlert />
                <AlertTitle className="whitespace-pre-line">{manual.error}</AlertTitle>
              </Alert>
            ) : manual.message ? (
              <Alert variant="success">
                <CircleCheck />
                <AlertTitle>{manual.message}</AlertTitle>
              </Alert>
            ) : null}
            <div className="flex justify-end">
              <SubmitButton variant="secondary" pendingLabel="Adding…">
                <Plus /> Add URLs
              </SubmitButton>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
