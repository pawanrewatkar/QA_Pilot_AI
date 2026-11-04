"use client";

import { CircleCheck, Clock, TriangleAlert } from "lucide-react";
import { Alert, AlertTitle } from "@/components/ui/alert";
import type { WorkerLaunchMode } from "@/lib/worker/dispatch";
import type { WorkerStatus } from "@/types";
import { usePolling } from "./use-polling";

const code = "rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground";

/**
 * Shows whether a worker process is running to pick up queued crawls and test runs, and how one gets started here:
 * automatically on GitHub Actions, by hand on GitHub Actions (hosted, not configured), or `npm run worker` (local).
 */
export function WorkerStatusBanner({ initial, compact, launch = "local" }: { initial: WorkerStatus; compact?: boolean; launch?: WorkerLaunchMode }) {
  const { data } = usePolling<WorkerStatus>("/api/workers", { initial, active: true, intervalMs: 5000 });
  if (data.online) {
    return compact ? (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <CircleCheck className="size-3.5 text-success-text" aria-hidden /> Worker online
      </p>
    ) : null;
  }
  if (launch === "github-auto") {
    return (
      <Alert variant="info">
        <Clock />
        <div>
          <AlertTitle>The worker starts automatically</AlertTitle>
          <p className="mt-1 text-muted-foreground">
            Queued crawls and test runs start a worker on GitHub Actions; it usually picks them up within 1–3 minutes. Anything
            missed is picked up by the hourly run.
          </p>
        </div>
      </Alert>
    );
  }
  return (
    <Alert variant="warning">
      <TriangleAlert />
      <div>
        <AlertTitle>The background worker is not running</AlertTitle>
        {launch === "github-manual" ? (
          <p className="mt-1 text-muted-foreground">
            Crawls and test runs are queued until a worker runs. Start one on GitHub: Actions → QA worker → Run workflow. It
            processes everything queued, then stops. Queued work is also picked up by the hourly run.
          </p>
        ) : (
          <p className="mt-1 text-muted-foreground">
            Crawls and test runs are queued but only execute while the worker runs. Start it in a second terminal with{" "}
            <code className={code}>npm run worker</code>, or run <code className={code}>npm run dev:all</code> to start the app and
            worker together.
          </p>
        )}
      </div>
    </Alert>
  );
}
