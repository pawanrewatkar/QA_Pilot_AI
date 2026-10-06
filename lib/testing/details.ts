/**
 * Measurement rows written to the per-check tables created in Phase 1 (and extended in
 * migration 3). Each row is linked to the test result that produced it.
 *
 * Only the columns listed in DETAIL_COLUMNS can be written; the store builds its SQL from
 * this whitelist, never from arbitrary object keys.
 */
export const DETAIL_COLUMNS = {
  ui_results: ["category", "check_key", "selector", "browser", "viewport", "observed", "message", "status", "element_text", "screenshot_id"],
  typography_results: [
    "selector", "font_family", "font_size_px", "font_weight", "line_height", "letter_spacing", "color", "expected", "expected_source",
    "browser", "viewport", "section", "role", "tag", "text_content", "difference", "status",
  ],
  accessibility_results: ["rule_id", "impact", "description", "help_url", "target_selector", "html_snippet", "wcag_tags", "status", "browser", "viewport", "failure_summary", "source"],
  seo_results: ["check_key", "status", "observed_value", "message", "expected"],
  performance_results: [
    "browser", "viewport", "source", "ttfb_ms", "fcp_ms", "lcp_ms", "cls", "tbt_ms", "dom_content_loaded_ms", "load_ms", "total_bytes", "request_count",
    "raw", "measured_at", "performance_score", "accessibility_score", "best_practices_score", "seo_score", "speed_index_ms", "inp_ms", "form_factor",
    "tool_version", "status",
  ],
  content_comparisons: ["document_id", "status", "expected_text", "actual_text", "similarity_score", "diff", "mode", "kind", "section", "message"],
  link_results: ["href", "resolved_url", "link_text", "is_external", "http_status", "redirect_chain", "error", "checked_at"],
} as const;

export type DetailTable = keyof typeof DETAIL_COLUMNS;
type Column<T extends DetailTable> = (typeof DETAIL_COLUMNS)[T][number];

export type DetailRow = {
  [T in DetailTable]: { table: T; values: Partial<Record<Column<T>, string | number | null>> };
}[DetailTable];

export function detail<T extends DetailTable>(table: T, values: Partial<Record<Column<T>, string | number | null>>): DetailRow {
  return { table, values } as DetailRow;
}
