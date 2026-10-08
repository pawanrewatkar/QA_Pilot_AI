"use client";

import { CircleAlert, CircleCheck, LoaderCircle, Square } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { cancelTestRunAction } from "@/app/test-runs/actions";
import { RunStatusBadge } from "@/components/shared/status-badges";
import { SubmitButton } from "@/components/shared/submit-button";
import { usePolling } from "@/components/shared/use-polling";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { formatDateTime } from "@/lib/utils";
import type { TestRunDetail } from "@/types";

const ACTIVE = new Set(["PENDING", "RUNNING"]);
const COUNT_TILES = [
  { key: "PASS", label: "Passed", tone: "text-success-text" },
  { key: "FAIL", label: "Failed", tone: "text-destructive-text" },
  { key: "WARNING", label: "Warnings", tone: "text-warning-text" },
  { key: "NOT EXECUTED", label: "Not executed", tone: "text-muted-foreground" },
  { key: "NOT APPLICABLE", label: "Not applicable", tone: "text-muted-foreground" },
] as const;

export function RunProgress({ initial }: { initial: TestRunDetail }) {
  const router = useRouter();
  const wasActive = useRef(ACTIVE.has(initial.status));
  const { data: run, error } = usePolling<TestRunDetail>(`/api/test-runs/${initial.id}`, {
    initial,
    active: ACTIVE.has(initial.status),
    intervalMs: 1500,
    isDone: (r) => !ACTIVE.has(r.status),
  });
  const active = ACTIVE.has(run.status);

  // Refresh the server-rendered results table periodically while running, and once at the end.
  useEffect(() => {
    if (active) {
      const t = setInterval(() => router.refresh(), 6000);
      return () => clearInterval(t);
    }
    if (wasActive.current) {
      wasActive.current = false;
      router.refresh();
    }
  }, [active, router]);

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
        <CardTitle className="flex items-center gap-2">
          {active ? <LoaderCircle className="size-4 animate-spin text-primary" aria-hidden /> : null}
          {run.status === "PENDING" ? "Queued" : active ? "Running" : "Run finished"}
        </CardTitle>
        <div className="flex items-center gap-2">
          <RunStatusBadge status={run.status} />
          {active ? (
            <form action={cancelTestRunAction}>
              <input type="hidden" name="testRunId" value={run.id} />
              <SubmitButton variant="outline" size="sm" disabled={run.cancelRequested} pendingLabel="Cancelling…">
                <Square /> {run.cancelRequested ? "Cancelling…" : "Cancel run"}
              </SubmitButton>
            </form>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-4" aria-live="polite">
        <div className="space-y-1.5">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Page × browser × viewport units</span>
            <span className="tabular-nums">
              {run.progressCompleted} / {run.progressTotal}
            </span>
          </div>
          <Progress value={run.progressCompleted} max={Math.max(1, run.progressTotal)} label="Test run progress" />
        </div>
        {active && run.currentPageUrl ? (
          <div className="grid gap-1 text-sm">
            <p className="truncate">
              <span className="text-muted-foreground">Current page: </span>
              <span className="font-mono text-xs">{run.currentPageUrl}</span>
            </p>
            {run.currentTest ? (
              <p className="truncate">
                <span className="text-muted-foreground">Current test: </span>
                {run.currentTest}
              </p>
            ) : null}
          </div>
        ) : null}
        {run.status === "PENDING" ? <p className="text-sm text-muted-foreground">Waiting for the worker to start this run…</p> : null}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {COUNT_TILES.map((t) => (
            <div key={t.key} className="rounded-lg border p-3">
              <p className="text-xs text-muted-foreground">{t.label}</p>
              <p className={`mt-1 text-xl font-semibold tabular-nums ${run.counts[t.key] ? t.tone : ""}`}>{run.counts[t.key]}</p>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Created {formatDateTime(run.createdAt)}
          {run.startedAt ? ` · started ${formatDateTime(run.startedAt)}` : ""}
          {run.completedAt ? ` · finished ${formatDateTime(run.completedAt)}` : ""}
        </p>
        {run.status === "COMPLETED" ? (
          <Alert variant="success">
            <CircleCheck />
            <AlertTitle>
              Completed: {run.counts.PASS} passed, {run.counts.FAIL} failed, {run.counts.WARNING} warnings, {run.counts["NOT EXECUTED"]} not executed.
            </AlertTitle>
          </Alert>
        ) : null}
        {run.status === "FAILED" ? (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertTitle>The run stopped: {run.errorMessage}</AlertTitle>
          </Alert>
        ) : null}
        {run.status === "CANCELLED" ? <p className="text-sm text-muted-foreground">The run was cancelled. Results recorded before cancellation are kept; nothing else was executed.</p> : null}
        {error && active ? <p className="text-xs text-destructive-text">Progress update failed: {error}</p> : null}
      </CardContent>
    </Card>
  );
}
