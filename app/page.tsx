import {
  Activity,
  Bug,
  CircleCheck,
  CirclePlay,
  CircleX,
  FileText,
  FolderKanban,
  GitCompare,
  ListChecks,
  Plus,
  TrendingUp,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { DistributionBars } from "@/components/dashboard/distribution-bars";
import { ResultTrendChart } from "@/components/dashboard/result-trend-chart";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { BugStatusBadge, RunStatusBadge, SeverityBadge } from "@/components/shared/status-badges";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CATEGORY_LABELS, type RegressionCategory, type RunComparison } from "@/lib/regression/compare";
import { requestDb } from "@/lib/server/db";
import { cn, formatDateTime, formatNumber } from "@/lib/utils";
import type { BugSeverity } from "@/types";

export const metadata: Metadata = { title: "Dashboard" };

const TREND_DAYS = 30;
const SEVERITY_COLOR: Record<BugSeverity, string> = { CRITICAL: "#991b1b", HIGH: "#d03b3b", MEDIUM: "#fab219", LOW: "#2563eb" };
const REGRESSION_TONE: Record<string, "destructive" | "warning" | "success" | "default" | "muted"> = {
  NEW: "destructive",
  STILL_FAILING: "warning",
  RESOLVED: "success",
  CHANGED: "default",
  UNABLE_TO_COMPARE: "muted",
};
const REGRESSION_SHOWN: RegressionCategory[] = ["NEW", "RESOLVED", "STILL_FAILING", "CHANGED", "UNABLE_TO_COMPARE"];

function StatCard({ label, value, icon: Icon, hint, tone }: { label: string; value: number; icon: LucideIcon; hint?: string; tone?: string }) {
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm text-muted-foreground">{label}</p>
        <Icon className={cn("size-4 text-muted-foreground", tone)} aria-hidden />
      </div>
      <p className="mt-2 text-2xl font-semibold tracking-tight tabular-nums">{formatNumber(value)}</p>
      {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
    </Card>
  );
}

export default async function DashboardPage() {
  const db = await requestDb();
  const [metrics, recentRuns, recentBugs, activity, trend] = await Promise.all([
    db.dashboard.getMetrics(),
    db.history.listRuns({ limit: 6 }),
    db.bugs.list({ limit: 6 }),
    db.activity.list({ limit: 8 }),
    db.dashboard.getResultTrend(TREND_DAYS),
  ]);
  // Regression info: the latest finished run that has an earlier run of the same project.
  let regression: RunComparison | null = null;
  for (const run of recentRuns.filter((r) => r.status !== "PENDING" && r.status !== "RUNNING").slice(0, 3)) {
    const previousId = await db.history.previousRunId(run.id);
    if (!previousId) continue;
    regression = await db.history.compare(run.id, previousId);
    if (regression) break;
  }

  const noResults = metrics.passed + metrics.failed + metrics.warnings === 0;
  const resultHint = noResults ? "No executed results yet" : undefined;
  const severities: { severity: BugSeverity; count: number }[] = [
    { severity: "CRITICAL", count: metrics.criticalBugs },
    { severity: "HIGH", count: metrics.highBugs },
    { severity: "MEDIUM", count: metrics.mediumBugs },
    { severity: "LOW", count: metrics.lowBugs },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        description="Live metrics from your local QA database. Numbers reflect only tests that were actually executed."
        actions={
          <Button asChild>
            <Link href="/projects/new">
              <Plus /> New project
            </Link>
          </Button>
        }
      />

      {metrics.totalProjects === 0 ? (
        <EmptyState
          icon={FolderKanban}
          title="Welcome to QA Pilot AI"
          description="Create a project for the website you want to test. Pages, test runs, results and bugs will appear here once testing is performed."
          action={
            <Button asChild>
              <Link href="/projects/new">
                <Plus /> Create your first project
              </Link>
            </Button>
          }
        />
      ) : null}

      <section aria-labelledby="overview-heading" className="space-y-3">
        <h2 id="overview-heading" className="text-sm font-semibold text-muted-foreground">Overview</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard label="Total Projects" value={metrics.totalProjects} icon={FolderKanban} />
          <StatCard label="Total Test Runs" value={metrics.totalTestRuns} icon={CirclePlay} />
          <StatCard label="Total Pages Tested" value={metrics.totalPagesTested} icon={FileText} />
          <StatCard label="Total Test Cases" value={metrics.totalTestCases} icon={ListChecks} />
        </div>
      </section>

      <section aria-labelledby="results-heading" className="space-y-3">
        <h2 id="results-heading" className="text-sm font-semibold text-muted-foreground">Results &amp; bugs</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard label="Passed" value={metrics.passed} icon={CircleCheck} tone="text-success" hint={resultHint} />
          <StatCard label="Failed" value={metrics.failed} icon={CircleX} tone="text-destructive" hint={resultHint} />
          <StatCard label="Warnings" value={metrics.warnings} icon={TriangleAlert} tone="text-warning" hint={resultHint} />
          <StatCard label="Bugs" value={metrics.bugs} icon={Bug} hint={metrics.bugs === 0 ? "No bugs recorded" : `${formatNumber(metrics.openBugs)} open`} />
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Result status</CardTitle>
              <CardDescription>All recorded results. NOT EXECUTED means a check could not run; it is never counted as passed.</CardDescription>
            </CardHeader>
            <CardContent>
              {noResults && metrics.notExecuted === 0 ? (
                <EmptyState compact icon={ListChecks} title="No results yet" description="Run tests to see the distribution." />
              ) : (
                <DistributionBars
                  caption="Recorded results by status"
                  items={[
                    { label: "PASS", value: metrics.passed, color: "#0ca30c" },
                    { label: "FAIL", value: metrics.failed, color: "#d03b3b" },
                    { label: "WARNING", value: metrics.warnings, color: "#fab219" },
                    { label: "NOT EXECUTED", value: metrics.notExecuted, color: "#9ca3af" },
                  ]}
                />
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Bug severity</CardTitle>
              <CardDescription>All bugs, created only from verified failures.</CardDescription>
            </CardHeader>
            <CardContent>
              {metrics.bugs === 0 ? (
                <EmptyState compact icon={Bug} title="No bugs recorded" description="The severity distribution appears once bugs exist." />
              ) : (
                <DistributionBars
                  caption="Bugs by severity"
                  items={severities.map(({ severity, count }) => ({ label: severity, value: count, color: SEVERITY_COLOR[severity], href: `/bugs?severity=${severity}` }))}
                />
              )}
            </CardContent>
          </Card>
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <TrendingUp className="size-4 text-muted-foreground" aria-hidden /> Pass/Fail trend
            </CardTitle>
            <CardDescription>Executed results per day, last {TREND_DAYS} days.</CardDescription>
          </CardHeader>
          <CardContent>
            {trend.length === 0 ? (
              <EmptyState compact icon={TrendingUp} title="No trend data" description="The trend appears once test runs record executed results." />
            ) : (
              <ResultTrendChart points={trend} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <GitCompare className="size-4 text-muted-foreground" aria-hidden /> Regressions
            </CardTitle>
            <CardDescription>Latest run compared with the previous run of the same project, matched by stable check identity.</CardDescription>
          </CardHeader>
          <CardContent>
            {!regression ? (
              <EmptyState compact icon={GitCompare} title="No comparison yet" description="Requires at least two finished runs of the same project." />
            ) : (
              <div className="space-y-3 text-sm">
                <p>
                  <Link href={`/test-runs/${regression.current.id}`} className="font-medium hover:underline">
                    {regression.current.name ?? `Run ${regression.current.id.slice(0, 8)}`}
                  </Link>
                  <span className="text-muted-foreground">
                    {" "}
                    vs {regression.previous.name ?? regression.previous.id.slice(0, 8)} · {regression.current.projectName}
                  </span>
                </p>
                <ul className="grid grid-cols-2 gap-2">
                  {REGRESSION_SHOWN.map((c) => (
                    <li key={c}>
                      <Link
                        href={`/test-runs/${regression.current.id}/compare?with=${regression.previous.id}&category=${c}`}
                        className="flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 hover:bg-muted/50"
                      >
                        <Badge variant={REGRESSION_TONE[c] ?? "secondary"}>{CATEGORY_LABELS[c]}</Badge>
                        <span className="font-semibold tabular-nums">{regression.counts[c]}</span>
                      </Link>
                    </li>
                  ))}
                  <li className="flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5">
                    <span className="text-muted-foreground">New bugs</span>
                    <span className="font-semibold tabular-nums">{regression.bugs.new.length}</span>
                  </li>
                </ul>
                <Link href={`/test-runs/${regression.current.id}/compare?with=${regression.previous.id}`} className="inline-block text-xs font-medium text-primary hover:underline">
                  Open full comparison
                </Link>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Recent Test Runs</CardTitle>
            <CardDescription>
              <Link href="/history" className="hover:underline">All runs</Link>
            </CardDescription>
          </CardHeader>
          <CardContent>
            {recentRuns.length === 0 ? (
              <EmptyState compact icon={CirclePlay} title="No test runs yet" description="Runs appear after the testing engine executes a configuration." />
            ) : (
              <ul className="divide-y text-sm">
                {recentRuns.map((run) => (
                  <li key={run.id} className="flex items-center justify-between gap-2 py-2">
                    <div className="min-w-0">
                      <Link href={`/test-runs/${run.id}`} className="block truncate font-medium hover:underline">{run.name ?? run.projectName}</Link>
                      <p className="text-xs text-muted-foreground">
                        {formatDateTime(run.createdAt)} · <span className="text-success">{run.counts.PASS}</span>/<span className="text-destructive">{run.counts.FAIL}</span>/
                        <span className="text-warning">{run.counts.WARNING}</span> · {run.bugs} bugs
                      </p>
                    </div>
                    <RunStatusBadge status={run.status} />
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent Bugs</CardTitle>
            <CardDescription>
              <Link href="/bugs" className="hover:underline">All bugs</Link>
            </CardDescription>
          </CardHeader>
          <CardContent>
            {recentBugs.length === 0 ? (
              <EmptyState compact icon={Bug} title="No bugs recorded" description="Bugs are created only from failed, executed checks with evidence." />
            ) : (
              <ul className="divide-y text-sm">
                {recentBugs.map((bug) => (
                  <li key={bug.id} className="flex items-center justify-between gap-2 py-2">
                    <div className="min-w-0">
                      <Link href={`/bugs/${bug.id}`} className="block truncate font-medium hover:underline">{bug.title}</Link>
                      <p className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                        <span className="font-mono">{bug.code}</span> · {bug.projectName} · <BugStatusBadge status={bug.status} />
                      </p>
                    </div>
                    <SeverityBadge severity={bug.severity} />
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="size-4 text-muted-foreground" aria-hidden /> Testing Activity
            </CardTitle>
          </CardHeader>
          <CardContent>
            {activity.length === 0 ? (
              <EmptyState compact icon={Activity} title="No activity yet" description="Project and configuration changes are logged here." />
            ) : (
              <ul className="space-y-3 text-sm">
                {activity.map((a) => (
                  <li key={a.id} className="flex gap-2">
                    <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" aria-hidden />
                    <div className="min-w-0">
                      <p className="break-words">{a.summary}</p>
                      <p className="text-xs text-muted-foreground">{formatDateTime(a.createdAt)}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {activity.length > 0 ? (
              <Link href="/history?tab=activity" className="mt-3 inline-block text-xs font-medium text-primary hover:underline">
                View full history
              </Link>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
