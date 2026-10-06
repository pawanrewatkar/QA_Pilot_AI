"use client";

import { CircleAlert, CircleCheck, FileText, Info, Monitor, Smartphone } from "lucide-react";
import Link from "next/link";
import { startTransition, useActionState, useId, useMemo, useState } from "react";
import type { ConfigurationFormState } from "@/app/projects/actions";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, Input, Label, Textarea } from "@/components/ui/form-controls";
import {
  ALL_TEST_MODULE_IDS,
  BROWSER_OPTIONS,
  DEFAULT_REPORT_SECTIONS,
  MAX_MANUAL_URLS,
  MODULE_REQUIREMENT_LABELS,
  REPORT_FORMAT_OPTIONS,
  REPORT_SECTION_OPTIONS,
  TEST_MODULE_GROUPS,
  TEST_SCOPE_OPTIONS,
  VIEWPORTS,
  type ModuleRequirement,
} from "@/lib/constants/testing";
import { cn, formatDateTime } from "@/lib/utils";
import type { BrowserName, ReportFormat, ReportSections, TestConfiguration, TestScope } from "@/types";

export interface ConfigProjectContext {
  id: string;
  websiteUrl: string;
  available: Record<ModuleRequirement, boolean>;
}

interface Props {
  project: ConfigProjectContext;
  pages: { id: string; url: string; title: string | null }[];
  initial: TestConfiguration | null;
  action: (state: ConfigurationFormState, payload: unknown) => Promise<ConfigurationFormState>;
}

type CheckedState = boolean | "indeterminate";

function toggle<T>(list: T[], value: T, on: boolean): T[] {
  return on ? (list.includes(value) ? list : [...list, value]) : list.filter((v) => v !== value);
}

function groupState(selected: Set<string>, ids: string[]): CheckedState {
  const count = ids.filter((id) => selected.has(id)).length;
  return count === 0 ? false : count === ids.length ? true : "indeterminate";
}

export function TestConfigurationForm({ project, pages, initial, action }: Props) {
  const uid = useId();
  const [state, dispatch, pending] = useActionState(action, {
    errors: {},
    savedAt: null,
    configurationId: initial?.id ?? null,
  });

  const [name, setName] = useState(initial?.name ?? "Default configuration");
  const [scope, setScope] = useState<TestScope>(initial?.scope ?? "ENTIRE_WEBSITE");
  const [selectedPageIds, setSelectedPageIds] = useState<string[]>(initial?.selectedPageIds ?? []);
  const [manualUrls, setManualUrls] = useState((initial?.manualUrls ?? []).join("\n"));
  const [modules, setModules] = useState<string[]>(initial?.modules ?? []);
  const [browsers, setBrowsers] = useState<BrowserName[]>(initial?.browsers ?? ["chromium"]);
  const [viewports, setViewports] = useState<string[]>(initial?.viewports ?? ["desktop-1440x900", "mobile-390x844"]);
  const [reportFormats, setReportFormats] = useState<ReportFormat[]>(initial?.reportFormats ?? ["EXCEL", "PDF"]);
  const [reportSections, setReportSections] = useState<ReportSections>(initial?.reportSections ?? DEFAULT_REPORT_SECTIONS);

  const selectedModules = useMemo(() => new Set(modules), [modules]);
  const allState = groupState(selectedModules, ALL_TEST_MODULE_IDS);
  const manualCount = manualUrls.split(/[\n,]/).filter((s) => s.trim()).length;
  const e = state.errors;

  const missingRequirements = useMemo(() => {
    const missing = new Map<string, ModuleRequirement[]>();
    for (const group of TEST_MODULE_GROUPS) {
      for (const m of group.modules) {
        const unmet = (m.requires ?? []).filter((r) => !project.available[r]);
        if (unmet.length) missing.set(m.id, unmet);
      }
    }
    return missing;
  }, [project.available]);
  const selectedWithUnmet = modules.filter((id) => missingRequirements.has(id));

  function submit(event: React.FormEvent) {
    event.preventDefault();
    startTransition(() =>
      dispatch({ name, scope, selectedPageIds, manualUrls, modules, browsers, viewports, reportFormats, reportSections }),
    );
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-6 pb-24">
      {Object.keys(e).length > 0 ? (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertTitle>{e.form ?? "The configuration could not be saved. Review the highlighted sections."}</AlertTitle>
        </Alert>
      ) : state.savedAt ? (
        <Alert variant="success">
          <CircleCheck />
          <div>
            <AlertTitle>Configuration saved at {formatDateTime(state.savedAt)}.</AlertTitle>
            <p className="mt-1 text-muted-foreground">
              You can now start a run with it. <Link href={`/projects/${project.id}`} className="text-primary hover:underline">Back to project</Link>
            </p>
          </div>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>1. Scope</CardTitle>
          <CardDescription>What should be tested on {new URL(project.websiteUrl).hostname}?</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5">
          <Field id={`${uid}-name`} label="Configuration name" required error={e.name}>
            <Input id={`${uid}-name`} value={name} onChange={(ev) => setName(ev.target.value)} maxLength={100} aria-invalid={!!e.name} />
          </Field>

          <fieldset className="grid gap-2">
            <legend className="mb-2 text-sm font-medium">Testing scope</legend>
            <div className="grid gap-3 md:grid-cols-3">
              {TEST_SCOPE_OPTIONS.map((opt) => (
                <label
                  key={opt.id}
                  className={cn(
                    "flex cursor-pointer gap-3 rounded-lg border p-4 transition-colors hover:bg-accent/50 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
                    scope === opt.id && "border-primary bg-primary/5",
                  )}
                >
                  <input type="radio" name="scope" value={opt.id} checked={scope === opt.id} onChange={() => setScope(opt.id)} className="mt-0.5 accent-[var(--primary)]" />
                  <span>
                    <span className="block text-sm font-medium">{opt.label}</span>
                    <span className="block text-xs text-muted-foreground">{opt.description}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          {scope === "SELECTED_PAGES" ? (
            <div className="grid gap-2">
              <p className="text-sm font-medium">Pages</p>
              {pages.length === 0 ? (
                <div className="flex gap-3 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                  <FileText className="size-4 shrink-0" aria-hidden />
                  No pages have been discovered for this project yet. Pages appear after a crawl; until then use Entire Website or Manual URLs.
                </div>
              ) : (
                <ul className="max-h-64 divide-y overflow-y-auto rounded-lg border">
                  {pages.map((p) => (
                    <li key={p.id} className="flex items-center gap-3 px-3 py-2">
                      <Checkbox
                        id={`${uid}-page-${p.id}`}
                        checked={selectedPageIds.includes(p.id)}
                        onCheckedChange={(c) => setSelectedPageIds((l) => toggle(l, p.id, c === true))}
                      />
                      <Label htmlFor={`${uid}-page-${p.id}`} className="min-w-0 truncate font-normal">
                        {p.title ? `${p.title} — ` : ""}
                        <span className="text-muted-foreground">{p.url}</span>
                      </Label>
                    </li>
                  ))}
                </ul>
              )}
              {e.selectedPageIds ? <p className="text-xs text-destructive" role="alert">{e.selectedPageIds}</p> : null}
            </div>
          ) : null}

          {scope === "MANUAL_URLS" ? (
            <Field
              id={`${uid}-urls`}
              label="Manual URLs"
              required
              error={e.manualUrls}
              hint={`One URL per line (or comma-separated), on ${new URL(project.websiteUrl).hostname} or its subdomains. Up to ${MAX_MANUAL_URLS}. ${manualCount} entered.`}
            >
              <Textarea
                id={`${uid}-urls`}
                rows={6}
                value={manualUrls}
                onChange={(ev) => setManualUrls(ev.target.value)}
                placeholder={`${project.websiteUrl.replace(/\/$/, "")}/about\n${project.websiteUrl.replace(/\/$/, "")}/contact`}
                className="font-mono text-xs"
                aria-invalid={!!e.manualUrls}
              />
            </Field>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle>2. Testing modules</CardTitle>
            <CardDescription>
              {modules.length} of {ALL_TEST_MODULE_IDS.length} selected.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2 rounded-md border px-3 py-2">
            <Checkbox
              id={`${uid}-all`}
              checked={allState}
              onCheckedChange={(c) => setModules(c === true ? [...ALL_TEST_MODULE_IDS] : [])}
            />
            <Label htmlFor={`${uid}-all`}>Select All</Label>
          </div>
        </CardHeader>
        <CardContent className="grid gap-5">
          {e.modules ? <p className="text-sm text-destructive" role="alert">{e.modules}</p> : null}
          <div className="grid gap-4 md:grid-cols-2">
            {TEST_MODULE_GROUPS.map((group) => {
              const ids = group.modules.map((m) => m.id);
              return (
                <fieldset key={group.id} className="rounded-lg border">
                  <legend className="sr-only">{group.label}</legend>
                  <div className="flex items-center gap-3 border-b bg-muted/40 px-4 py-2.5">
                    <Checkbox
                      id={`${uid}-group-${group.id}`}
                      checked={groupState(selectedModules, ids)}
                      onCheckedChange={(c) =>
                        setModules((list) => (c === true ? [...new Set([...list, ...ids])] : list.filter((id) => !ids.includes(id))))
                      }
                    />
                    <Label htmlFor={`${uid}-group-${group.id}`} className="font-semibold">{group.label}</Label>
                  </div>
                  <ul className="grid gap-3 p-4">
                    {group.modules.map((m) => {
                      const unmet = missingRequirements.get(m.id);
                      return (
                        <li key={m.id} className="flex gap-3">
                          <Checkbox
                            id={`${uid}-m-${m.id}`}
                            className="mt-0.5"
                            checked={selectedModules.has(m.id)}
                            onCheckedChange={(c) => setModules((l) => toggle(l, m.id, c === true))}
                            aria-describedby={`${uid}-m-${m.id}-desc`}
                          />
                          <div className="min-w-0">
                            <Label htmlFor={`${uid}-m-${m.id}`} className="flex flex-wrap items-center gap-2 font-medium">
                              {m.label}
                              {unmet ? <Badge variant="warning">Needs input</Badge> : null}
                            </Label>
                            <p id={`${uid}-m-${m.id}-desc`} className="mt-1 text-xs text-muted-foreground">
                              {m.description}
                              {unmet ? ` Requires: ${unmet.map((r) => MODULE_REQUIREMENT_LABELS[r]).join(", ")}.` : ""}
                            </p>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </fieldset>
              );
            })}
          </div>
          {selectedWithUnmet.length > 0 ? (
            <Alert variant="warning">
              <Info />
              <p>
                {selectedWithUnmet.length === 1 ? "1 selected module is" : `${selectedWithUnmet.length} selected modules are`} missing required project
                inputs. Those checks will be recorded as <span className="font-medium">NOT EXECUTED</span> until the inputs are provided — they will never be marked PASS.
              </p>
            </Alert>
          ) : null}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>3. Browsers</CardTitle>
            <CardDescription>Engines the run will use.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            {BROWSER_OPTIONS.map((b) => (
              <div key={b.id} className="flex items-center gap-3">
                <Checkbox id={`${uid}-b-${b.id}`} checked={browsers.includes(b.id)} onCheckedChange={(c) => setBrowsers((l) => toggle(l, b.id, c === true))} />
                <Label htmlFor={`${uid}-b-${b.id}`} className="font-normal">{b.label}</Label>
              </div>
            ))}
            {e.browsers ? <p className="text-xs text-destructive" role="alert">{e.browsers}</p> : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>4. Viewports</CardTitle>
            <CardDescription>Screen sizes for each page.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            {(["desktop", "mobile"] as const).map((kind) => (
              <fieldset key={kind} className="grid content-start gap-3">
                <legend className="mb-1 flex items-center gap-2 text-sm font-medium">
                  {kind === "desktop" ? <Monitor className="size-4 text-muted-foreground" aria-hidden /> : <Smartphone className="size-4 text-muted-foreground" aria-hidden />}
                  {kind === "desktop" ? "Desktop" : "Mobile"}
                </legend>
                {VIEWPORTS.filter((v) => v.kind === kind).map((v) => (
                  <div key={v.id} className="flex items-center gap-3">
                    <Checkbox id={`${uid}-v-${v.id}`} checked={viewports.includes(v.id)} onCheckedChange={(c) => setViewports((l) => toggle(l, v.id, c === true))} />
                    <Label htmlFor={`${uid}-v-${v.id}`} className="font-normal tabular-nums">{v.width}×{v.height}</Label>
                  </div>
                ))}
              </fieldset>
            ))}
            {e.viewports ? <p className="text-xs text-destructive sm:col-span-2" role="alert">{e.viewports}</p> : null}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>5. Reports</CardTitle>
          <CardDescription>Formats and sections to generate after a run completes. Report generation is enabled in a later phase.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6 md:grid-cols-2">
          <fieldset className="grid content-start gap-3">
            <legend className="mb-1 text-sm font-medium">Formats</legend>
            {REPORT_FORMAT_OPTIONS.map((f) => (
              <div key={f.id} className="flex gap-3">
                <Checkbox id={`${uid}-f-${f.id}`} className="mt-0.5" checked={reportFormats.includes(f.id)} onCheckedChange={(c) => setReportFormats((l) => toggle(l, f.id, c === true))} />
                <div>
                  <Label htmlFor={`${uid}-f-${f.id}`}>{f.label}</Label>
                  <p className="text-xs text-muted-foreground">{f.description}</p>
                </div>
              </div>
            ))}
          </fieldset>
          <fieldset className="grid content-start gap-3">
            <legend className="mb-1 text-sm font-medium">Sections</legend>
            {REPORT_SECTION_OPTIONS.map((s) => (
              <div key={s.id} className="flex items-center gap-3">
                <Checkbox
                  id={`${uid}-s-${s.id}`}
                  checked={reportSections[s.id]}
                  onCheckedChange={(c) => setReportSections((r) => ({ ...r, [s.id]: c === true }))}
                />
                <Label htmlFor={`${uid}-s-${s.id}`} className="font-normal">{s.label}</Label>
              </div>
            ))}
          </fieldset>
        </CardContent>
      </Card>

      <div className="fixed inset-x-0 bottom-0 z-20 border-t bg-card/95 backdrop-blur lg:left-64">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
          <p className="text-sm text-muted-foreground">
            {modules.length} modules · {browsers.length} browsers · {viewports.length} viewports
          </p>
          <div className="flex gap-2">
            <Button variant="outline" asChild>
              <Link href={`/projects/${project.id}`}>Cancel</Link>
            </Button>
            <Button type="submit" disabled={pending} aria-busy={pending}>
              {pending ? "Saving…" : state.configurationId ? "Save changes" : "Save configuration"}
            </Button>
            {state.configurationId ? (
              <Button variant="secondary" asChild>
                <Link href={`/test-runs/new?project=${project.id}&config=${state.configurationId}`}>Start run</Link>
              </Button>
            ) : (
              <Button type="button" variant="secondary" disabled title="Save the configuration first">
                Start run
              </Button>
            )}
          </div>
        </div>
      </div>
    </form>
  );
}
