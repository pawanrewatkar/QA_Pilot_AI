"use client";

import { CircleAlert, CirclePlay, FileSpreadsheet, FolderOpen, Info, Link2, LoaderCircle, Monitor, Smartphone, Tablet, TriangleAlert, Upload } from "lucide-react";
import { useId, useMemo, useState, useTransition } from "react";
import { inspectSheetAction, loadWorkbookAction, startExecutionAction } from "@/app/external-test-cases/actions";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, Input, Label, NativeSelect } from "@/components/ui/form-controls";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { BROWSER_OPTIONS, TABLET_VIEWPORTS, VIEWPORTS } from "@/lib/constants/testing";
import { validateMapping } from "@/lib/external-tests/mapping";
import { CASE_FIELD_LABELS, CASE_FIELDS, type CaseField, type ColumnMapping, type OutputMode, type SourceKind } from "@/lib/external-tests/types";
import type { DraftInspection, SheetInspection } from "@/lib/services/external-tests";
import { cn } from "@/lib/utils";
import type { BrowserName, Viewport } from "@/types";

const DEVICE_GROUPS: { kind: Viewport["kind"]; label: string; icon: typeof Monitor; profiles: Viewport[] }[] = [
  { kind: "desktop", label: "Desktop", icon: Monitor, profiles: VIEWPORTS.filter((v) => v.kind === "desktop") },
  { kind: "mobile", label: "Mobile", icon: Smartphone, profiles: VIEWPORTS.filter((v) => v.kind === "mobile") },
  { kind: "tablet", label: "Tablet", icon: Tablet, profiles: TABLET_VIEWPORTS },
];
const DEFAULT_PROFILE: Record<Viewport["kind"], string> = { desktop: "desktop-1440x900", mobile: "mobile-390x844", tablet: "tablet-768x1024" };
const SOURCES: { id: SourceKind; label: string; icon: typeof Upload }[] = [
  { id: "UPLOAD", label: "Upload Excel", icon: Upload },
  { id: "LOCAL_PATH", label: "Local file path", icon: FolderOpen },
  { id: "GOOGLE_DRIVE", label: "Google Drive link", icon: Link2 },
];
const toggle = <T,>(list: T[], v: T, on: boolean) => (on ? (list.includes(v) ? list : [...list, v]) : list.filter((x) => x !== v));

function Section({ n, title, description, children, disabled }: { n: number; title: string; description?: React.ReactNode; children: React.ReactNode; disabled?: boolean }) {
  return (
    <Card aria-disabled={disabled || undefined} className={cn(disabled && "opacity-60")}>
      <CardHeader>
        <CardTitle>
          {n}. {title}
        </CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export function ExecutionWizard({ projects, localDir, maxUploadMb, today }: { projects: { id: string; name: string; websiteUrl: string }[]; localDir: string; maxUploadMb: number; today: string }) {
  const uid = useId();
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [projectId, setProjectId] = useState("");
  const [name, setName] = useState("");
  const [source, setSource] = useState<SourceKind>("UPLOAD");
  const [file, setFile] = useState<File | null>(null);
  const [path, setPath] = useState("");
  const [link, setLink] = useState("");
  const [draft, setDraft] = useState<DraftInspection | null>(null);
  const [sheet, setSheet] = useState<SheetInspection | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [viewports, setViewports] = useState<string[]>([DEFAULT_PROFILE.desktop]);
  const [browsers, setBrowsers] = useState<BrowserName[]>(["chromium"]);
  const [outputMode, setOutputMode] = useState<OutputMode>("NEW_SHEET");
  const [allowSubmit, setAllowSubmit] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, startLoading] = useTransition();
  const [starting, startStarting] = useTransition();

  const validation = useMemo(() => (sheet ? validateMapping(mapping, sheet.columns) : null), [mapping, sheet]);
  const header = (col: number | undefined) => sheet?.columns.find((c) => c.index === col)?.header;
  const devicesChosen = DEVICE_GROUPS.filter((g) => g.profiles.some((p) => viewports.includes(p.id))).map((g) => g.kind);
  const ready = !!draft && !!sheet && !!validation?.ok && !!websiteUrl.trim() && viewports.length > 0 && browsers.length > 0;

  const applySheet = (s: SheetInspection) => {
    setSheet(s);
    setMapping(s.mapping);
  };

  const load = () => {
    setError(null);
    const fd = new FormData();
    fd.set("sourceKind", source);
    if (source === "UPLOAD") {
      if (!file) return setError("Choose an Excel file to upload.");
      fd.set("file", file);
    } else if (source === "LOCAL_PATH") fd.set("path", path);
    else fd.set("link", link);
    startLoading(async () => {
      const res = await loadWorkbookAction(fd);
      if (!res.ok) {
        setDraft(null);
        setSheet(null);
        return setError(res.error);
      }
      setDraft(res.value);
      applySheet(res.value.sheet);
    });
  };

  const chooseSheet = (sheetName: string) => {
    if (!draft) return;
    setError(null);
    startLoading(async () => {
      const res = await inspectSheetAction(draft.draftId, sheetName);
      if (!res.ok) return setError(res.error);
      applySheet(res.value);
    });
  };

  const start = () => {
    if (!draft || !sheet) return;
    setError(null);
    startStarting(async () => {
      const res = await startExecutionAction({
        draftId: draft.draftId,
        sourceKind: draft.sourceKind,
        sourceName: draft.sourceName,
        fileName: draft.fileName,
        websiteUrl,
        projectId: projectId || null,
        name: name || null,
        sheetName: sheet.name,
        mapping,
        browsers,
        viewports,
        outputMode,
        allowFormSubmission: allowSubmit,
      });
      // On success the action redirects; only errors return here.
      if (res?.error) setError(res.error);
    });
  };

  return (
    <div className="space-y-6 pb-24">
      {error ? (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertTitle>{error}</AlertTitle>
        </Alert>
      ) : null}

      <Section n={1} title="Website" description="The site the test cases are executed against. It is checked for reachability before the execution starts.">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Field id={`${uid}-url`} label="Website URL" required>
            <Input id={`${uid}-url`} type="url" inputMode="url" placeholder="https://example.com" value={websiteUrl} onChange={(e) => setWebsiteUrl(e.target.value)} />
          </Field>
          <Field id={`${uid}-project`} label="Project" hint="Results, evidence and bugs are stored under this project.">
            <NativeSelect id={`${uid}-project`} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">Automatic (reuse or create a project for this website)</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.websiteUrl}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field id={`${uid}-name`} label="Execution name">
            <Input id={`${uid}-name`} maxLength={100} placeholder="e.g. Sprint 14 regression" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
        </div>
      </Section>

      <Section n={2} title="Test case source" description={`Excel workbooks (.xlsx / .xlsm), up to ${maxUploadMb} MB. The original file is never modified.`}>
        <div className="space-y-4">
          <div role="radiogroup" aria-label="Test case source" className="flex flex-wrap gap-2">
            {SOURCES.map((s) => (
              <Button key={s.id} type="button" role="radio" aria-checked={source === s.id} variant={source === s.id ? "default" : "outline"} onClick={() => setSource(s.id)}>
                <s.icon /> {s.label}
              </Button>
            ))}
          </div>
          {source === "UPLOAD" ? (
            <Field id={`${uid}-file`} label="Excel file" required>
              <Input id={`${uid}-file`} type="file" accept=".xlsx,.xlsm,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </Field>
          ) : source === "LOCAL_PATH" ? (
            <Field id={`${uid}-path`} label="Path inside the test-case folder" required hint={<>For safety only files inside <span className="font-mono">{localDir}</span> can be read (set EXTERNAL_TEST_CASES_DIR to change it).</>}>
              <Input id={`${uid}-path`} placeholder="regression/test-cases.xlsx" value={path} onChange={(e) => setPath(e.target.value)} />
            </Field>
          ) : (
            <Field id={`${uid}-link`} label="Google Drive or Google Sheets link" required hint="The file must be shared as “Anyone with the link can view”. Private Drive access (OAuth) is not available yet.">
              <Input id={`${uid}-link`} type="url" placeholder="https://docs.google.com/spreadsheets/d/…" value={link} onChange={(e) => setLink(e.target.value)} />
            </Field>
          )}
          <Button type="button" variant="secondary" onClick={load} disabled={loading} aria-busy={loading}>
            {loading ? <LoaderCircle className="animate-spin" aria-hidden /> : <FileSpreadsheet />} {loading ? "Reading workbook…" : "Load workbook"}
          </Button>
        </div>
      </Section>

      <Section n={3} title="Workbook" disabled={!draft}>
        {draft ? (
          <p className="text-sm">
            <span className="font-medium">{draft.fileName}</span> <span className="text-muted-foreground">· {draft.sourceName} · {draft.sheets.length} worksheet(s)</span>
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">Load a workbook to continue.</p>
        )}
      </Section>

      <Section n={4} title="Worksheet" disabled={!draft}>
        {draft && sheet ? (
          <div className="flex flex-wrap items-end gap-4">
            <Field id={`${uid}-sheet`} label="Worksheet to execute" required>
              <NativeSelect id={`${uid}-sheet`} value={sheet.name} onChange={(e) => chooseSheet(e.target.value)} disabled={loading}>
                {draft.sheets.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </NativeSelect>
            </Field>
            <p className="text-sm text-muted-foreground">
              Header row {sheet.headerRow} · {sheet.totalRows} test case row(s){sheet.truncatedRows ? ` (${sheet.truncatedRows} more rows beyond the limit are not read)` : ""} · empty rows ignored
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Available after the workbook is loaded.</p>
        )}
      </Section>

      <Section n={5} title="Column mapping" description="Detected automatically from the headers. Correct any field that is wrong; nothing in the workbook is changed." disabled={!sheet}>
        {sheet ? (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {CASE_FIELDS.map((f: CaseField) => (
                <Field key={f} id={`${uid}-map-${f}`} label={CASE_FIELD_LABELS[f]} required={f === "expected" || f === "title"}>
                  <NativeSelect
                    id={`${uid}-map-${f}`}
                    value={mapping[f] ?? ""}
                    onChange={(e) => setMapping((m) => ({ ...m, [f]: e.target.value ? Number(e.target.value) : undefined }))}
                  >
                    <option value="">Not mapped</option>
                    {sheet.columns.map((c) => (
                      <option key={c.index} value={c.index}>
                        {c.header}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">Test Case (or Test Scenario instead) and Expected Result are required. Test Steps are optional; without them steps are inferred only where the test case clearly describes them.</p>
            {validation?.errors.map((e) => (
              <p key={e} className="text-sm text-destructive-text" role="alert">
                {e}
              </p>
            ))}
            {validation?.ok && validation.warnings.map((w) => (
              <p key={w} className="text-sm text-warning-text">
                {w}
              </p>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Available after the workbook is loaded.</p>
        )}
      </Section>

      <Section n={6} title="Test case preview" description="The first rows as they will be read with this mapping." disabled={!sheet}>
        {sheet && sheet.preview.length ? (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Row</TableHead>
                  <TableHead>{header(mapping.caseId) ?? "Test Case ID"}</TableHead>
                  <TableHead>{header(mapping.title) ?? header(mapping.scenario) ?? "Test Case"}</TableHead>
                  <TableHead className="hidden md:table-cell">{header(mapping.steps) ?? "Test Steps"}</TableHead>
                  <TableHead>{header(mapping.expected) ?? "Expected Result"}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sheet.preview.map((r) => (
                  <TableRow key={r.rowNumber} className="align-top">
                    <TableCell className="tabular-nums text-muted-foreground">{r.rowNumber}</TableCell>
                    <TableCell className="font-mono text-xs">{mapping.caseId ? r.cells[mapping.caseId] : "—"}</TableCell>
                    <TableCell className="min-w-48">{(mapping.title ? r.cells[mapping.title] : undefined) ?? (mapping.scenario ? r.cells[mapping.scenario] : undefined) ?? <span className="text-muted-foreground">— (skipped)</span>}</TableCell>
                    <TableCell className="hidden max-w-80 whitespace-pre-wrap text-xs md:table-cell">{mapping.steps ? (r.cells[mapping.steps] ?? <span className="text-muted-foreground">none</span>) : "—"}</TableCell>
                    <TableCell className="max-w-80 whitespace-pre-wrap text-xs">{mapping.expected ? (r.cells[mapping.expected] ?? "—") : "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{sheet ? "This worksheet has no test case rows." : "Available after the workbook is loaded."}</p>
        )}
      </Section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Section n={7} title="Devices" description="Every test case runs on each selected device profile.">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {DEVICE_GROUPS.map((g) => {
              const on = g.profiles.some((p) => viewports.includes(p.id));
              return (
                <fieldset key={g.kind} className="grid content-start gap-2">
                  <legend className="mb-1 flex items-center gap-2 text-sm font-medium">
                    <Checkbox
                      id={`${uid}-dev-${g.kind}`}
                      checked={on}
                      onCheckedChange={(c) => setViewports((l) => (c === true ? toggle(l, DEFAULT_PROFILE[g.kind], true) : l.filter((id) => !g.profiles.some((p) => p.id === id))))}
                      aria-label={g.label}
                    />
                    <g.icon className="size-4 text-muted-foreground" aria-hidden />
                    <label htmlFor={`${uid}-dev-${g.kind}`}>{g.label}</label>
                  </legend>
                  {g.profiles.map((p) => (
                    <div key={p.id} className="flex items-center gap-2 pl-6">
                      <Checkbox id={`${uid}-vp-${p.id}`} checked={viewports.includes(p.id)} onCheckedChange={(c) => setViewports((l) => toggle(l, p.id, c === true))} />
                      <Label htmlFor={`${uid}-vp-${p.id}`} className="font-normal tabular-nums">
                        {p.width}×{p.height}
                      </Label>
                    </div>
                  ))}
                </fieldset>
              );
            })}
          </div>
          {!viewports.length ? <p className="mt-2 text-xs text-destructive-text" role="alert">Select at least one device.</p> : null}
        </Section>

        <Section n={8} title="Browsers">
          <div className="grid gap-3">
            {BROWSER_OPTIONS.map((b) => (
              <div key={b.id} className="flex items-center gap-3">
                <Checkbox id={`${uid}-b-${b.id}`} checked={browsers.includes(b.id)} onCheckedChange={(c) => setBrowsers((l) => toggle(l, b.id, c === true))} />
                <Label htmlFor={`${uid}-b-${b.id}`} className="font-normal">{b.label}</Label>
              </div>
            ))}
            {!browsers.length ? <p className="text-xs text-destructive-text" role="alert">Select at least one browser.</p> : null}
          </div>
        </Section>
      </div>

      <Section n={9} title="Result output" description="Earlier results are never overwritten: when result columns already contain data, a new set (Actual Result 2, Status 2, Date 2, …) is added.">
        <div role="radiogroup" aria-label="Result output" className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {(
            [
              { id: "NEW_SHEET", label: "New Result Sheet", text: "Adds a new worksheet with all original columns plus Actual Result, Status and Date. The original sheet is left untouched." },
              { id: "EXISTING_SHEET", label: "Existing Sheet", text: sheet ? `Adds the results to “${sheet.name}”: ${sheet.existingSheetTarget}.` : "Adds the results to the selected worksheet." },
            ] as const
          ).map((o) => (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={outputMode === o.id}
              onClick={() => setOutputMode(o.id)}
              className={cn("rounded-lg border p-4 text-left text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none", outputMode === o.id ? "border-primary bg-primary/5" : "hover:bg-muted/50")}
            >
              <span className="font-medium">{o.label}</span>
              <span className="mt-1 block text-muted-foreground">{o.text}</span>
            </button>
          ))}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">The result file is downloaded as QA_External_Test_Result_&lt;website&gt;_&lt;date&gt;.xlsx; the uploaded workbook itself is never changed.</p>
      </Section>

      <Section n={10} title="Test date">
        <p className="text-sm">
          <Badge variant="secondary" className="mr-2">{today}</Badge>
          The Date column records the actual execution date of each test case from the system clock.
        </p>
      </Section>

      <Section n={11} title="Safety">
        <div className="flex items-start gap-3">
          <Checkbox id={`${uid}-submit`} checked={allowSubmit} onCheckedChange={(c) => setAllowSubmit(c === true)} className="mt-0.5" />
          <div className="space-y-1">
            <Label htmlFor={`${uid}-submit`}>Allow real form submissions</Label>
            <p className="text-xs text-muted-foreground">
              Off by default: forms are filled and validated, but submissions are intercepted in the browser, so cases that depend on a real submission are NOT EXECUTED. When on, each form is submitted at most
              once and email fields use only the project&apos;s Test Email. Payments, orders, CAPTCHAs, OTPs and real inboxes always need human interaction.
            </p>
          </div>
        </div>
        {allowSubmit ? (
          <Alert variant="warning" className="mt-3">
            <TriangleAlert />
            <p>Only enable this for websites you are authorized to test. Real submissions reach the site&apos;s server.</p>
          </Alert>
        ) : null}
      </Section>

      <Alert>
        <Info />
        <p>
          Statuses: PASS (expected behaviour verified), FAIL (verified not achieved, with evidence), HUMAN INTERACTION (a person must check it; highlighted yellow), NOT EXECUTED (could not run, reason given),
          NOT APPLICABLE (does not apply to the device).
        </p>
      </Alert>

      <div className="fixed inset-x-0 bottom-0 z-20 border-t bg-card/95 backdrop-blur lg:left-64">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
          <p className="text-sm text-muted-foreground">
            {sheet ? `${sheet.totalRows} test case row(s)` : "No workbook loaded"} × {browsers.length} browser(s) × {viewports.length} device profile(s)
            {devicesChosen.length ? ` (${devicesChosen.join(", ")})` : ""}
          </p>
          <Button type="button" onClick={start} disabled={!ready || starting} aria-busy={starting}>
            {starting ? <LoaderCircle className="animate-spin" aria-hidden /> : <CirclePlay />} {starting ? "Starting…" : "Start test"}
          </Button>
        </div>
      </div>
    </div>
  );
}
