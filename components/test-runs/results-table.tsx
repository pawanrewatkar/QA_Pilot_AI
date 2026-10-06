import { Image as ImageIcon } from "lucide-react";
import { ResultStatusBadge } from "@/components/shared/status-badges";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EXPECTATION_LABELS, verdictLabel } from "@/lib/constants/expectations";
import { getTestModule, VIEWPORTS } from "@/lib/constants/testing";
import { formatDateTime } from "@/lib/utils";
import type { TestResultRecord } from "@/types";

export function moduleLabel(id: string) {
  if (id === "page-load") return "Page load";
  return getTestModule(id)?.label.replace(/ Testing$/, "") ?? id;
}

export function viewportLabel(id: string | null) {
  const v = VIEWPORTS.find((x) => x.id === id);
  return v ? `${v.kind === "mobile" ? "Mobile" : "Desktop"} ${v.width}×${v.height}` : (id ?? "—");
}

function path(url: string | null) {
  if (!url) return "—";
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

/** Results with expandable details (steps, expected/actual, verifications, evidence). Server-rendered, no JS needed. */
export function ResultsTable({ results }: { results: TestResultRecord[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>ID</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Test</TableHead>
          <TableHead className="hidden md:table-cell">Page</TableHead>
          <TableHead className="hidden lg:table-cell">Type</TableHead>
          <TableHead className="hidden lg:table-cell">Browser / device</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {results.map((r) => (
          <TableRow key={r.id} className="align-top">
            <TableCell className="font-mono text-xs whitespace-nowrap">{r.caseCode ?? "—"}</TableCell>
            <TableCell>
              <ResultStatusBadge status={r.status} />
              {verdictLabel(r.status) ? <span className="mt-1 block text-[11px] leading-tight text-muted-foreground">{verdictLabel(r.status)}</span> : null}
            </TableCell>
            <TableCell className="min-w-72">
              <details className="group">
                <summary className="cursor-pointer list-none">
                  <span className="font-medium group-open:underline">{r.title}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">{r.actualResult}</span>
                </summary>
                <dl className="mt-3 grid gap-2 rounded-md border bg-muted/30 p-3 text-xs">
                  {[
                    ["Feature", r.feature],
                    ["Element", r.element],
                    ["Section", r.section],
                    ["Preconditions", r.preconditions],
                    ["Test data", r.testData],
                    ["Expected", r.expectedResult],
                    ["Expectation source", `${EXPECTATION_LABELS[r.expectationSource].priority}. ${EXPECTATION_LABELS[r.expectationSource].label}`],
                    ["Actual", r.actualResult],
                    ["Executed", r.executedAt ? formatDateTime(r.executedAt) : "Not executed"],
                  ]
                    .filter(([, v]) => v)
                    .map(([k, v]) => (
                      <div key={k} className="grid gap-0.5 sm:grid-cols-[110px_1fr]">
                        <dt className="text-muted-foreground">{k}</dt>
                        <dd className="break-words">{v}</dd>
                      </div>
                    ))}
                  {r.steps.length ? (
                    <div className="grid gap-0.5 sm:grid-cols-[110px_1fr]">
                      <dt className="text-muted-foreground">Steps</dt>
                      <dd>
                        <ol className="list-decimal pl-4">
                          {r.steps.map((s, i) => (
                            <li key={i}>{s}</li>
                          ))}
                        </ol>
                      </dd>
                    </div>
                  ) : null}
                  {r.verifications.length ? (
                    <div className="grid gap-0.5 sm:grid-cols-[110px_1fr]">
                      <dt className="text-muted-foreground">Verified</dt>
                      <dd>
                        <ul className="list-disc pl-4">
                          {r.verifications.map((v, i) => (
                            <li key={i} className="break-words">{v}</li>
                          ))}
                        </ul>
                      </dd>
                    </div>
                  ) : null}
                  {r.evidence.length ? (
                    <div className="grid gap-1 sm:grid-cols-[110px_1fr]">
                      <dt className="text-muted-foreground">Evidence</dt>
                      <dd className="grid gap-2">
                        {r.evidence.map((ev, i) =>
                          ev.type === "screenshot" && ev.storageKey ? (
                            <a key={i} href={`/api/artifacts?key=${encodeURIComponent(ev.storageKey)}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                              <ImageIcon className="size-3.5" aria-hidden /> {ev.label}
                            </a>
                          ) : (
                            <div key={i}>
                              <p className="font-medium">{ev.label}</p>
                              {ev.content ? <pre className="mt-1 max-h-40 overflow-auto rounded bg-muted p-2 font-mono text-[11px] whitespace-pre-wrap">{ev.content}</pre> : null}
                            </div>
                          ),
                        )}
                      </dd>
                    </div>
                  ) : null}
                  {r.message ? <p className="text-warning">{r.message}</p> : null}
                </dl>
              </details>
            </TableCell>
            <TableCell className="hidden max-w-56 truncate font-mono text-xs md:table-cell" title={r.url ?? undefined}>
              {path(r.url)}
            </TableCell>
            <TableCell className="hidden lg:table-cell">
              <div className="flex flex-wrap gap-1">
                <Badge variant="secondary">{moduleLabel(r.module)}</Badge>
                {r.scenarioType && r.scenarioType !== "FUNCTIONAL" ? <Badge variant="outline">{r.scenarioType.charAt(0) + r.scenarioType.slice(1).toLowerCase()}</Badge> : null}
              </div>
            </TableCell>
            <TableCell className="hidden text-xs whitespace-nowrap text-muted-foreground lg:table-cell">
              {r.browser ?? "—"}
              <br />
              {viewportLabel(r.viewport)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
