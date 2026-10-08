"use client";

import { CircleAlert, CirclePlay, Info, Monitor, Search, Smartphone, TriangleAlert } from "lucide-react";
import { startTransition, useActionState, useId, useMemo, useState } from "react";
import { createTestRunAction, type TestRunFormState } from "@/app/test-runs/actions";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, Input, Label, NativeSelect, Textarea } from "@/components/ui/form-controls";
import { BROWSER_OPTIONS, IMPLEMENTED_MODULE_IDS, REPORT_FORMAT_OPTIONS, TEST_MODULE_GROUPS, TEST_SCOPE_OPTIONS, VIEWPORTS } from "@/lib/constants/testing";
import { cn } from "@/lib/utils";
import {
  CONTENT_EXCLUSIONS,
  DEFAULT_ADVANCED_OPTIONS,
  GENERATED_REPORT_FORMATS,
  PAGE_TYPE_LABELS,
  type GeneratedReportFormat,
  type BrowserName,
  type ContentComparisonMode,
  type ContentExclusion,
  type PageRecord,
  type PageType,
  type PerformanceFormFactor,
  type TestConfiguration,
  type TypographyMode,
} from "@/types";

/** Report formats saved on a configuration that the generator supports. */
const reportFormatsOf = (c: TestConfiguration): GeneratedReportFormat[] => GENERATED_REPORT_FORMATS.filter((f) => c.reportFormats.includes(f));

interface Props {
  project: { id: string; name: string; hasTestEmail: boolean };
  configurations: TestConfiguration[];
  pages: PageRecord[];
  /** Page ids matching each configuration's scope, resolved on the server. */
  configurationPages: Record<string, string[]>;
  initialConfigurationId: string | null;
}

const toggle = <T,>(list: T[], v: T, on: boolean) => (on ? (list.includes(v) ? list : [...list, v]) : list.filter((x) => x !== v));
const IMPLEMENTED = new Set(IMPLEMENTED_MODULE_IDS);

export function TestRunForm({ project, configurations, pages, configurationPages, initialConfigurationId }: Props) {
  const uid = useId();
  const [state, dispatch, pending] = useActionState<TestRunFormState, unknown>(createTestRunAction, { errors: {} });
  const testable = useMemo(() => pages.filter((p) => p.crawlStatus !== "FAILED" && p.crawlStatus !== "SKIPPED"), [pages]);
  const defaultSelection = useMemo(() => testable.filter((p) => p.isSelected).map((p) => p.id), [testable]);

  const initial = configurations.find((c) => c.id === initialConfigurationId) ?? null;
  const [configurationId, setConfigurationId] = useState<string | null>(initial?.id ?? null);
  const [name, setName] = useState("");
  const [pageIds, setPageIds] = useState<string[]>(initial ? (configurationPages[initial.id] ?? []) : defaultSelection);
  const [modules, setModules] = useState<string[]>(initial?.modules ?? ["links", "navigation", "functional", "console", "network"]);
  const [browsers, setBrowsers] = useState<BrowserName[]>(initial?.browsers ?? ["chromium"]);
  const [viewports, setViewports] = useState<string[]>(initial?.viewports ?? ["desktop-1440x900"]);
  const [allowFormSubmission, setAllowFormSubmission] = useState(false);
  const [maxLinksPerPage, setMaxLinksPerPage] = useState(100);
  const [timeout, setTimeoutSeconds] = useState(30);
  const [typographyMode, setTypographyMode] = useState<TypographyMode>(DEFAULT_ADVANCED_OPTIONS.typographyMode);
  const [contentMode, setContentMode] = useState<ContentComparisonMode>(DEFAULT_ADVANCED_OPTIONS.content.mode);
  const [contentExclusions, setContentExclusions] = useState<ContentExclusion[]>([...DEFAULT_ADVANCED_OPTIONS.content.exclusions]);
  const [contentCustomSelectors, setContentCustomSelectors] = useState("");
  const [formFactors, setFormFactors] = useState<PerformanceFormFactor[]>([...DEFAULT_ADVANCED_OPTIONS.performance.formFactors]);
  const [reportFormats, setReportFormats] = useState<GeneratedReportFormat[]>(initial ? reportFormatsOf(initial) : [...GENERATED_REPORT_FORMATS]);
  const [search, setSearch] = useState("");
  const [type, setType] = useState<PageType | "">("");

  const applyConfiguration = (id: string) => {
    const config = configurations.find((c) => c.id === id) ?? null;
    setConfigurationId(config?.id ?? null);
    if (!config) return;
    setModules(config.modules);
    setBrowsers(config.browsers);
    setViewports(config.viewports);
    setPageIds(configurationPages[config.id] ?? []);
    setReportFormats(reportFormatsOf(config));
  };

  const shown = testable.filter((p) => (!type || p.pageType === type) && (!search.trim() || `${p.url} ${p.name ?? ""}`.toLowerCase().includes(search.trim().toLowerCase())));
  const units = pageIds.length * browsers.length * viewports.length;
  const unimplementedSelected = modules.filter((m) => !IMPLEMENTED.has(m));
  const config = configurations.find((c) => c.id === configurationId);
  const e = state.errors;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    startTransition(() =>
      dispatch({
        projectId: project.id,
        configurationId,
        name,
        pageIds,
        modules,
        browsers,
        viewports,
        allowFormSubmission,
        maxLinksPerPage,
        navigationTimeoutSeconds: timeout,
        typographyMode,
        contentMode,
        contentExclusions,
        contentCustomSelectors,
        performanceFormFactors: formFactors,
        reportFormats,
      }),
    );
  };

  return (
    <form onSubmit={submit} className="space-y-6 pb-24" noValidate>
      {Object.keys(e).length ? (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertTitle>{e.form ?? e.projectId ?? "The run could not be created. Review the highlighted sections."}</AlertTitle>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>1. Run configuration</CardTitle>
          <CardDescription>Start from a saved configuration or choose everything below.</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field id={`${uid}-config`} label="Configuration" error={e.configurationId}>
            <NativeSelect id={`${uid}-config`} value={configurationId ?? ""} onChange={(ev) => (ev.target.value ? applyConfiguration(ev.target.value) : setConfigurationId(null))}>
              <option value="">Custom (no saved configuration)</option>
              {configurations.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} — {TEST_SCOPE_OPTIONS.find((s) => s.id === c.scope)?.label}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field id={`${uid}-name`} label="Run name" error={e.name}>
            <Input id={`${uid}-name`} value={name} onChange={(ev) => setName(ev.target.value)} maxLength={100} placeholder="e.g. Release 2.3 smoke test" />
          </Field>
          {config?.scope === "MANUAL_URLS" && (configurationPages[config.id]?.length ?? 0) < config.manualUrls.length ? (
            <Alert variant="warning" className="md:col-span-2">
              <TriangleAlert />
              <p>
                {config.manualUrls.length - (configurationPages[config.id]?.length ?? 0)} of this configuration&apos;s manual URLs are not in the project&apos;s page list yet. Add them
                on the Pages &amp; crawl screen to include them.
              </p>
            </Alert>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle>2. Pages</CardTitle>
            <CardDescription>
              {pageIds.length} of {testable.length} testable pages selected.
            </CardDescription>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setPageIds([...new Set([...pageIds, ...shown.map((p) => p.id)])])}>
              Select shown
            </Button>
            <Button variant="outline" size="sm" onClick={() => setPageIds(pageIds.filter((id) => !shown.some((p) => p.id === id)))}>
              Clear shown
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {e.pageIds ? <p className="text-sm text-destructive-text" role="alert">{e.pageIds}</p> : null}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input aria-label="Search pages" type="search" className="pl-9" placeholder="Search pages" value={search} onChange={(ev) => setSearch(ev.target.value)} />
            </div>
            <NativeSelect aria-label="Filter by page type" value={type} onChange={(ev) => setType(ev.target.value as PageType | "")}>
              <option value="">All page types</option>
              {[...new Set(testable.map((p) => p.pageType))].map((t) => (
                <option key={t} value={t}>{PAGE_TYPE_LABELS[t]}</option>
              ))}
            </NativeSelect>
          </div>
          <ul className="max-h-80 divide-y overflow-y-auto rounded-lg border">
            {shown.map((p) => (
              <li key={p.id} className="flex items-center gap-3 px-3 py-2">
                <Checkbox id={`${uid}-p-${p.id}`} checked={pageIds.includes(p.id)} onCheckedChange={(c) => setPageIds((l) => toggle(l, p.id, c === true))} />
                <Label htmlFor={`${uid}-p-${p.id}`} className="flex min-w-0 flex-1 items-center gap-2 font-normal">
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium">{p.name ?? p.title ?? "Page"}</span> <span className="font-mono text-xs text-muted-foreground">{p.url.replace(/^https?:\/\//, "")}</span>
                  </span>
                  <Badge variant="secondary">{PAGE_TYPE_LABELS[p.pageType]}</Badge>
                </Label>
              </li>
            ))}
            {shown.length === 0 ? <li className="px-3 py-6 text-center text-sm text-muted-foreground">No pages match.</li> : null}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle>3. Modules</CardTitle>
            <CardDescription>
              {modules.length} selected. Checks that cannot run (e.g. Figma without design data, semantic content without an AI provider) are recorded as NOT EXECUTED, never as passed.
            </CardDescription>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setModules(TEST_MODULE_GROUPS.flatMap((g) => g.modules.map((m) => m.id)).filter((id) => IMPLEMENTED.has(id)))}>
              All available
            </Button>
            <Button variant="outline" size="sm" onClick={() => setModules([])}>
              Clear
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {e.modules ? <p className="text-sm text-destructive-text" role="alert">{e.modules}</p> : null}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {TEST_MODULE_GROUPS.map((group) => (
              <fieldset key={group.id} className="rounded-lg border p-3">
                <legend className="px-1 text-sm font-semibold">{group.label}</legend>
                <ul className="grid gap-2">
                  {group.modules.map((m) => (
                    <li key={m.id} className="flex items-center gap-2">
                      <Checkbox id={`${uid}-m-${m.id}`} checked={modules.includes(m.id)} onCheckedChange={(c) => setModules((l) => toggle(l, m.id, c === true))} />
                      <Label htmlFor={`${uid}-m-${m.id}`} className={cn("flex flex-wrap items-center gap-1.5 font-normal", !IMPLEMENTED.has(m.id) && "text-muted-foreground")}>
                        {m.label}
                        {!IMPLEMENTED.has(m.id) ? <Badge variant="outline">not available</Badge> : null}
                      </Label>
                    </li>
                  ))}
                </ul>
              </fieldset>
            ))}
          </div>
          {unimplementedSelected.length ? (
            <Alert>
              <Info />
              <p>{unimplementedSelected.length} selected module(s) are not implemented yet and will be reported as NOT EXECUTED, never as passed.</p>
            </Alert>
          ) : null}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>4. Browsers</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            {BROWSER_OPTIONS.map((b) => (
              <div key={b.id} className="flex items-center gap-3">
                <Checkbox id={`${uid}-b-${b.id}`} checked={browsers.includes(b.id)} onCheckedChange={(c) => setBrowsers((l) => toggle(l, b.id, c === true))} />
                <Label htmlFor={`${uid}-b-${b.id}`} className="font-normal">{b.label}</Label>
              </div>
            ))}
            {e.browsers ? <p className="text-xs text-destructive-text" role="alert">{e.browsers}</p> : null}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>5. Viewports</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
            {e.viewports ? <p className="text-xs text-destructive-text sm:col-span-2" role="alert">{e.viewports}</p> : null}
          </CardContent>
        </Card>
      </div>

      {modules.some((m) => ["typography", "content", "performance"].includes(m)) ? (
        <Card>
          <CardHeader>
            <CardTitle>Advanced module options</CardTitle>
            <CardDescription>Settings for the typography, content comparison and performance modules selected above.</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            {modules.includes("typography") ? (
              <Field id={`${uid}-typo`} label="Typography reporting mode" required hint="Without a Figma or reference source, measured values are reported without invented expectations.">
                <NativeSelect id={`${uid}-typo`} value={typographyMode} onChange={(ev) => setTypographyMode(ev.target.value as TypographyMode)}>
                  <option value="TYPOGRAPHY_ONLY">Typography only</option>
                  <option value="TYPOGRAPHY_TAGS">Typography + HTML tags</option>
                  <option value="TYPOGRAPHY_CONTENT">Typography + content</option>
                  <option value="COMPLETE_UI">Complete measurable UI</option>
                </NativeSelect>
              </Field>
            ) : null}
            {modules.includes("content") ? (
              <div className="grid content-start gap-3">
                <Field id={`${uid}-cmode`} label="Content comparison mode" required hint="Compares pages with the project's reference document (PDF, DOCX, Markdown or text).">
                  <NativeSelect id={`${uid}-cmode`} value={contentMode} onChange={(ev) => setContentMode(ev.target.value as ContentComparisonMode)}>
                    <option value="EXACT">Exact comparison</option>
                    <option value="SECTION">Section comparison</option>
                    <option value="SEMANTIC">Semantic comparison (needs an AI provider)</option>
                  </NativeSelect>
                </Field>
                {contentMode === "SEMANTIC" ? <p className="text-xs text-warning-text">No AI provider is configured, so semantic comparison will be recorded as NOT EXECUTED.</p> : null}
                <fieldset className="grid grid-cols-2 gap-2">
                  <legend className="mb-1 text-sm font-medium">Exclude from comparison</legend>
                  {CONTENT_EXCLUSIONS.map((x) => (
                    <div key={x} className="flex items-center gap-2">
                      <Checkbox id={`${uid}-ex-${x}`} checked={contentExclusions.includes(x)} onCheckedChange={(c) => setContentExclusions((l) => toggle(l, x, c === true))} />
                      <Label htmlFor={`${uid}-ex-${x}`} className="font-normal capitalize">{x}</Label>
                    </div>
                  ))}
                </fieldset>
                <Field id={`${uid}-csel`} label="Other sections to exclude" hint="CSS selectors, one per line (e.g. .newsletter-signup).">
                  <Textarea id={`${uid}-csel`} rows={2} className="font-mono text-xs" value={contentCustomSelectors} onChange={(ev) => setContentCustomSelectors(ev.target.value)} />
                </Field>
              </div>
            ) : null}
            {modules.includes("performance") ? (
              <fieldset className="grid content-start gap-3">
                <legend className="mb-1 text-sm font-medium">Lighthouse form factors</legend>
                {(["desktop", "mobile"] as const).map((ff) => (
                  <div key={ff} className="flex items-center gap-2">
                    <Checkbox id={`${uid}-ff-${ff}`} checked={formFactors.includes(ff)} onCheckedChange={(c) => setFormFactors((l) => toggle(l, ff, c === true))} />
                    <Label htmlFor={`${uid}-ff-${ff}`} className="font-normal capitalize">{ff}</Label>
                  </div>
                ))}
                <p className="text-xs text-muted-foreground">Runs Lighthouse locally (no Google API). Each form factor adds roughly 10 seconds per page.</p>
              </fieldset>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>6. Reports</CardTitle>
          <CardDescription>Generated automatically by the worker when the run completes, and listed in the Report Center. Leave all unchecked to generate reports later from the run page.</CardDescription>
        </CardHeader>
        <CardContent>
          <fieldset className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <legend className="sr-only">Report types</legend>
            {REPORT_FORMAT_OPTIONS.map((f) => (
              <div key={f.id} className="flex items-start gap-3">
                <Checkbox
                  id={`${uid}-r-${f.id}`}
                  className="mt-0.5"
                  checked={reportFormats.includes(f.id as GeneratedReportFormat)}
                  onCheckedChange={(c) => setReportFormats((l) => toggle(l, f.id as GeneratedReportFormat, c === true))}
                />
                <div>
                  <Label htmlFor={`${uid}-r-${f.id}`}>{f.label}</Label>
                  <p className="text-xs text-muted-foreground">{f.description}</p>
                </div>
              </div>
            ))}
          </fieldset>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>7. Safety &amp; limits</CardTitle>
          <CardDescription>Form validation is always tested with submissions intercepted in the browser, so nothing is sent unless you allow it here.</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-5 md:grid-cols-3">
          <div className="space-y-2 md:col-span-3">
            <div className="flex items-start gap-3">
              <Checkbox id={`${uid}-submit`} checked={allowFormSubmission} onCheckedChange={(c) => setAllowFormSubmission(c === true)} className="mt-0.5" />
              <div>
                <Label htmlFor={`${uid}-submit`}>Allow real form submissions</Label>
                <p className="text-xs text-muted-foreground">
                  Sends contact/newsletter forms once per form (never repeated, never payments or CAPTCHA-protected forms) and makes one invalid-login attempt.
                  {!project.hasTestEmail ? " This project has no Test Email, so forms that need an email will be NOT EXECUTED." : " Email fields use the project's Test Email."}
                </p>
              </div>
            </div>
            {allowFormSubmission ? (
              <Alert variant="warning">
                <TriangleAlert />
                <p>Only enable this for websites you are authorized to test. Real submissions reach the site&apos;s server and may notify its owners.</p>
              </Alert>
            ) : null}
          </div>
          <Field id={`${uid}-links`} label="Max links checked per page" required error={e.maxLinksPerPage}>
            <Input id={`${uid}-links`} type="number" min={1} max={500} value={maxLinksPerPage} onChange={(ev) => setMaxLinksPerPage(Number(ev.target.value))} />
          </Field>
          <Field id={`${uid}-timeout`} label="Navigation timeout (seconds)" required error={e.navigationTimeoutSeconds}>
            <Input id={`${uid}-timeout`} type="number" min={5} max={120} value={timeout} onChange={(ev) => setTimeoutSeconds(Number(ev.target.value))} />
          </Field>
        </CardContent>
      </Card>

      <div className="fixed inset-x-0 bottom-0 z-20 border-t bg-card/95 backdrop-blur lg:left-64">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
          <p className="text-sm text-muted-foreground">
            {pageIds.length} pages × {browsers.length} browsers × {viewports.length} viewports = <span className="font-medium text-foreground">{units} test units</span>, {modules.length} modules
          </p>
          <Button type="submit" disabled={pending || units === 0 || modules.length === 0} aria-busy={pending}>
            <CirclePlay /> {pending ? "Starting…" : "Start test run"}
          </Button>
        </div>
      </div>
    </form>
  );
}
