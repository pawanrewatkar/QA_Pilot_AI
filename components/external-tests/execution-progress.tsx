"use client";

import { CircleCheck, Download, LoaderCircle, Square } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { cancelTestRunAction } from "@/app/test-runs/actions";
import { RunStatusBadge } from "@/components/shared/status-badges";
import { SubmitButton } from "@/components/shared/submit-button";
import { usePolling } from "@/components/shared/use-polling";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import type { ExternalExecutionRecord } from "@/lib/external-tests/types";
import { formatDateTime } from "@/lib/utils";

const ACTIVE = new Set(["PENDING", "RUNNING"]);
const TILES = [
  { key: "PASS", label: "PASS", tone: "text-success-text" },
  { key: "FAIL", label: "FAIL", tone: "text-destructive-text" },
  { key: "HUMAN INTERACTION", label: "HUMAN INTERACTION", tone: "text-warning-text" },
  { key: "NOT EXECUTED", label: "NOT EXECUTED", tone: "text-muted-foreground" },
  { key: "NOT APPLICABLE", label: "NOT APPLICABLE", tone: "text-muted-foreground" },
] as const;

/** Live progress from recorded results only: counts come from cases already evaluated in every selected device. */
export function ExecutionProgress({ initial }: { initial: ExternalExecutionRecord }) {
  const router = useRouter();
  const wasActive = useRef(ACTIVE.has(initial.runStatus));
  const { data: e, error } = usePolling<ExternalExecutionRecord>(`/api/external-test-cases/${initial.runId}`, {
    initial,
    active: ACTIVE.has(initial.runStatus),
    intervalMs: 1500,
    isDone: (x) => !ACTIVE.has(x.runStatus),
  });
  const active = ACTIVE.has(e.runStatus);

  useEffect(() => {
    if (active) {
      const t = setInterval(() => router.refresh(), 8000);
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
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2">
            {active ? <LoaderCircle className="size-4 animate-spin text-primary" aria-hidden /> : <CircleCheck className="size-4 text-muted-foreground" aria-hidden />}
            {e.runStatus === "PENDING" ? "Queued" : active ? "Executing test cases…" : "Execution finished"}
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Started {formatDateTime(e.startedAt ?? e.createdAt)}
            {e.completedAt ? ` · finished ${formatDateTime(e.completedAt)}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <RunStatusBadge status={e.runStatus} />
          {active ? (
            <form action={cancelTestRunAction}>
              <input type="hidden" name="testRunId" value={e.runId} />
              <SubmitButton variant="outline" size="sm" disabled={e.cancelRequested} pendingLabel="Cancelling…">
                <Square /> {e.cancelRequested ? "Cancelling…" : "Cancel test"}
              </SubmitButton>
            </form>
          ) : e.outputFileName ? (
            <Button size="sm" asChild>
              <a href={`/api/external-test-cases/${e.runId}/download`}>
                <Download /> Download Excel
              </a>
            </Button>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-4" aria-live="polite">
        <div className="space-y-1.5">
          <div className="flex justify-between text-sm">
            <span>
              Test cases: <span className="font-medium tabular-nums">{e.totalCases}</span> · Completed: <span className="font-medium tabular-nums">{e.completedCases}</span>
            </span>
            <span className="text-muted-foreground tabular-nums">{e.totalCases ? Math.round((e.completedCases / e.totalCases) * 100) : 0}%</span>
          </div>
          <Progress value={e.completedCases} max={Math.max(e.totalCases, 1)} label="Test cases completed" />
        </div>
        {active && e.currentTest ? (
          <p className="text-sm">
            <span className="text-muted-foreground">Current: </span>
            <span className="font-medium">{e.currentTest}</span>
          </p>
        ) : null}
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {TILES.map((t) => (
            <div key={t.key} className="rounded-lg border p-3">
              <dt className="text-xs text-muted-foreground">{t.label}</dt>
              <dd className={`text-xl font-semibold tabular-nums ${t.tone}`}>{e.counts[t.key]}</dd>
            </div>
          ))}
        </dl>
        {e.errorMessage ? (
          <Alert variant="destructive">
            <AlertTitle>{e.errorMessage}</AlertTitle>
          </Alert>
        ) : null}
        {e.outputError ? (
          <Alert variant="destructive">
            <AlertTitle>{e.outputError}</AlertTitle>
          </Alert>
        ) : null}
        {error ? <p className="text-xs text-muted-foreground">Live updates paused: {error}</p> : null}
      </CardContent>
    </Card>
  );
}
