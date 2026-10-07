import { GitCompareArrows } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Pagination, readPage } from "@/components/shared/pagination";
import { BugStatusBadge, ResultStatusBadge, SeverityBadge } from "@/components/shared/status-badges";
import { moduleLabel, viewportLabel } from "@/components/test-runs/results-table";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label, NativeSelect } from "@/components/ui/form-controls";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CATEGORY_LABELS, REGRESSION_CATEGORIES, type Direction, type FindingSetComparison, type RegressionCategory } from "@/lib/regression/compare";
import { requestDb } from "@/lib/server/db";
import { cn, formatDateTime } from "@/lib/utils";
import type { BugRecord } from "@/types";

export const metadata: Metadata = { title: "Compare runs" };

const PAGE_SIZE = 50;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
type Variant = NonNullable<BadgeProps["variant"]>;

const CATEGORY_VARIANT: Record<RegressionCategory, Variant> = {
  NEW: "destructive",
  STILL_FAILING: "warning",
  CHANGED: "default",
  UNABLE_TO_COMPARE: "muted",
  RESOLVED: "success",
  UNCHANGED: "secondary",
};
const DIRECTION_VARIANT: Record<Direction, Variant> = { REGRESSED: "destructive", IMPROVED: "success", UNCHANGED: "secondary", UNABLE_TO_COMPARE: "muted" };
const DIRECTION_LABEL: Record<Direction, string> = { REGRESSED: "Regressed", IMPROVED: "Improved", UNCHANGED: "Unchanged", UNABLE_TO_COMPARE: "Unable to Compare" };

function formatMetric(metric: string, v: number | null) {
  if (v === null) return "—";
  if (metric.endsWith("score")) return String(Math.round(v * 100));
  if (metric === "CLS") return v.toFixed(3);
  return `${Math.round(v)} ms`;
}

function BugList({ title, description, bugs, empty }: { title: string; description: string; bugs: BugRecord[]; empty: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {title} <span className="text-muted-foreground tabular-nums">({bugs.length})</span>
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {bugs.length === 0 ? (
          <p className="text-sm text-muted-foreground">{empty}</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {bugs.slice(0, 50).map((b) => (
              <li key={b.id} className="flex flex-wrap items-center gap-2">
                <Link href={`/bugs/${b.id}`} className="font-mono text-xs hover:underline">{b.code}</Link>
                <SeverityBadge severity={b.severity} />
                <BugStatusBadge status={b.status} />
                <span className="min-w-0 flex-1 truncate">{b.title}</span>
              </li>
            ))}
            {bugs.length > 50 ? <li className="text-muted-foreground">…and {bugs.length - 50} more</li> : null}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function FindingChanges({ title, items, emptyLabel }: { title: string; items: FindingSetComparison[]; emptyLabel: string }) {
  const changed = items.filter((i) => !i.comparable || i.newFindings.length || i.fixedFindings.length);
  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>A finding counts as gone only where the check ran in both runs; elsewhere the scope is marked Unable to Compare.</CardDescription>
      </CardHeader>
      {changed.length === 0 ? (
        <CardContent>
          <p className="text-sm text-muted-foreground">{items.length ? "No changes in findings between the two runs." : emptyLabel}</p>
        </CardContent>
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Page · browser · viewport</TableHead>
              <TableHead>New</TableHead>
              <TableHead>No longer found</TableHead>
              <TableHead className="hidden md:table-cell">Still present</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {changed.slice(0, 100).map((i) => (
              <TableRow key={i.scope} className="align-top">
                <TableCell className="max-w-72 font-mono text-xs break-all">{i.scope}</TableCell>
                {i.comparable ? (
                  <>
                    <TableCell className="text-xs">{i.newFindings.join(", ") || "—"}</TableCell>
                    <TableCell className="text-xs">{i.fixedFindings.join(", ") || "—"}</TableCell>
                    <TableCell className="hidden text-xs md:table-cell">{i.persistingFindings.length}</TableCell>
                  </>
                ) : (
                  <TableCell colSpan={3}><Badge variant="muted">Unable to Compare</Badge> <span className="text-xs text-muted-foreground">checked in only one of the runs</span></TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}

export default async function CompareRunsPage({ params, searchParams }: PageProps<"/test-runs/[id]/compare">) {
  const { id } = await params;
  const sp = await searchParams;
  const db = await requestDb();
  const current = await db.history.getRun(id);
  if (!current) notFound();
  const options = await db.history.comparableRuns(id);
  const requested = first(sp.with);
  const previousId = options.find((o) => o.id === requested)?.id ?? (await db.history.previousRunId(id));
  const category = REGRESSION_CATEGORIES.find((c) => c === first(sp.category));
  const page = readPage(sp.page);

  const header = (
    <PageHeader
      eyebrow={
        <>
          <Link href="/history" className="hover:underline">History</Link> / <Link href={`/test-runs/${id}`} className="hover:underline">{current.name ?? `Run ${id.slice(0, 8)}`}</Link>
        </>
      }
      title="Regression comparison"
      description="Results are matched by stable identity: page, test case (module, check and element), browser and viewport. A failure is reported Resolved only when the same check executed and PASSED in this run; content or screenshot differences alone never resolve anything."
    />
  );

  if (!previousId || options.length === 0) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState icon={GitCompareArrows} title="Nothing to compare with" description="This project has no other finished run. Run the tests again to compare results over time." />
      </div>
    );
  }

  const cmp = await db.history.compare(id, previousId);
  if (!cmp) notFound();
  const rows = category ? cmp.results.filter((r) => r.category === category) : cmp.results.filter((r) => r.category !== "UNCHANGED");
  const shown = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const changedPerf = cmp.performance.filter((p) => p.overall !== "UNCHANGED");
  const href = (c?: RegressionCategory) => `/test-runs/${id}/compare?with=${previousId}${c ? `&category=${c}` : ""}`;

  return (
    <div className="space-y-6">
      {header}
      <form method="get" className="flex flex-wrap items-end gap-3 rounded-xl border bg-card p-4">
        <div className="grid gap-1.5">
          <span className="text-sm font-medium">Current run</span>
          <span className="text-sm text-muted-foreground">
            {current.name ?? id.slice(0, 8)} · {formatDateTime(current.completedAt ?? current.createdAt)}
          </span>
        </div>
        <div className="grid min-w-64 gap-1.5">
          <Label htmlFor="with">Compared with</Label>
          <NativeSelect id="with" name="with" defaultValue={previousId}>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name ?? o.id.slice(0, 8)} · {formatDateTime(o.createdAt)} · {o.status}
              </option>
            ))}
          </NativeSelect>
        </div>
        <Button type="submit" variant="secondary">Compare</Button>
      </form>

      <section aria-label="Result changes" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {(["NEW", "RESOLVED", "STILL_FAILING", "CHANGED", "UNCHANGED", "UNABLE_TO_COMPARE"] as RegressionCategory[]).map((c) => (
          <Link
            key={c}
            href={href(c)}
            aria-current={category === c ? "true" : undefined}
            className={cn("rounded-xl border bg-card p-4 transition-colors hover:bg-muted/50", category === c && "ring-2 ring-primary")}
          >
            <p className="text-xs text-muted-foreground">{CATEGORY_LABELS[c]}</p>
            <p className="text-2xl font-semibold tabular-nums">{cmp.counts[c]}</p>
          </Link>
        ))}
      </section>

      <Card className="overflow-hidden">
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle>{category ? CATEGORY_LABELS[category] : "Changed checks"}</CardTitle>
            <CardDescription>{category ? `${rows.length} checks` : `${rows.length} checks that are not unchanged`}. Select a card above to filter.</CardDescription>
          </div>
          {category ? <Button variant="ghost" size="sm" asChild><Link href={href()}>Show all changes</Link></Button> : null}
        </CardHeader>
        {shown.length === 0 ? (
          <CardContent>
            <p className="text-sm text-muted-foreground">No checks in this category.</p>
          </CardContent>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Change</TableHead>
                <TableHead>Check</TableHead>
                <TableHead className="hidden md:table-cell">Browser / viewport</TableHead>
                <TableHead>Before</TableHead>
                <TableHead>Now</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((r) => (
                <TableRow key={r.key} className="align-top">
                  <TableCell><Badge variant={CATEGORY_VARIANT[r.category]}>{CATEGORY_LABELS[r.category]}</Badge></TableCell>
                  <TableCell className="min-w-64">
                    <p className="font-medium">{r.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {moduleLabel(r.module)} · <span className="font-mono">{r.pageUrl ?? "—"}</span>
                    </p>
                    <p className="text-xs text-muted-foreground">{r.reason}</p>
                  </TableCell>
                  <TableCell className="hidden text-xs md:table-cell">
                    {r.browser ?? "—"}
                    <div className="text-muted-foreground">{viewportLabel(r.viewport)}</div>
                  </TableCell>
                  <TableCell>{r.previous ? <ResultStatusBadge status={r.previous} /> : <span className="text-xs text-muted-foreground">not tested</span>}</TableCell>
                  <TableCell>{r.current ? <ResultStatusBadge status={r.current} /> : <span className="text-xs text-muted-foreground">not tested</span>}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <div className="border-t p-4">
          <Pagination basePath={`/test-runs/${id}/compare`} params={{ with: previousId, category }} page={page} pageSize={PAGE_SIZE} total={rows.length} />
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-3">
        <BugList title="New bugs" description="First seen in this run." bugs={cmp.bugs.new} empty="No new bugs." />
        <BugList title="Previously existing bugs" description="Seen in this run and already known before it." bugs={cmp.bugs.existing} empty="No recurring bugs." />
        <BugList
          title="Not observed in this run"
          description="Seen in the compared run but not in this one. They stay open until someone verifies the fix; a missing failure is not proof of a fix."
          bugs={cmp.bugs.notObserved}
          empty="None."
        />
      </div>

      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle>Performance changes</CardTitle>
          <CardDescription>
            Lab measurements vary between runs, so small differences are treated as unchanged (score ±5, LCP ±10% and 100 ms, TBT ±10% and 50 ms, CLS ±0.02). Measurements from different sources are not compared.
          </CardDescription>
        </CardHeader>
        {cmp.performance.length === 0 ? (
          <CardContent>
            <p className="text-sm text-muted-foreground">Performance was not measured in this run.</p>
          </CardContent>
        ) : changedPerf.length === 0 ? (
          <CardContent>
            <p className="text-sm text-muted-foreground">No measurable change on {cmp.performance.length} measured page(s).</p>
          </CardContent>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Page</TableHead>
                <TableHead>Overall</TableHead>
                <TableHead>Metrics (before → now)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {changedPerf.map((p) => (
                <TableRow key={`${p.pageUrl}|${p.formFactor}`} className="align-top">
                  <TableCell className="max-w-72 font-mono text-xs break-all">
                    {p.pageUrl}
                    <div className="font-sans text-muted-foreground">{p.formFactor ?? ""}</div>
                  </TableCell>
                  <TableCell><Badge variant={DIRECTION_VARIANT[p.overall]}>{DIRECTION_LABEL[p.overall]}</Badge></TableCell>
                  <TableCell>
                    <ul className="grid gap-1 text-xs sm:grid-cols-2">
                      {p.changes.map((m) => (
                        <li key={m.metric} className="flex flex-wrap items-center gap-1.5">
                          <span className="text-muted-foreground">{m.metric}:</span>
                          <span className="tabular-nums">{formatMetric(m.metric, m.previous)} → {formatMetric(m.metric, m.current)}</span>
                          {m.direction !== "UNCHANGED" ? <Badge variant={DIRECTION_VARIANT[m.direction]}>{DIRECTION_LABEL[m.direction]}</Badge> : null}
                        </li>
                      ))}
                    </ul>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <FindingChanges title="Accessibility changes" items={cmp.accessibility} emptyLabel="Accessibility found no issues in either run, or was not tested." />
      <FindingChanges title="UI changes" items={cmp.ui} emptyLabel="UI checks found no issues in either run, or were not tested." />
    </div>
  );
}
