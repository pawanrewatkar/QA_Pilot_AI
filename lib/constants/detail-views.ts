/**
 * Detail views over the per-check tables. Shared by the repository (which builds SQL only from
 * these whitelisted columns) and the run page (which renders them). Client-safe: no Node imports.
 */
export type DetailColumnFormat = "text" | "mono" | "status" | "score" | "ms" | "cls" | "json" | "link" | "percent" | "datetime" | "longtext";

export interface DetailColumn {
  key: string;
  label: string;
  format?: DetailColumnFormat;
  /** Hidden on narrow screens. */
  secondary?: boolean;
}

export interface DetailViewDefinition {
  id: string;
  label: string;
  table: string;
  description: string;
  columns: DetailColumn[];
  /** Column used by the status filter, if any. */
  statusColumn?: string;
  /** Additional enumerated filter (e.g. UI vs Responsive, finding kind). */
  extraFilter?: { column: string; label: string; options: { value: string; label: string }[] };
  orderBy: string;
}

export const DETAIL_VIEWS: DetailViewDefinition[] = [
  {
    id: "ui",
    label: "UI & Responsive",
    table: "ui_results",
    description: "Measured layout findings. Each row is one element (or one check that found nothing) at a browser and viewport.",
    statusColumn: "status",
    extraFilter: { column: "category", label: "Type", options: [{ value: "UI", label: "UI" }, { value: "RESPONSIVE", label: "Responsive" }] },
    orderBy: "CASE d.status WHEN 'FAIL' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END, d.viewport, d.check_key",
    columns: [
      { key: "status", label: "Status", format: "status" },
      { key: "check_key", label: "Check" },
      { key: "viewport", label: "Viewport" },
      { key: "selector", label: "Element", format: "mono" },
      { key: "element_text", label: "Text", secondary: true },
      { key: "message", label: "Measurement", format: "longtext" },
      { key: "observed", label: "Observed", format: "json", secondary: true },
    ],
  },
  {
    id: "typography",
    label: "Typography",
    table: "typography_results",
    description: "Computed text styles. Expected values are shown only when a Figma or reference source provides them; none are invented.",
    statusColumn: "status",
    extraFilter: { column: "role", label: "Element", options: ["h1", "h2", "h3", "h4", "h5", "h6", "paragraph", "link", "button", "cta", "label", "navigation"].map((v) => ({ value: v, label: v })) },
    orderBy: "d.viewport, CASE d.role WHEN 'h1' THEN 1 WHEN 'h2' THEN 2 WHEN 'h3' THEN 3 WHEN 'h4' THEN 4 WHEN 'h5' THEN 5 WHEN 'h6' THEN 6 ELSE 7 END, d.role",
    columns: [
      { key: "section", label: "Section", secondary: true },
      { key: "role", label: "Element" },
      { key: "tag", label: "Tag", format: "mono" },
      { key: "text_content", label: "Text", secondary: true },
      { key: "font_family", label: "Font family", format: "mono" },
      { key: "font_size_px", label: "Size (px)" },
      { key: "font_weight", label: "Weight" },
      { key: "line_height", label: "Line height" },
      { key: "letter_spacing", label: "Letter spacing", secondary: true },
      { key: "color", label: "Colour", format: "mono", secondary: true },
      { key: "expected", label: "Expected" },
      { key: "difference", label: "Difference" },
      { key: "status", label: "Comparison", format: "status" },
    ],
  },
  {
    id: "accessibility",
    label: "Accessibility",
    table: "accessibility_results",
    description: "axe-core rule results and keyboard focus probes. Automated checks cover only part of WCAG and are not a compliance claim.",
    statusColumn: "status",
    extraFilter: { column: "impact", label: "Impact", options: ["critical", "serious", "moderate", "minor"].map((v) => ({ value: v, label: v })) },
    orderBy: "CASE d.status WHEN 'FAIL' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END, CASE d.impact WHEN 'critical' THEN 0 WHEN 'serious' THEN 1 WHEN 'moderate' THEN 2 ELSE 3 END, d.rule_id",
    columns: [
      { key: "status", label: "Status", format: "status" },
      { key: "rule_id", label: "Rule", format: "mono" },
      { key: "impact", label: "Impact" },
      { key: "description", label: "Description" },
      { key: "target_selector", label: "Element", format: "mono" },
      { key: "failure_summary", label: "Details", format: "longtext", secondary: true },
      { key: "html_snippet", label: "HTML", format: "mono", secondary: true },
      { key: "source", label: "Source", secondary: true },
      { key: "help_url", label: "Rule docs", format: "link", secondary: true },
    ],
  },
  {
    id: "seo",
    label: "SEO",
    table: "seo_results",
    description: "Metadata and crawlability findings per page.",
    statusColumn: "status",
    orderBy: "CASE d.status WHEN 'FAIL' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END, d.check_key",
    columns: [
      { key: "status", label: "Status", format: "status" },
      { key: "check_key", label: "Check" },
      { key: "observed_value", label: "Observed", format: "longtext" },
      { key: "expected", label: "Expected" },
      { key: "message", label: "Finding" },
    ],
  },
  {
    id: "performance",
    label: "Performance",
    table: "performance_results",
    description: "Lab measurements. Local Lighthouse results are labelled separately from browser-timing fallbacks; Google PageSpeed is not used.",
    statusColumn: "status",
    extraFilter: { column: "source", label: "Source", options: [{ value: "LOCAL_LIGHTHOUSE", label: "Local Lighthouse" }, { value: "LOCAL_BROWSER", label: "Browser timing (fallback)" }, { value: "PAGESPEED", label: "Google PageSpeed" }] },
    orderBy: "d.form_factor, d.measured_at",
    columns: [
      { key: "source", label: "Source" },
      { key: "form_factor", label: "Form factor" },
      { key: "performance_score", label: "Perf.", format: "score" },
      { key: "accessibility_score", label: "A11y", format: "score" },
      { key: "best_practices_score", label: "Best pr.", format: "score" },
      { key: "seo_score", label: "SEO", format: "score" },
      { key: "lcp_ms", label: "LCP", format: "ms" },
      { key: "cls", label: "CLS", format: "cls" },
      { key: "fcp_ms", label: "FCP", format: "ms", secondary: true },
      { key: "tbt_ms", label: "TBT", format: "ms", secondary: true },
      { key: "speed_index_ms", label: "Speed Index", format: "ms", secondary: true },
      { key: "ttfb_ms", label: "TTFB", format: "ms", secondary: true },
      { key: "inp_ms", label: "INP", format: "ms", secondary: true },
      { key: "tool_version", label: "Tool", secondary: true },
      { key: "status", label: "Overall", format: "status" },
    ],
  },
  {
    id: "content",
    label: "Content",
    table: "content_comparisons",
    description: "Differences between page text and the reference document. The comparison mode is shown on every row.",
    statusColumn: "status",
    extraFilter: { column: "kind", label: "Finding", options: ["MISSING", "CHANGED", "SPELLING", "HEADING", "EXTRA", "REPEATED", "ORDER", "CTA", "MATCH"].map((v) => ({ value: v, label: v.toLowerCase() })) },
    orderBy: "CASE d.status WHEN 'FAIL' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END, d.kind",
    columns: [
      { key: "status", label: "Status", format: "status" },
      { key: "mode", label: "Mode" },
      { key: "kind", label: "Finding" },
      { key: "section", label: "Section", secondary: true },
      { key: "expected_text", label: "Reference text", format: "longtext" },
      { key: "actual_text", label: "Page text", format: "longtext" },
      { key: "similarity_score", label: "Similarity", format: "percent", secondary: true },
      { key: "message", label: "Message" },
    ],
  },
  {
    id: "console",
    label: "Console",
    table: "console_results",
    description: "Console errors and warnings, and uncaught exceptions, recorded while each page loaded. Warnings are informational, not failures.",
    extraFilter: { column: "level", label: "Level", options: [{ value: "error", label: "error" }, { value: "warning", label: "warning" }] },
    orderBy: "CASE d.level WHEN 'error' THEN 0 ELSE 1 END, d.logged_at",
    columns: [
      { key: "level", label: "Level" },
      { key: "message", label: "Message", format: "longtext" },
      { key: "source_url", label: "Source", format: "mono", secondary: true },
      { key: "line_number", label: "Line", secondary: true },
      { key: "logged_at", label: "Time", format: "datetime", secondary: true },
    ],
  },
  {
    id: "network",
    label: "Network",
    table: "network_results",
    description: "Failed requests observed while each page loaded: status, resource type and error.",
    extraFilter: { column: "error_category", label: "Category", options: ["NOT_FOUND", "SERVER_ERROR", "CLIENT_ERROR", "NETWORK_ERROR", "CORS"].map((v) => ({ value: v, label: v.toLowerCase().replace("_", " ") })) },
    orderBy: "d.status_code DESC, d.recorded_at",
    columns: [
      { key: "error_category", label: "Category" },
      { key: "method", label: "Method", format: "mono" },
      { key: "url", label: "URL", format: "mono" },
      { key: "resource_type", label: "Type" },
      { key: "status_code", label: "Status" },
      { key: "failure_text", label: "Error", secondary: true },
    ],
  },
];

export function getDetailView(id: string | undefined): DetailViewDefinition | undefined {
  return DETAIL_VIEWS.find((v) => v.id === id);
}
