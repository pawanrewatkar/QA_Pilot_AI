import { ExternalLink, ListChecks } from "lucide-react";
import Link from "next/link";
import { EmptyState } from "@/components/shared/empty-state";
import { ResultStatusBadge } from "@/components/shared/status-badges";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label, NativeSelect } from "@/components/ui/form-controls";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { DetailColumn, DetailViewDefinition } from "@/lib/constants/detail-views";
import type { DetailRowRecord } from "@/lib/database/provider";
import { cn, formatDateTime } from "@/lib/utils";
import { TEST_RESULT_STATUSES, type TestResultStatus } from "@/types";
import { viewportLabel } from "./results-table";

const SOURCE_LABELS: Record<string, string> = { LOCAL_LIGHTHOUSE: "Local Lighthouse", LOCAL_BROWSER: "Browser timing (fallback)", PAGESPEED: "Google PageSpeed" };

function path(url: string | null) {
  if (!url) return "—";
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

function Cell({ column, value }: { column: DetailColumn; value: string | number | null }) {
  if (value === null || value === undefined || value === "") return <span className="text-muted-foreground">—</span>;
  switch (column.format) {
    case "status":
      return (TEST_RESULT_STATUSES as readonly string[]).includes(String(value)) ? <ResultStatusBadge status={value as TestResultStatus} /> : <span>{String(value)}</span>;
    case "score": {
      const pct = Math.round(Number(value) * 100);
      return <span className={cn("font-medium tabular-nums", pct >= 90 ? "text-success" : pct >= 50 ? "text-warning" : "text-destructive")}>{pct}</span>;
    }
    case "ms":
      return <span className="tabular-nums">{Math.round(Number(value))} ms</span>;
    case "cls":
      return <span className="tabular-nums">{Number(value).toFixed(3)}</span>;
    case "percent":
      return <span className="tabular-nums">{Math.round(Number(value) * 100)}%</span>;
    case "datetime":
      return <span className="whitespace-nowrap">{formatDateTime(String(value))}</span>;
    case "mono":
      return <span className="font-mono text-xs break-all">{String(value).slice(0, 300)}</span>;
    case "link":
      return (
        <a href={String(value)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
          Docs <ExternalLink className="size-3" aria-hidden />
        </a>
      );
    case "json":
      return (
        <details>
          <summary className="cursor-pointer text-xs text-primary">View</summary>
          <pre className="mt-1 max-h-48 max-w-md overflow-auto rounded bg-muted p-2 font-mono text-[11px] whitespace-pre-wrap">{JSON.stringify(JSON.parse(String(value)), null, 2)}</pre>
        </details>
      );
    case "longtext":
      return String(value).length > 160 ? (
        <details>
          <summary className="cursor-pointer">{String(value).slice(0, 160)}…</summary>
          <p className="mt-1 whitespace-pre-wrap">{String(value)}</p>
        </details>
      ) : (
        <span className="whitespace-pre-wrap">{String(value)}</span>
      );
    default:
      return <span>{column.key === "source" ? (SOURCE_LABELS[String(value)] ?? String(value)) : String(value)}</span>;
  }
}

export interface DetailViewProps {
  runId: string;
  view: DetailViewDefinition;
  rows: DetailRowRecord[];
  total: number;
  pages: { id: string; url: string }[];
  browsers: string[];
  viewports: string[];
  filters: { pageId?: string; browser?: string; viewport?: string; status?: string; extra?: string };
}

/** Server-rendered table over one per-check table, with GET filters (works without JavaScript). */
export function DetailView({ runId, view, rows, total, pages, browsers, viewports, filters }: DetailViewProps) {
  const filtered = Object.values(filters).some(Boolean);
  return (
    <Card>
      <CardHeader className="gap-3">
        <CardTitle>{view.label}</CardTitle>
        <CardDescription>{view.description}</CardDescription>
        <form method="get" className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="view" value={view.id} />
          <div className="grid gap-1.5">
            <Label htmlFor="d-page">Page</Label>
            <NativeSelect id="d-page" name="page_id" defaultValue={filters.pageId ?? ""} className="max-w-64">
              <option value="">All pages</option>
              {pages.map((p) => (
                <option key={p.id} value={p.id}>{path(p.url)}</option>
              ))}
            </NativeSelect>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="d-browser">Browser</Label>
            <NativeSelect id="d-browser" name="browser" defaultValue={filters.browser ?? ""}>
              <option value="">All</option>
              {browsers.map((b) => <option key={b} value={b}>{b}</option>)}
            </NativeSelect>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="d-viewport">Viewport</Label>
            <NativeSelect id="d-viewport" name="viewport" defaultValue={filters.viewport ?? ""}>
              <option value="">All</option>
              {viewports.map((v) => <option key={v} value={v}>{viewportLabel(v)}</option>)}
            </NativeSelect>
          </div>
          {view.statusColumn ? (
            <div className="grid gap-1.5">
              <Label htmlFor="d-status">Status</Label>
              <NativeSelect id="d-status" name="status" defaultValue={filters.status ?? ""}>
                <option value="">All</option>
                {TEST_RESULT_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </NativeSelect>
            </div>
          ) : null}
          {view.extraFilter ? (
            <div className="grid gap-1.5">
              <Label htmlFor="d-extra">{view.extraFilter.label}</Label>
              <NativeSelect id="d-extra" name="extra" defaultValue={filters.extra ?? ""}>
                <option value="">All</option>
                {view.extraFilter.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </NativeSelect>
            </div>
          ) : null}
          <Button type="submit" variant="secondary">Apply</Button>
          {filtered ? (
            <Button variant="ghost" asChild>
              <Link href={`/test-runs/${runId}?view=${view.id}`}>Reset</Link>
            </Button>
          ) : null}
        </form>
      </CardHeader>
      <CardContent className="space-y-3 p-0 pb-4">
        <p className="px-5 text-sm text-muted-foreground">
          {total} row{total === 1 ? "" : "s"}
          {filtered ? " match the filters" : ""}
          {total > rows.length ? ` (showing the first ${rows.length})` : ""}.
        </p>
        {rows.length === 0 ? (
          <div className="px-5">
            <EmptyState compact icon={ListChecks} title="No rows" description={filtered ? "Change the filters." : `This run recorded no ${view.label.toLowerCase()} data. Select the module when starting a run.`} />
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Page</TableHead>
                <TableHead className="hidden md:table-cell">Browser / viewport</TableHead>
                {view.columns.map((c) => (
                  <TableHead key={c.key} className={cn(c.secondary && "hidden xl:table-cell")}>{c.label}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={String(r.id)} className="align-top">
                  <TableCell className="max-w-48 truncate font-mono text-xs" title={r.page_url ?? undefined}>{path(r.page_url)}</TableCell>
                  <TableCell className="hidden text-xs whitespace-nowrap text-muted-foreground md:table-cell">
                    {r.browser_name ?? "—"}
                    <br />
                    {r.viewport_id ? viewportLabel(r.viewport_id) : "—"}
                  </TableCell>
                  {view.columns.map((c) => (
                    <TableCell key={c.key} className={cn("max-w-80 text-sm", c.secondary && "hidden xl:table-cell")}>
                      <Cell column={c} value={(r as Record<string, string | number | null>)[c.key] ?? null} />
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

export function DetailTabs({ runId, active, counts }: { runId: string; active: string; counts: { id: string; label: string; total: number }[] }) {
  return (
    <nav aria-label="Result views" className="flex gap-1 overflow-x-auto rounded-lg bg-muted p-1">
      {counts.map((t) => (
        <Link
          key={t.id}
          href={t.id === "results" ? `/test-runs/${runId}` : `/test-runs/${runId}?view=${t.id}`}
          aria-current={active === t.id ? "page" : undefined}
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium whitespace-nowrap transition-colors hover:text-foreground",
            active === t.id ? "bg-card text-foreground shadow-xs" : "text-muted-foreground",
          )}
        >
          {t.label}
          <Badge variant="muted" className="px-1.5">{t.total}</Badge>
        </Link>
      ))}
    </nav>
  );
}
