"use client";

import { CircleCheck, TriangleAlert } from "lucide-react";
import { Alert, AlertTitle } from "@/components/ui/alert";
import type { WorkerStatus } from "@/types";
import { usePolling } from "./use-polling";

/** Shows whether a worker process is running to pick up queued crawls and test runs. */
export function WorkerStatusBanner({ initial, compact }: { initial: WorkerStatus; compact?: boolean }) {
  const { data } = usePolling<WorkerStatus>("/api/workers", { initial, active: true, intervalMs: 5000 });
  if (data.online) {
    return compact ? (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <CircleCheck className="size-3.5 text-success-text" aria-hidden /> Worker online
      </p>
    ) : null;
  }
  return (
    <Alert variant="warning">
      <TriangleAlert />
      <div>
        <AlertTitle>The background worker is not running</AlertTitle>
        <p className="mt-1 text-muted-foreground">
          Crawls and test runs are queued but only execute while the worker runs. Start it in a second terminal with{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">npm run worker</code>, or run{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">npm run dev:all</code> to start the app and worker together.
        </p>
      </div>
    </Alert>
  );
}
