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
import { ResultTrendChart } from "@/components/dashboard/result-trend-chart";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { RunStatusBadge, SeverityBadge } from "@/components/shared/status-badges";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requestDb } from "@/lib/server/db";
import { cn, formatDateTime, formatNumber } from "@/lib/utils";
import type { BugSeverity } from "@/types";

export const metadata: Metadata = { title: "Dashboard" };

const TREND_DAYS = 30;

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
  const [metrics, recentRuns, recentBugs, activity, trend, regressions] = await Promise.all([
    db.dashboard.getMetrics(),
    db.testRuns.list({ limit: 5 }),
    db.bugs.list({ limit: 5 }),
    db.activity.list({ limit: 8 }),
    db.dashboard.getResultTrend(TREND_DAYS),
    db.dashboard.getRegressions(10),
  ]);

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
          <StatCard label="Bugs" value={metrics.bugs} icon={Bug} hint={metrics.bugs === 0 ? "No bugs recorded" : undefined} />
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {severities.map(({ severity, count }) => (
            <Card key={severity} className="flex items-center justify-between p-4">
              <div>
                <p className="text-sm text-muted-foreground">{severity.charAt(0) + severity.slice(1).toLowerCase()} Bugs</p>
                <p className="mt-1 text-xl font-semibold tabular-nums">{formatNumber(count)}</p>
              </div>
              <SeverityBadge severity={severity} />
            </Card>
          ))}
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
            <CardDescription>Checks that passed in a project&apos;s previous completed run and failed in its latest.</CardDescription>
          </CardHeader>
          <CardContent>
            {regressions.length === 0 ? (
              <EmptyState compact icon={GitCompare} title="No regressions detected" description="Requires at least two completed runs of the same project." />
            ) : (
              <ul className="divide-y text-sm">
                {regressions.map((r) => (
                  <li key={`${r.latestRunId}-${r.testCaseId}`} className="py-2">
                    <p className="font-medium">{r.testCaseTitle}</p>
                    <p className="text-xs text-muted-foreground">{r.projectName}</p>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Recent Test Runs</CardTitle>
          </CardHeader>
          <CardContent>
            {recentRuns.length === 0 ? (
              <EmptyState compact icon={CirclePlay} title="No test runs yet" description="Runs appear after the testing engine executes a configuration." />
            ) : (
              <ul className="divide-y text-sm">
                {recentRuns.map((run) => (
                  <li key={run.id} className="flex items-center justify-between gap-2 py-2">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{run.projectName}</p>
                      <p className="text-xs text-muted-foreground">{formatDateTime(run.createdAt)}</p>
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
          </CardHeader>
          <CardContent>
            {recentBugs.length === 0 ? (
              <EmptyState compact icon={Bug} title="No bugs recorded" description="Bugs are created only from failed, executed checks with evidence." />
            ) : (
              <ul className="divide-y text-sm">
                {recentBugs.map((bug) => (
                  <li key={bug.id} className="flex items-center justify-between gap-2 py-2">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{bug.title}</p>
                      <p className="text-xs text-muted-foreground">{bug.projectName}</p>
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
              <Link href="/history" className="mt-3 inline-block text-xs font-medium text-primary hover:underline">
                View full history
              </Link>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
