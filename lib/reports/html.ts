import type { ReportData, ReportResult } from "./data";

/**
 * Report HTML. One renderer serves two outputs:
 * - "standalone": an interactive single file (inline CSS/JS/SVG, embedded screenshots) that works offline.
 * - "print": a paginated document rendered to PDF by the worker's headless browser.
 * Charts are drawn only from recorded counts; a section without data says so.
 */
export type HtmlMode = "standalone" | "print";

export interface HtmlOptions {
  mode: HtmlMode;
  /** storage key → data: URI, for screenshots that should be embedded. */
  images: Map<string, string>;
}

/** Row caps for the printed report; the standalone and Excel reports carry the full tables. */
const PRINT_RESULT_CAP = 1500;
const PRINT_DETAIL_CAP = 400;

export function esc(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const STATUS_COLOR: Record<string, string> = { PASS: "#0ca30c", FAIL: "#d03b3b", WARNING: "#c98a00", "NOT EXECUTED": "#8a8f98", "NOT APPLICABLE": "#b5b9c0" };
const SEVERITY_COLOR: Record<string, string> = { CRITICAL: "#991b1b", HIGH: "#d03b3b", MEDIUM: "#c98a00", LOW: "#2563eb" };
const fmtDate = (s: string | null) => (s ? new Date(s).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "—");
const viewportLabel = (v: string | null) => (v ? v.replace(/^(desktop|mobile|tablet)-/, (_, k: string) => `${k[0].toUpperCase()}${k.slice(1)} `) : "");
const pill = (s: string | null, colors = STATUS_COLOR) => (s ? `<span class="pill" style="--c:${colors[s] ?? "#6b7280"}">${esc(s.replace(/_/g, " "))}</span>` : "");

// ---------------------------------------------------------------- charts (inline SVG)

function donut(segments: { label: string; value: number; color: string }[], title: string): string {
  const total = segments.reduce((a, s) => a + s.value, 0);
  if (!total) return `<div class="chart empty">${esc(title)}: no data recorded</div>`;
  const r = 60;
  const c = 2 * Math.PI * r;
  let offset = 0;
  const arcs = segments
    .filter((s) => s.value > 0)
    .map((s) => {
      const len = (s.value / total) * c;
      const arc = `<circle r="${r}" cx="80" cy="80" fill="none" stroke="${s.color}" stroke-width="28" stroke-dasharray="${len} ${c - len}" stroke-dashoffset="${-offset}"><title>${esc(s.label)}: ${s.value}</title></circle>`;
      offset += len;
      return arc;
    })
    .join("");
  const legend = segments.map((s) => `<li><i style="background:${s.color}"></i>${esc(s.label)} <b>${s.value}</b></li>`).join("");
  return `<figure class="chart"><figcaption>${esc(title)}</figcaption><div class="donut"><svg viewBox="0 0 160 160" width="160" height="160" role="img" aria-label="${esc(title)}"><g transform="rotate(-90 80 80)">${arcs}</g><text x="80" y="86" text-anchor="middle" class="donut-total">${total}</text></svg><ul class="legend">${legend}</ul></div></figure>`;
}

function bars(items: { label: string; values: { value: number; color: string; name: string }[] }[], title: string): string {
  const max = Math.max(0, ...items.map((i) => i.values.reduce((a, v) => a + v.value, 0)));
  if (!max) return `<div class="chart empty">${esc(title)}: no data recorded</div>`;
  const rowH = 22;
  const labelW = 150;
  const width = 520;
  const h = items.length * rowH + 4;
  const rows = items
    .map((it, i) => {
      let x = labelW;
      const segs = it.values
        .filter((v) => v.value > 0)
        .map((v) => {
          const w = (v.value / max) * (width - labelW - 40);
          const rect = `<rect x="${x}" y="${i * rowH + 3}" width="${w}" height="${rowH - 8}" fill="${v.color}"><title>${esc(it.label)} — ${esc(v.name)}: ${v.value}</title></rect>`;
          x += w;
          return rect;
        })
        .join("");
      const total = it.values.reduce((a, v) => a + v.value, 0);
      return `<text x="${labelW - 6}" y="${i * rowH + 15}" text-anchor="end" class="bar-label">${esc(it.label.length > 22 ? it.label.slice(0, 21) + "…" : it.label)}</text>${segs}<text x="${x + 4}" y="${i * rowH + 15}" class="bar-value">${total}</text>`;
    })
    .join("");
  return `<figure class="chart wide"><figcaption>${esc(title)}</figcaption><svg viewBox="0 0 ${width} ${h}" width="100%" role="img" aria-label="${esc(title)}">${rows}</svg></figure>`;
}

// ---------------------------------------------------------------- tables

interface Col<T> {
  label: string;
  cell: (row: T) => string;
  cls?: string;
}

function table<T>(id: string, rows: T[], cols: Col<T>[], opts: { filters?: { attr: string; label: string; values: string[] }[]; attrs?: (row: T) => Record<string, string>; empty?: string; cap?: number; interactive: boolean }): string {
  if (!rows.length) return `<p class="empty">${esc(opts.empty ?? "No data recorded for this run.")}</p>`;
  const shown = opts.cap ? rows.slice(0, opts.cap) : rows;
  const toolbar = opts.interactive
    ? `<div class="toolbar" data-for="${id}"><input type="search" placeholder="Search…" aria-label="Search table" data-search>${(opts.filters ?? [])
        .filter((f) => f.values.length > 1)
        .map((f) => `<label>${esc(f.label)} <select data-filter="${esc(f.attr)}"><option value="">All</option>${f.values.map((v) => `<option>${esc(v)}</option>`).join("")}</select></label>`)
        .join("")}<span class="count" aria-live="polite"></span></div>`
    : "";
  const body = shown
    .map((r) => {
      const attrs = opts.attrs ? Object.entries(opts.attrs(r)).map(([k, v]) => ` data-${k}="${esc(v)}"`).join("") : "";
      return `<tr${attrs}>${cols.map((c) => `<td${c.cls ? ` class="${c.cls}"` : ""}>${c.cell(r)}</td>`).join("")}</tr>`;
    })
    .join("");
  const note = shown.length < rows.length ? `<p class="note">Showing ${shown.length} of ${rows.length} rows. The Excel testing report contains the complete list.</p>` : "";
  return `${toolbar}<div class="table-wrap"><table id="${id}"><thead><tr>${cols.map((c) => `<th scope="col">${esc(c.label)}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table></div>${note}`;
}

const uniq = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => !!x))].sort();

function detailTable(data: ReportData, viewId: string, interactive: boolean): string {
  const view = data.details[viewId];
  if (!view) return "";
  const statusCol = view.columns.find((c) => c.format === "status");
  const fmt = (v: unknown, format?: string) => {
    if (v === null || v === undefined || v === "") return "";
    if (format === "status") return pill(String(v));
    if (format === "score") return esc(Math.round(Number(v) * 100));
    if (format === "ms") return `${esc(Math.round(Number(v)))} ms`;
    if (format === "cls") return esc(Number(v).toFixed(3));
    if (format === "percent") return `${esc(Math.round(Number(v) * 100))}%`;
    if (format === "mono") return `<code>${esc(v)}</code>`;
    if (format === "link") return `<a href="${esc(v)}" rel="noopener noreferrer">docs</a>`;
    const s = String(v);
    return format === "longtext" || format === "json" ? `<div class="long">${esc(s.length > 1500 ? s.slice(0, 1500) + "…" : s)}</div>` : esc(s);
  };
  const cols: Col<Record<string, unknown>>[] = [
    { label: "Page", cell: (r) => `<span class="url">${esc(r.page_url)}</span>` },
    { label: "Browser", cell: (r) => esc(r.browser_name) },
    { label: "Viewport", cell: (r) => esc(viewportLabel(r.viewport_id as string | null)) },
    ...view.columns.map((c) => ({ label: c.label, cell: (r: Record<string, unknown>) => fmt(r[c.key], c.format) })),
  ];
  const truncated = view.truncated ? `<p class="note">The run recorded ${view.total} rows; the first ${view.rows.length} are included.</p>` : "";
  return (
    table(`t-${viewId}`, view.rows as Record<string, unknown>[], cols, {
      interactive,
      cap: interactive ? undefined : PRINT_DETAIL_CAP,
      filters: [
        ...(statusCol ? [{ attr: "status", label: "Status", values: uniq(view.rows.map((r) => r[statusCol.key] as string | null)) }] : []),
        { attr: "browser", label: "Browser", values: uniq(view.rows.map((r) => r.browser_name)) },
        { attr: "page", label: "Page", values: uniq(view.rows.map((r) => r.page_url)) },
      ],
      attrs: (r) => ({ status: String((statusCol && r[statusCol.key]) ?? ""), browser: String(r.browser_name ?? ""), page: String(r.page_url ?? "") }),
    }) + truncated
  );
}

function resultsTable(id: string, rows: ReportResult[], interactive: boolean, empty?: string): string {
  return table(id, rows, [
    { label: "ID", cell: (r) => `<code>${esc(r.code)}</code>` },
    { label: "Status", cell: (r) => pill(r.status) },
    { label: "Test case", cell: (r) => `<b>${esc(r.title)}</b>${r.element ? `<div class="muted">${esc(r.element)}</div>` : ""}` },
    { label: "Type", cell: (r) => esc(r.moduleLabel) + (r.scenarioType ? `<div class="muted">${esc(r.scenarioType.toLowerCase())}</div>` : "") },
    { label: "Page", cell: (r) => `<span class="url">${esc(r.pageUrl)}</span>` },
    { label: "Browser / viewport", cell: (r) => `${esc(r.browser)}<div class="muted">${esc(viewportLabel(r.viewport))}</div>` },
    { label: "Expected", cell: (r) => `<div class="long">${esc(r.expected)}</div>` },
    { label: "Actual", cell: (r) => `<div class="long">${esc(r.actual ?? r.message)}</div>` },
  ], {
    interactive,
    empty,
    cap: interactive ? undefined : PRINT_RESULT_CAP,
    filters: [
      { attr: "status", label: "Status", values: uniq(rows.map((r) => r.status)) },
      { attr: "module", label: "Type", values: uniq(rows.map((r) => r.moduleLabel)) },
      { attr: "browser", label: "Browser", values: uniq(rows.map((r) => r.browser)) },
      { attr: "page", label: "Page", values: uniq(rows.map((r) => r.pageUrl)) },
    ],
    attrs: (r) => ({ status: r.status, module: r.moduleLabel, browser: r.browser ?? "", page: r.pageUrl ?? "" }),
  });
}

// ---------------------------------------------------------------- document

const CSS = `
:root{--fg:#111827;--muted:#6b7280;--line:#e5e7eb;--bg:#ffffff;--soft:#f9fafb;--accent:#1d4ed8}
*{box-sizing:border-box}
body{margin:0;font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--fg);background:var(--bg)}
header.top{background:#111827;color:#fff;padding:20px 24px}
header.top h1{margin:0;font-size:22px}
header.top p{margin:4px 0 0;color:#d1d5db}
nav.toc{position:sticky;top:0;z-index:2;background:var(--soft);border-bottom:1px solid var(--line);padding:8px 16px;display:flex;flex-wrap:wrap;gap:4px 14px}
nav.toc a{color:var(--accent);text-decoration:none;font-size:13px}
nav.toc a:focus-visible,select:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
main{max-width:1280px;margin:0 auto;padding:16px}
section{margin:28px 0}
h2{font-size:18px;border-bottom:2px solid var(--line);padding-bottom:6px}
h3{font-size:15px;margin:18px 0 8px}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}
.card{border:1px solid var(--line);border-radius:8px;padding:10px 12px;background:var(--bg)}
.card .k{color:var(--muted);font-size:12px}.card .v{font-size:22px;font-weight:600}
.charts{display:flex;flex-wrap:wrap;gap:16px}
.chart{border:1px solid var(--line);border-radius:8px;padding:12px;margin:0}
.chart.wide{flex:1 1 520px}
.chart.empty{color:var(--muted);font-style:italic}
figcaption{font-weight:600;margin-bottom:6px}
.donut{display:flex;align-items:center;gap:12px}
.donut-total{font-size:22px;font-weight:700;fill:var(--fg)}
.legend{list-style:none;padding:0;margin:0;font-size:13px}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px}
.bar-label,.bar-value{font-size:11px;fill:var(--fg)}
dl.kv{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;margin:0}dl.kv dt{color:var(--muted)}dl.kv dd{margin:0}
.table-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:8px}
table{border-collapse:collapse;width:100%;font-size:12.5px}
th{background:var(--soft);text-align:left;position:sticky;top:0;font-weight:600}
th,td{border-bottom:1px solid var(--line);padding:6px 8px;vertical-align:top}
tr[hidden]{display:none}
.url{word-break:break-all;font-size:12px}
.long{max-width:420px;white-space:pre-wrap;word-break:break-word}
code{font:12px ui-monospace,SFMono-Regular,Consolas,monospace;word-break:break-all}
.muted{color:var(--muted);font-size:12px}
.pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;font-weight:600;color:var(--c);border:1px solid var(--c);white-space:nowrap}
.toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:6px 0}
.toolbar input,.toolbar select{font:inherit;padding:4px 8px;border:1px solid var(--line);border-radius:6px}
.toolbar .count{color:var(--muted);font-size:12px}
.empty,.note{color:var(--muted);font-style:italic}
.bug{border:1px solid var(--line);border-left:4px solid var(--c);border-radius:8px;padding:10px 12px;margin:10px 0;break-inside:avoid}
.bug h3{margin:0 0 6px}
.bug .long{max-width:none}
.shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}
.shots figure{margin:0;border:1px solid var(--line);border-radius:8px;padding:8px;break-inside:avoid}
.shots img{max-width:100%;height:auto;display:block;border:1px solid var(--line)}
.shots figcaption{font-weight:400;font-size:12px;margin-top:6px}
footer{border-top:1px solid var(--line);color:var(--muted);font-size:12px;padding:16px;text-align:center}
.cover{display:none}
@media (max-width:640px){main{padding:12px}.long{max-width:none}}
@media print{
  nav.toc,.toolbar{display:none}
  header.top{display:none}
  .cover{display:flex;flex-direction:column;justify-content:center;min-height:250mm;page-break-after:always}
  .cover h1{font-size:34px;margin:0 0 8px}.cover .brand{font-size:16px;color:var(--muted);letter-spacing:.08em;text-transform:uppercase}
  section{page-break-inside:auto}
  h2{page-break-after:avoid}
  .table-wrap{overflow:visible;border:none}
  th{position:static}
  tr{break-inside:avoid}
  .long{max-width:none}
}
`;

const SCRIPT = `
document.querySelectorAll('.toolbar').forEach(function(bar){
  var t=document.getElementById(bar.getAttribute('data-for'));if(!t)return;
  var rows=[].slice.call(t.tBodies[0].rows);var q=bar.querySelector('[data-search]');var sels=[].slice.call(bar.querySelectorAll('select'));var out=bar.querySelector('.count');
  function apply(){var term=(q.value||'').toLowerCase();var n=0;rows.forEach(function(r){var ok=!term||r.textContent.toLowerCase().indexOf(term)>=0;sels.forEach(function(s){if(s.value&&r.getAttribute('data-'+s.getAttribute('data-filter'))!==s.value)ok=false;});r.hidden=!ok;if(ok)n++;});out.textContent=n+' of '+rows.length+' rows';}
  q.addEventListener('input',apply);sels.forEach(function(s){s.addEventListener('change',apply);});apply();
});
`;

export function renderReportHtml(data: ReportData, options: HtmlOptions): string {
  const interactive = options.mode === "standalone";
  const c = data.counts;
  const executed = c.PASS + c.FAIL + c.WARNING;
  const passRate = executed ? `${Math.round((c.PASS / executed) * 1000) / 10}%` : "—";
  const runName = data.run.name ?? `Run ${data.run.id.slice(0, 8)}`;
  const title = `QA Report — ${data.project.name} — ${runName}`;

  const sev = (s: string) => data.bugs.filter((b) => b.severity === s).length;
  const moduleStats = new Map<string, Record<string, number>>();
  for (const r of data.results) {
    const m = moduleStats.get(r.moduleLabel) ?? { PASS: 0, FAIL: 0, WARNING: 0 };
    if (r.status in m) m[r.status]++;
    moduleStats.set(r.moduleLabel, m);
  }

  const sections: { id: string; title: string; html: string }[] = [];
  const add = (id: string, t: string, html: string) => sections.push({ id, title: t, html });

  add(
    "summary",
    "Summary",
    `<div class="cards">
      ${[
        ["Pages tested", data.pages.length],
        ["Test results", data.totalResults],
        ["PASS", c.PASS],
        ["FAIL", c.FAIL],
        ["WARNING", c.WARNING],
        ["NOT EXECUTED", c["NOT EXECUTED"]],
        ["NOT APPLICABLE", c["NOT APPLICABLE"]],
        ["Pass rate (executed)", passRate],
        ["Bugs in this run", data.bugs.length],
      ]
        .map(([k, v]) => `<div class="card"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`)
        .join("")}
    </div>
    <h3>Statistics</h3>
    <div class="charts">
      ${donut((["PASS", "FAIL", "WARNING", "NOT EXECUTED", "NOT APPLICABLE"] as const).map((s) => ({ label: s, value: c[s], color: STATUS_COLOR[s] })), "Result status")}
      ${donut(["CRITICAL", "HIGH", "MEDIUM", "LOW"].map((s) => ({ label: s, value: sev(s), color: SEVERITY_COLOR[s] })), "Bug severity")}
      ${bars(
        [...moduleStats.entries()].sort((a, b) => b[1].FAIL - a[1].FAIL || a[0].localeCompare(b[0])).map(([label, m]) => ({
          label,
          values: (["PASS", "FAIL", "WARNING"] as const).map((s) => ({ name: s, value: m[s], color: STATUS_COLOR[s] })),
        })),
        "Executed checks by test type (PASS / FAIL / WARNING)",
      )}
    </div>`,
  );

  add(
    "scope",
    "Testing Scope & Configuration",
    `<dl class="kv">
      <dt>Project</dt><dd>${esc(data.project.name)}</dd>
      <dt>Website</dt><dd class="url">${esc(data.project.websiteUrl)}</dd>
      <dt>Test run</dt><dd>${esc(runName)} (${esc(data.run.status)})</dd>
      <dt>Created</dt><dd>${fmtDate(data.run.createdAt)}</dd>
      <dt>Started</dt><dd>${fmtDate(data.run.startedAt)}</dd>
      <dt>Completed</dt><dd>${fmtDate(data.run.completedAt)}</dd>
      <dt>Pages</dt><dd>${data.pages.length}</dd>
      <dt>Test types</dt><dd>${esc(data.run.modules.map((m) => m.label).join(", ") || "—")}</dd>
      <dt>Browsers</dt><dd>${esc(data.run.browsers.join(", ") || "—")}</dd>
      <dt>Viewports</dt><dd>${esc(data.run.viewports.map(viewportLabel).join(", ") || "—")}</dd>
      ${data.run.options.map((o) => `<dt>${esc(o.label)}</dt><dd>${esc(o.value)}</dd>`).join("")}
      ${data.run.errorMessage ? `<dt>Run error</dt><dd>${esc(data.run.errorMessage)}</dd>` : ""}
    </dl>
    <p class="note">Statuses: PASS = verified; FAIL = verified failure with evidence; WARNING = potential issue, review required; NOT EXECUTED = could not be checked (reason given); NOT APPLICABLE = the feature does not exist on the page.</p>`,
  );

  add(
    "pages",
    "Page Results",
    table("t-pages", data.pages, [
      { label: "Page", cell: (p) => `<span class="url">${esc(p.url)}</span>${p.name ? `<div class="muted">${esc(p.name)}</div>` : ""}` },
      { label: "Type", cell: (p) => esc(p.pageType) },
      { label: "Page status", cell: (p) => esc(p.status) },
      { label: "PASS", cell: (p) => esc(p.counts.PASS) },
      { label: "FAIL", cell: (p) => esc(p.counts.FAIL) },
      { label: "WARNING", cell: (p) => esc(p.counts.WARNING) },
      { label: "NOT EXECUTED", cell: (p) => esc(p.counts["NOT EXECUTED"]) },
      { label: "NOT APPLICABLE", cell: (p) => esc(p.counts["NOT APPLICABLE"]) },
      { label: "Bugs", cell: (p) => esc(p.bugs) },
    ], { interactive, empty: "No pages were tested in this run." }),
  );

  add("cases", "Test Cases", resultsTable("t-results", data.results, interactive, "No test results were recorded for this run."));

  add(
    "bugs",
    "Bugs",
    data.bugs.length
      ? (interactive
          ? table("t-bugs", data.bugs, [
              { label: "Bug ID", cell: (b) => `<a href="#bug-${esc(b.id)}"><code>${esc(b.code)}</code></a>` },
              { label: "Severity", cell: (b) => pill(b.severity, SEVERITY_COLOR) },
              { label: "Priority", cell: (b) => esc(b.priority) },
              { label: "Status", cell: (b) => esc(b.status.replace(/_/g, " ")) },
              { label: "Title", cell: (b) => esc(b.title) },
              { label: "Test type", cell: (b) => esc(b.testType) },
              { label: "Device / browser", cell: (b) => `${esc(b.device)}<div class="muted">${esc(b.browser)}</div>` },
            ], {
              interactive,
              filters: [
                { attr: "severity", label: "Severity", values: uniq(data.bugs.map((b) => b.severity)) },
                { attr: "priority", label: "Priority", values: uniq(data.bugs.map((b) => b.priority)) },
                { attr: "status", label: "Status", values: uniq(data.bugs.map((b) => b.status)) },
                { attr: "type", label: "Test type", values: uniq(data.bugs.map((b) => b.testType)) },
              ],
              attrs: (b) => ({ severity: b.severity, priority: b.priority, status: b.status, type: b.testType ?? "" }),
            })
          : "") +
        data.bugs
          .map((b) => {
            const img = b.screenshotKey ? options.images.get(b.screenshotKey) : undefined;
            return `<article class="bug" id="bug-${esc(b.id)}" style="--c:${SEVERITY_COLOR[b.severity]}">
              <h3><code>${esc(b.code)}</code> ${esc(b.title)}</h3>
              <dl class="kv">
                <dt>Severity / priority</dt><dd>${pill(b.severity, SEVERITY_COLOR)} ${esc(b.priority)} · ${esc(b.status.replace(/_/g, " "))}</dd>
                <dt>Page</dt><dd><span class="url">${esc(b.pageUrl)}</span>${b.pageName ? ` (${esc(b.pageName)})` : ""}</dd>
                <dt>Test type</dt><dd>${esc(b.testType)}${b.scenarioType ? ` · ${esc(b.scenarioType.toLowerCase())}` : ""}${b.section ? ` · ${esc(b.section)}` : ""}</dd>
                <dt>Device / browser</dt><dd>${esc(b.device)} · ${esc(b.browser)}</dd>
                ${b.element ? `<dt>Element</dt><dd>${esc(b.element)}</dd>` : ""}
                ${b.selector ? `<dt>Selector</dt><dd><code>${esc(b.selector)}</code></dd>` : ""}
                <dt>Expected</dt><dd class="long">${esc(b.expected)}</dd>
                <dt>Actual</dt><dd class="long">${esc(b.actual)}</dd>
                <dt>Steps to reproduce</dt><dd class="long">${esc(b.steps)}</dd>
                ${b.technicalDetails ? `<dt>Technical details</dt><dd class="long"><code>${esc(b.technicalDetails.length > 3000 ? b.technicalDetails.slice(0, 3000) + "…" : b.technicalDetails)}</code></dd>` : ""}
                <dt>Created</dt><dd>${fmtDate(b.createdAt)} · seen ${b.occurrences} time(s)</dd>
              </dl>
              ${img ? `<figure class="shots"><img src="${img}" alt="Screenshot evidence for ${esc(b.code)}" loading="lazy"></figure>` : b.screenshotKey ? `<p class="note">Screenshot: ${esc(b.screenshotKey)}</p>` : ""}
            </article>`;
          })
          .join("")
      : `<p class="empty">No bugs were recorded for this run. Bugs are created only from verified failures.</p>`,
  );

  add("ui", "UI Results", resultsTable("t-ui", data.results.filter((r) => r.module === "ui" || r.module === "responsive"), interactive, "UI and responsive testing were not part of this run.") + `<h3>Measurements</h3>` + detailTable(data, "ui", interactive));
  add("typography", "Typography", detailTable(data, "typography", interactive));
  add("performance", "Performance", detailTable(data, "performance", interactive));
  add("accessibility", "Accessibility", `<p class="note">Automated checks cover only part of WCAG; they are not a compliance claim.</p>` + detailTable(data, "accessibility", interactive));
  add("seo", "SEO", detailTable(data, "seo", interactive));
  add("content", "Content Comparison", detailTable(data, "content", interactive));
  add("console", "Console & Network", `<h3>Console</h3>${detailTable(data, "console", interactive)}<h3>Network</h3>${detailTable(data, "network", interactive)}`);

  const shots = data.screenshots.filter((s) => options.images.has(s.key));
  add(
    "screenshots",
    "Screenshots",
    shots.length
      ? `<p class="note">Sensitive form fields are masked at capture time. Failures are shown first.</p><div class="shots">${shots
          .map(
            (s) =>
              `<figure><img src="${options.images.get(s.key)}" alt="${esc(s.label ?? "Screenshot")}" loading="lazy"><figcaption><b>${esc(s.label ?? s.kind)}</b><br>${esc(s.context ?? "")}<br><span class="url">${esc(s.pageUrl)}</span><br>${esc(s.browser)} · ${esc(viewportLabel(s.viewport))} · ${fmtDate(s.capturedAt)}</figcaption></figure>`,
          )
          .join("")}</div>`
      : `<p class="empty">No screenshots were captured for this run.</p>`,
  );

  const cover = `<div class="cover"><div class="brand">${esc(data.appName)}</div><h1>Website QA Testing Report</h1>
    <dl class="kv"><dt>Project</dt><dd>${esc(data.project.name)}</dd><dt>Website</dt><dd>${esc(data.project.websiteUrl)}</dd><dt>Test run</dt><dd>${esc(runName)}</dd>
    <dt>Date</dt><dd>${fmtDate(data.run.completedAt ?? data.run.createdAt)}</dd><dt>Generated</dt><dd>${fmtDate(data.generatedAt)}</dd></dl>
    <p class="muted" style="margin-top:40px">${esc(data.copyright)}</p></div>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="generator" content="${esc(data.appName)}"><meta name="robots" content="noindex">
<title>${esc(title)}</title><style>${CSS}</style></head>
<body>
${cover}
<header class="top"><h1>${esc(data.appName)} — QA Testing Report</h1><p>${esc(data.project.name)} · ${esc(data.project.websiteUrl)} · ${esc(runName)} · generated ${fmtDate(data.generatedAt)}</p></header>
${interactive ? `<nav class="toc" aria-label="Report sections">${sections.map((s) => `<a href="#${s.id}">${esc(s.title)}</a>`).join("")}</nav>` : ""}
<main>${sections.map((s) => `<section id="${s.id}" aria-labelledby="h-${s.id}"><h2 id="h-${s.id}">${esc(s.title)}</h2>${s.html}</section>`).join("\n")}</main>
<footer>Generated by ${esc(data.appName)} · ${esc(data.copyright)}</footer>
${interactive ? `<script>${SCRIPT}</script>` : ""}
</body></html>`;
}
