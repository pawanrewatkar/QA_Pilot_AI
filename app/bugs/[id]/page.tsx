import { ExternalLink, ImageOff, RefreshCw } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { updateBugStatusAction } from "@/app/bugs/actions";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { BugStatusBadge, SeverityBadge } from "@/components/shared/status-badges";
import { moduleLabel, viewportLabel } from "@/components/test-runs/results-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label, NativeSelect, Textarea } from "@/components/ui/form-controls";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requestDb } from "@/lib/server/db";
import { formatDateTime } from "@/lib/utils";
import { BUG_STATUSES } from "@/types";

export const metadata: Metadata = { title: "Bug" };

const KIND_LABEL: Record<string, string> = { VIEWPORT: "Viewport", FULL_PAGE: "Full page", ELEMENT: "Element" };

function Field({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={mono ? "font-mono text-xs break-all" : "break-words"}>{children || "—"}</dd>
    </div>
  );
}

function TextBlock({ title, text }: { title: string; text: string | null }) {
  return (
    <div className="space-y-1.5">
      <h3 className="text-sm font-medium">{title}</h3>
      <p className="rounded-md bg-muted/50 p-3 text-sm whitespace-pre-wrap">{text || "—"}</p>
    </div>
  );
}

export default async function BugPage({ params }: PageProps<"/bugs/[id]">) {
  const { id } = await params;
  const db = await requestDb();
  const bug = await db.bugs.getDetail(id);
  if (!bug) notFound();
  const related = await db.bugs.related(id);
  const screenshots = bug.evidence.filter((e) => e.type === "SCREENSHOT" && e.storageKey);
  const logs = bug.evidence.filter((e) => e.type !== "SCREENSHOT" && e.content);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <>
            <Link href="/bugs" className="hover:underline">Bugs</Link> / <Link href={`/projects/${bug.projectId}`} className="hover:underline">{bug.projectName}</Link>
          </>
        }
        title={`${bug.code ?? "Bug"} · ${bug.title}`}
        description={
          <span className="flex flex-wrap items-center gap-1.5">
            <SeverityBadge severity={bug.severity} />
            <Badge variant="outline">{bug.priority}</Badge>
            <BugStatusBadge status={bug.status} />
            {bug.occurrenceCount > 1 ? <span>· observed {bug.occurrenceCount} times</span> : null}
          </span>
        }
        actions={
          <ConfirmDialog
            trigger={
              <Button variant="outline">
                <RefreshCw /> Change status
              </Button>
            }
            title={`Change status of ${bug.code ?? "this bug"}`}
            description="Status changes are recorded in the history below. Mark a bug resolved only after the fix has been verified; if the failure is observed again, the engine reopens it."
            action={updateBugStatusAction}
            fields={{ bugId: bug.id }}
            confirmLabel="Save status"
            pendingLabel="Saving…"
          >
            <div className="grid gap-1.5">
              <Label htmlFor="bug-status">New status</Label>
              <NativeSelect id="bug-status" name="status" defaultValue={bug.status}>
                {BUG_STATUSES.map((s) => (
                  <option key={s} value={s}>{s.replace(/_/g, " ")}</option>
                ))}
              </NativeSelect>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="bug-note">Note (optional)</Label>
              <Textarea id="bug-note" name="note" maxLength={1000} rows={3} placeholder="e.g. Verified fixed in release 2.4" />
            </div>
          </ConfirmDialog>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
          {bug.severityReason ? <CardDescription>Severity: {bug.severityReason}</CardDescription> : null}
        </CardHeader>
        <CardContent>
          <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Page name">{bug.pageName}</Field>
            <Field label="Page URL" mono>
              {bug.pageUrl ? (
                <a href={bug.pageUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:underline">
                  {bug.pageUrl} <ExternalLink className="size-3" aria-hidden />
                </a>
              ) : null}
            </Field>
            <Field label="Section">{bug.section}</Field>
            <Field label="Test type">{bug.testType ? moduleLabel(bug.testType) : null}</Field>
            <Field label="Scenario type">{bug.scenarioType?.toLowerCase()}</Field>
            <Field label="Device">{bug.viewport ? viewportLabel(bug.viewport) : null}</Field>
            <Field label="Browser">{bug.browser}</Field>
            <Field label="Element">{bug.element}</Field>
            <Field label="Selector" mono>{bug.selector}</Field>
            <Field label="Created">{formatDateTime(bug.createdAt)}</Field>
            <Field label="Last seen">{formatDateTime(bug.lastSeenAt)}</Field>
            <Field label="First seen in run">
              {bug.firstSeenRunId ? (
                <Link className="hover:underline" href={`/test-runs/${bug.firstSeenRunId}`}>{bug.firstSeenRunId.slice(0, 8)}</Link>
              ) : null}
            </Field>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Expected vs actual</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 lg:grid-cols-2">
          <TextBlock title="Expected result" text={bug.expectedResult} />
          <TextBlock title="Actual result" text={bug.actualResult} />
          <div className="lg:col-span-2">
            <TextBlock title="Steps to reproduce" text={bug.stepsToReproduce} />
          </div>
          {bug.technicalDetails ? (
            <details className="lg:col-span-2">
              <summary className="cursor-pointer text-sm font-medium">Technical details</summary>
              <pre className="mt-2 max-h-96 overflow-auto rounded-md bg-muted/50 p-3 text-xs whitespace-pre-wrap">{bug.technicalDetails}</pre>
            </details>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Evidence</CardTitle>
          <CardDescription>Captured during execution. Password, payment and other sensitive fields are masked in screenshots; secrets are redacted from text.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {screenshots.length === 0 ? (
            <EmptyState compact icon={ImageOff} title="No screenshots" description="This failure was recorded with HTTP, console or DOM evidence only." />
          ) : (
            <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {screenshots.map((e) => {
                const src = `/api/artifacts?key=${encodeURIComponent(e.storageKey!)}`;
                return (
                  <li key={e.id} className="overflow-hidden rounded-lg border">
                    <a href={src} target="_blank" rel="noopener noreferrer" className="block bg-muted/40" aria-label={`Open ${e.label ?? "screenshot"} full size`}>
                      {/* eslint-disable-next-line @next/next/no-img-element -- local evidence served by the artifacts route */}
                      <img src={src} alt={e.label ?? "Screenshot evidence"} loading="lazy" className="max-h-72 w-full object-contain object-top" />
                    </a>
                    <div className="space-y-1 p-3 text-xs">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge variant="secondary">{KIND_LABEL[e.screenshotKind ?? "VIEWPORT"] ?? e.screenshotKind}</Badge>
                        <span className="font-medium">{e.label}</span>
                      </div>
                      <p className="text-muted-foreground">
                        {e.browser ?? "—"} · {e.viewport ? viewportLabel(e.viewport) : "—"} · {formatDateTime(e.capturedAt)}
                      </p>
                      {e.url ? <p className="truncate font-mono text-muted-foreground">{e.url}</p> : null}
                      {e.selector ? <p className="truncate font-mono">{e.selector}</p> : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {logs.length ? (
            <div className="space-y-2">
              {logs.map((e) => (
                <details key={e.id} className="rounded-lg border p-3">
                  <summary className="cursor-pointer text-sm">
                    <Badge variant="outline" className="mr-2">{e.type.replace(/_/g, " ").toLowerCase()}</Badge>
                    {e.label ?? "Log"}
                    <span className="ml-2 text-xs text-muted-foreground">
                      {e.browser ?? ""} {e.viewport ? `· ${viewportLabel(e.viewport)}` : ""}
                    </span>
                  </summary>
                  <pre className="mt-2 max-h-80 overflow-auto rounded-md bg-muted/50 p-3 text-xs whitespace-pre-wrap">{e.content}</pre>
                </details>
              ))}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="overflow-hidden">
          <CardHeader>
            <CardTitle>Occurrences</CardTitle>
            <CardDescription>Each run, browser and viewport where this exact failure was verified.</CardDescription>
          </CardHeader>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Run</TableHead>
                <TableHead>Browser / device</TableHead>
                <TableHead>Observed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {bug.occurrences.map((o) => (
                <TableRow key={o.id}>
                  <TableCell>
                    <Link href={`/test-runs/${o.testRunId}`} className="hover:underline">{o.testRunName ?? o.testRunId.slice(0, 8)}</Link>
                  </TableCell>
                  <TableCell className="text-xs">
                    {o.browser ?? "—"}
                    <div className="text-muted-foreground">{o.viewport ? viewportLabel(o.viewport) : ""}</div>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{formatDateTime(o.observedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>History</CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="space-y-3 border-l pl-4 text-sm">
              {bug.history.map((h) => (
                <li key={h.id} className="relative">
                  <span className="absolute top-1.5 -left-[21px] size-2.5 rounded-full border bg-background" aria-hidden />
                  <p>
                    {h.fromStatus ? <>{h.fromStatus.replace(/_/g, " ")} → </> : null}
                    <span className="font-medium">{h.toStatus.replace(/_/g, " ")}</span>{" "}
                    <Badge variant={h.source === "ENGINE" ? "secondary" : "outline"}>{h.source === "ENGINE" ? "engine" : "user"}</Badge>
                  </p>
                  {h.note ? <p className="text-muted-foreground">{h.note}</p> : null}
                  <p className="text-xs text-muted-foreground">{formatDateTime(h.changedAt)}</p>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      </div>

      {related.length ? (
        <Card>
          <CardHeader>
            <CardTitle>Related bugs</CardTitle>
            <CardDescription>Same page, test type and element but a different check. Shown for review only; they are not merged.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm">
              {related.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-2">
                  <Link href={`/bugs/${r.id}`} className="font-mono text-xs hover:underline">{r.code}</Link>
                  <span>{r.title}</span>
                  <BugStatusBadge status={r.status} />
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
