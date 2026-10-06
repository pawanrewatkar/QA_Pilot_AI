/**
 * Versioned SQLite schema migrations.
 *
 * Rules:
 * - Never edit a migration that has shipped; append a new one.
 * - Status CHECK constraints mirror the unions in types/domain.ts.
 * - Timestamps are ISO-8601 UTC strings.
 * - Test-run statuses and test-result statuses are intentionally different sets.
 */

const RUN_STATUS = `'PENDING','RUNNING','COMPLETED','FAILED','CANCELLED'`;
const RESULT_STATUS = `'PASS','FAIL','WARNING','NOT EXECUTED','NOT APPLICABLE'`;
const NOW = `(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

/** Columns shared by every per-check result table. */
const RESULT_LINK_COLUMNS = `
  id TEXT PRIMARY KEY,
  test_run_id TEXT NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
  page_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
  test_result_id TEXT REFERENCES test_results(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT ${NOW}`;

function resultIndexes(table: string): string {
  return `
CREATE INDEX idx_${table}_run ON ${table}(test_run_id);
CREATE INDEX idx_${table}_page ON ${table}(page_id);`;
}

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial_schema",
    sql: `
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  website_url TEXT NOT NULL,
  description TEXT,
  figma_url TEXT,
  test_email TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW},
  updated_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE INDEX idx_projects_name ON projects(name COLLATE NOCASE);
CREATE INDEX idx_projects_updated ON projects(updated_at);

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'REFERENCE' CHECK (kind IN ('REFERENCE','OTHER')),
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  storage_key TEXT NOT NULL UNIQUE,
  checksum_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE INDEX idx_documents_project ON documents(project_id, kind);

-- Credentials for login/logout testing. Secrets are never stored in plaintext:
-- secret_ref points at an external secret store / encrypted vault entry.
CREATE TABLE test_credentials (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  username TEXT NOT NULL,
  secret_ref TEXT,
  login_url TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW},
  updated_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE INDEX idx_test_credentials_project ON test_credentials(project_id);

CREATE TABLE test_configurations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('ENTIRE_WEBSITE','SELECTED_PAGES','MANUAL_URLS')),
  selected_page_ids TEXT NOT NULL DEFAULT '[]',
  manual_urls TEXT NOT NULL DEFAULT '[]',
  modules TEXT NOT NULL DEFAULT '[]',
  browsers TEXT NOT NULL DEFAULT '[]',
  viewports TEXT NOT NULL DEFAULT '[]',
  report_formats TEXT NOT NULL DEFAULT '[]',
  report_sections TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT ${NOW},
  updated_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE INDEX idx_test_configurations_project ON test_configurations(project_id, updated_at);

CREATE TABLE test_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  configuration_id TEXT REFERENCES test_configurations(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN (${RUN_STATUS})),
  -- Frozen copy of the configuration at run time, so later edits never rewrite history.
  config_snapshot TEXT NOT NULL DEFAULT '{}',
  started_at TEXT,
  completed_at TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW},
  updated_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE INDEX idx_test_runs_project ON test_runs(project_id, created_at);
CREATE INDEX idx_test_runs_status ON test_runs(status);

CREATE TABLE pages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  normalized_url TEXT NOT NULL,
  title TEXT,
  http_status INTEGER,
  discovered_via TEXT CHECK (discovered_via IS NULL OR discovered_via IN ('CRAWL','SITEMAP','MANUAL')),
  depth INTEGER,
  first_seen_at TEXT NOT NULL DEFAULT ${NOW},
  last_seen_at TEXT NOT NULL DEFAULT ${NOW},
  UNIQUE (project_id, normalized_url)
);
CREATE INDEX idx_pages_project ON pages(project_id);

CREATE TABLE test_run_pages (
  id TEXT PRIMARY KEY,
  test_run_id TEXT NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN (${RUN_STATUS})),
  started_at TEXT,
  completed_at TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW},
  UNIQUE (test_run_id, page_id)
);
CREATE INDEX idx_test_run_pages_page ON test_run_pages(page_id);

CREATE TABLE test_cases (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  test_run_id TEXT REFERENCES test_runs(id) ON DELETE SET NULL,
  page_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
  module TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  preconditions TEXT,
  steps TEXT NOT NULL DEFAULT '[]',
  expected_result TEXT,
  priority TEXT CHECK (priority IS NULL OR priority IN ('P0','P1','P2','P3')),
  source TEXT NOT NULL DEFAULT 'RULE' CHECK (source IN ('RULE','MANUAL','AI_SUGGESTED')),
  created_at TEXT NOT NULL DEFAULT ${NOW},
  updated_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE INDEX idx_test_cases_project ON test_cases(project_id, module);
CREATE INDEX idx_test_cases_run ON test_cases(test_run_id);

CREATE TABLE test_results (
  id TEXT PRIMARY KEY,
  test_run_id TEXT NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
  test_case_id TEXT NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
  test_run_page_id TEXT REFERENCES test_run_pages(id) ON DELETE SET NULL,
  browser TEXT CHECK (browser IS NULL OR browser IN ('chromium','firefox','webkit')),
  viewport TEXT,
  status TEXT NOT NULL CHECK (status IN (${RESULT_STATUS})),
  actual_result TEXT,
  message TEXT,
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  executed_at TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW},
  -- A verdict (PASS / FAIL / WARNING) may only be recorded for a check that actually ran.
  CHECK (status NOT IN ('PASS','FAIL','WARNING') OR executed_at IS NOT NULL)
);
CREATE INDEX idx_test_results_run ON test_results(test_run_id, status);
CREATE INDEX idx_test_results_case ON test_results(test_case_id);
CREATE INDEX idx_test_results_executed ON test_results(executed_at);

CREATE TABLE screenshots (
  ${RESULT_LINK_COLUMNS},
  storage_key TEXT NOT NULL UNIQUE,
  browser TEXT,
  viewport TEXT,
  width INTEGER,
  height INTEGER,
  captured_at TEXT NOT NULL
);
${resultIndexes("screenshots")}

CREATE TABLE bugs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  test_run_id TEXT REFERENCES test_runs(id) ON DELETE SET NULL,
  test_result_id TEXT REFERENCES test_results(id) ON DELETE SET NULL,
  page_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT,
  severity TEXT NOT NULL CHECK (severity IN ('CRITICAL','HIGH','MEDIUM','LOW')),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','IN_PROGRESS','RESOLVED','CLOSED','WONT_FIX')),
  steps_to_reproduce TEXT,
  expected_result TEXT,
  actual_result TEXT,
  browser TEXT,
  viewport TEXT,
  -- Stable hash of module + page + check used for duplicate detection across runs.
  fingerprint TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW},
  updated_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE INDEX idx_bugs_project ON bugs(project_id, status);
CREATE INDEX idx_bugs_severity ON bugs(severity);
CREATE INDEX idx_bugs_fingerprint ON bugs(project_id, fingerprint);

CREATE TABLE bug_evidence (
  id TEXT PRIMARY KEY,
  bug_id TEXT NOT NULL REFERENCES bugs(id) ON DELETE CASCADE,
  evidence_type TEXT NOT NULL CHECK (evidence_type IN ('SCREENSHOT','CONSOLE_LOG','NETWORK_LOG','HTML_SNAPSHOT','VIDEO','TRACE','OTHER')),
  screenshot_id TEXT REFERENCES screenshots(id) ON DELETE SET NULL,
  storage_key TEXT,
  content TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE INDEX idx_bug_evidence_bug ON bug_evidence(bug_id);

CREATE TABLE performance_results (
  ${RESULT_LINK_COLUMNS},
  browser TEXT,
  viewport TEXT,
  source TEXT NOT NULL CHECK (source IN ('LOCAL_BROWSER','PAGESPEED')),
  ttfb_ms REAL,
  fcp_ms REAL,
  lcp_ms REAL,
  cls REAL,
  tbt_ms REAL,
  dom_content_loaded_ms REAL,
  load_ms REAL,
  total_bytes INTEGER,
  request_count INTEGER,
  raw TEXT,
  measured_at TEXT NOT NULL
);
${resultIndexes("performance_results")}

CREATE TABLE accessibility_results (
  ${RESULT_LINK_COLUMNS},
  rule_id TEXT NOT NULL,
  impact TEXT CHECK (impact IS NULL OR impact IN ('critical','serious','moderate','minor')),
  description TEXT,
  help_url TEXT,
  target_selector TEXT,
  html_snippet TEXT,
  wcag_tags TEXT NOT NULL DEFAULT '[]'
);
${resultIndexes("accessibility_results")}

CREATE TABLE seo_results (
  ${RESULT_LINK_COLUMNS},
  check_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (${RESULT_STATUS})),
  observed_value TEXT,
  message TEXT
);
${resultIndexes("seo_results")}

CREATE TABLE link_results (
  ${RESULT_LINK_COLUMNS},
  href TEXT NOT NULL,
  resolved_url TEXT,
  link_text TEXT,
  is_external INTEGER NOT NULL DEFAULT 0 CHECK (is_external IN (0,1)),
  http_status INTEGER,
  redirect_chain TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  checked_at TEXT NOT NULL
);
${resultIndexes("link_results")}

CREATE TABLE console_results (
  ${RESULT_LINK_COLUMNS},
  level TEXT NOT NULL CHECK (level IN ('error','warning','info','log','debug')),
  message TEXT NOT NULL,
  source_url TEXT,
  line_number INTEGER,
  column_number INTEGER,
  logged_at TEXT NOT NULL
);
${resultIndexes("console_results")}

CREATE TABLE network_results (
  ${RESULT_LINK_COLUMNS},
  url TEXT NOT NULL,
  method TEXT NOT NULL,
  resource_type TEXT,
  status_code INTEGER,
  failure_text TEXT,
  duration_ms REAL,
  size_bytes INTEGER,
  recorded_at TEXT NOT NULL
);
${resultIndexes("network_results")}

CREATE TABLE ui_results (
  ${RESULT_LINK_COLUMNS},
  check_key TEXT NOT NULL,
  selector TEXT,
  browser TEXT,
  viewport TEXT,
  observed TEXT NOT NULL DEFAULT '{}',
  message TEXT,
  screenshot_id TEXT REFERENCES screenshots(id) ON DELETE SET NULL
);
${resultIndexes("ui_results")}

CREATE TABLE typography_results (
  ${RESULT_LINK_COLUMNS},
  selector TEXT NOT NULL,
  font_family TEXT,
  font_size_px REAL,
  font_weight TEXT,
  line_height TEXT,
  letter_spacing TEXT,
  color TEXT,
  -- Expected values must come from a real source (Figma file or reference document), never inferred.
  expected TEXT,
  expected_source TEXT CHECK (expected_source IS NULL OR expected_source IN ('FIGMA','DOCUMENT','MANUAL'))
);
${resultIndexes("typography_results")}

CREATE TABLE content_comparisons (
  ${RESULT_LINK_COLUMNS},
  document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN (${RESULT_STATUS})),
  expected_text TEXT,
  actual_text TEXT,
  similarity_score REAL CHECK (similarity_score IS NULL OR (similarity_score >= 0 AND similarity_score <= 1)),
  diff TEXT
);
${resultIndexes("content_comparisons")}

CREATE TABLE figma_comparisons (
  ${RESULT_LINK_COLUMNS},
  figma_file_key TEXT NOT NULL,
  figma_node_id TEXT,
  property TEXT NOT NULL,
  figma_value TEXT,
  observed_value TEXT,
  delta REAL,
  status TEXT NOT NULL CHECK (status IN (${RESULT_STATUS})),
  screenshot_id TEXT REFERENCES screenshots(id) ON DELETE SET NULL
);
${resultIndexes("figma_comparisons")}

CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  test_run_id TEXT REFERENCES test_runs(id) ON DELETE SET NULL,
  format TEXT NOT NULL CHECK (format IN ('EXCEL','PDF','HTML','JSON','CSV')),
  status TEXT NOT NULL DEFAULT 'GENERATING' CHECK (status IN ('GENERATING','READY','FAILED')),
  storage_key TEXT,
  file_name TEXT,
  size_bytes INTEGER,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW},
  completed_at TEXT
);
CREATE INDEX idx_reports_project ON reports(project_id, created_at);
CREATE INDEX idx_reports_run ON reports(test_run_id);

-- Audit trail of user-visible actions; powers History and dashboard activity.
CREATE TABLE activity_log (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  action TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE INDEX idx_activity_created ON activity_log(created_at);
CREATE INDEX idx_activity_project ON activity_log(project_id);

-- Work queue consumed by the separate worker process (crawls, browser runs, reports).
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN (${RUN_STATUS})),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  run_after TEXT NOT NULL DEFAULT ${NOW},
  locked_at TEXT,
  locked_by TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW},
  updated_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE INDEX idx_jobs_claim ON jobs(status, run_after);
`,
  },
  {
    version: 2,
    name: "crawler_and_test_engine",
    sql: `
-- Website discovery runs (one per "Start Crawl").
CREATE TABLE crawl_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN (${RUN_STATUS})),
  config TEXT NOT NULL DEFAULT '{}',
  start_url TEXT NOT NULL,
  resolved_start_url TEXT,
  pages_discovered INTEGER NOT NULL DEFAULT 0,
  pages_crawled INTEGER NOT NULL DEFAULT 0,
  pages_failed INTEGER NOT NULL DEFAULT 0,
  pages_skipped INTEGER NOT NULL DEFAULT 0,
  current_url TEXT,
  current_depth INTEGER NOT NULL DEFAULT 0,
  max_depth_reached INTEGER NOT NULL DEFAULT 0,
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0,1)),
  error_message TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW},
  updated_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE INDEX idx_crawl_runs_project ON crawl_runs(project_id, created_at);

ALTER TABLE pages ADD COLUMN name TEXT;
ALTER TABLE pages ADD COLUMN description TEXT;
ALTER TABLE pages ADD COLUMN page_type TEXT NOT NULL DEFAULT 'OTHER';
ALTER TABLE pages ADD COLUMN page_type_confidence REAL;
ALTER TABLE pages ADD COLUMN crawl_status TEXT NOT NULL DEFAULT 'DISCOVERED'
  CHECK (crawl_status IN ('DISCOVERED','CRAWLED','FAILED','SKIPPED'));
ALTER TABLE pages ADD COLUMN discovery_sources TEXT NOT NULL DEFAULT '[]';
ALTER TABLE pages ADD COLUMN is_selected INTEGER NOT NULL DEFAULT 1 CHECK (is_selected IN (0,1));
ALTER TABLE pages ADD COLUMN final_url TEXT;
ALTER TABLE pages ADD COLUMN content_type TEXT;
ALTER TABLE pages ADD COLUMN error_message TEXT;
ALTER TABLE pages ADD COLUMN last_crawl_run_id TEXT REFERENCES crawl_runs(id) ON DELETE SET NULL;
CREATE INDEX idx_pages_type ON pages(project_id, page_type);

ALTER TABLE test_runs ADD COLUMN name TEXT;
ALTER TABLE test_runs ADD COLUMN options TEXT NOT NULL DEFAULT '{}';
ALTER TABLE test_runs ADD COLUMN progress_total INTEGER NOT NULL DEFAULT 0;
ALTER TABLE test_runs ADD COLUMN progress_completed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE test_runs ADD COLUMN current_page_url TEXT;
ALTER TABLE test_runs ADD COLUMN current_test TEXT;
ALTER TABLE test_runs ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0,1));

-- Test case identity is stable per run: case_key = module + feature + element + scenario.
ALTER TABLE test_cases ADD COLUMN case_key TEXT;
ALTER TABLE test_cases ADD COLUMN code TEXT;
ALTER TABLE test_cases ADD COLUMN page_url TEXT;
ALTER TABLE test_cases ADD COLUMN section TEXT;
ALTER TABLE test_cases ADD COLUMN scenario_type TEXT
  CHECK (scenario_type IS NULL OR scenario_type IN ('FUNCTIONAL','POSITIVE','NEGATIVE','EDGE','BOUNDARY'));
ALTER TABLE test_cases ADD COLUMN feature TEXT;
ALTER TABLE test_cases ADD COLUMN element TEXT;
ALTER TABLE test_cases ADD COLUMN test_data TEXT;
CREATE UNIQUE INDEX idx_test_cases_run_key ON test_cases(test_run_id, case_key) WHERE case_key IS NOT NULL;

ALTER TABLE test_results ADD COLUMN page_id TEXT REFERENCES pages(id) ON DELETE SET NULL;
ALTER TABLE test_results ADD COLUMN url TEXT;
-- JSON array of { type, label, storageKey?, content? } captured during execution.
ALTER TABLE test_results ADD COLUMN evidence TEXT NOT NULL DEFAULT '[]';
-- JSON array of the concrete observations that justified the verdict.
ALTER TABLE test_results ADD COLUMN verifications TEXT NOT NULL DEFAULT '[]';

-- Ledger of real form submissions, used to prevent repeated newsletter sign-ups.
CREATE TABLE form_submissions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  test_run_id TEXT REFERENCES test_runs(id) ON DELETE SET NULL,
  form_kind TEXT NOT NULL,
  form_fingerprint TEXT NOT NULL,
  page_url TEXT NOT NULL,
  submitted_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE INDEX idx_form_submissions_lookup ON form_submissions(project_id, form_kind, form_fingerprint);

-- Liveness of worker processes, so the UI can tell whether queued jobs will be picked up.
CREATE TABLE worker_heartbeats (
  worker_id TEXT PRIMARY KEY,
  hostname TEXT NOT NULL,
  pid INTEGER NOT NULL,
  handlers TEXT NOT NULL DEFAULT '[]',
  started_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
`,
  },
  {
    version: 3,
    name: "advanced_testing_modules",
    sql: `
-- Expectation hierarchy: where the expected behaviour of a case comes from.
ALTER TABLE test_cases ADD COLUMN expectation_source TEXT NOT NULL DEFAULT 'DETECTED_FUNCTIONALITY'
  CHECK (expectation_source IN ('REQUIREMENT','ACCEPTANCE_CRITERIA','FIGMA','REFERENCE_DOCUMENT','BROWSER_STANDARD','DETECTED_FUNCTIONALITY','AI_EXPLORATORY'));

ALTER TABLE ui_results ADD COLUMN category TEXT NOT NULL DEFAULT 'UI' CHECK (category IN ('UI','RESPONSIVE'));
ALTER TABLE ui_results ADD COLUMN status TEXT CHECK (status IS NULL OR status IN (${RESULT_STATUS}));
ALTER TABLE ui_results ADD COLUMN element_text TEXT;

ALTER TABLE typography_results ADD COLUMN browser TEXT;
ALTER TABLE typography_results ADD COLUMN viewport TEXT;
ALTER TABLE typography_results ADD COLUMN section TEXT;
ALTER TABLE typography_results ADD COLUMN role TEXT;
ALTER TABLE typography_results ADD COLUMN tag TEXT;
ALTER TABLE typography_results ADD COLUMN text_content TEXT;
ALTER TABLE typography_results ADD COLUMN difference TEXT;
ALTER TABLE typography_results ADD COLUMN status TEXT CHECK (status IS NULL OR status IN (${RESULT_STATUS}));

ALTER TABLE accessibility_results ADD COLUMN status TEXT CHECK (status IS NULL OR status IN (${RESULT_STATUS}));
ALTER TABLE accessibility_results ADD COLUMN browser TEXT;
ALTER TABLE accessibility_results ADD COLUMN viewport TEXT;
ALTER TABLE accessibility_results ADD COLUMN failure_summary TEXT;
ALTER TABLE accessibility_results ADD COLUMN source TEXT NOT NULL DEFAULT 'AXE' CHECK (source IN ('AXE','KEYBOARD_PROBE'));

ALTER TABLE seo_results ADD COLUMN expected TEXT;

-- performance_results is rebuilt (SQLite cannot alter CHECK constraints) so local Lighthouse results
-- are labelled distinctly from browser-timing and future Google PageSpeed results. Existing rows are kept.
CREATE TABLE performance_results_v3 (
  ${RESULT_LINK_COLUMNS},
  browser TEXT,
  viewport TEXT,
  source TEXT NOT NULL CHECK (source IN ('LOCAL_LIGHTHOUSE','LOCAL_BROWSER','PAGESPEED')),
  ttfb_ms REAL,
  fcp_ms REAL,
  lcp_ms REAL,
  cls REAL,
  tbt_ms REAL,
  dom_content_loaded_ms REAL,
  load_ms REAL,
  total_bytes INTEGER,
  request_count INTEGER,
  raw TEXT,
  measured_at TEXT NOT NULL,
  performance_score REAL CHECK (performance_score IS NULL OR (performance_score >= 0 AND performance_score <= 1)),
  accessibility_score REAL CHECK (accessibility_score IS NULL OR (accessibility_score >= 0 AND accessibility_score <= 1)),
  best_practices_score REAL CHECK (best_practices_score IS NULL OR (best_practices_score >= 0 AND best_practices_score <= 1)),
  seo_score REAL CHECK (seo_score IS NULL OR (seo_score >= 0 AND seo_score <= 1)),
  speed_index_ms REAL,
  inp_ms REAL,
  form_factor TEXT,
  tool_version TEXT,
  status TEXT CHECK (status IS NULL OR status IN (${RESULT_STATUS}))
);
INSERT INTO performance_results_v3 (id, test_run_id, page_id, test_result_id, created_at, browser, viewport, source, ttfb_ms, fcp_ms, lcp_ms, cls, tbt_ms,
  dom_content_loaded_ms, load_ms, total_bytes, request_count, raw, measured_at)
  SELECT id, test_run_id, page_id, test_result_id, created_at, browser, viewport, source, ttfb_ms, fcp_ms, lcp_ms, cls, tbt_ms,
    dom_content_loaded_ms, load_ms, total_bytes, request_count, raw, measured_at FROM performance_results;
DROP TABLE performance_results;
ALTER TABLE performance_results_v3 RENAME TO performance_results;
${resultIndexes("performance_results")}

ALTER TABLE content_comparisons ADD COLUMN mode TEXT CHECK (mode IS NULL OR mode IN ('EXACT','SECTION','SEMANTIC'));
ALTER TABLE content_comparisons ADD COLUMN kind TEXT;
ALTER TABLE content_comparisons ADD COLUMN section TEXT;
ALTER TABLE content_comparisons ADD COLUMN message TEXT;

ALTER TABLE console_results ADD COLUMN browser TEXT;
ALTER TABLE console_results ADD COLUMN viewport TEXT;
ALTER TABLE network_results ADD COLUMN browser TEXT;
ALTER TABLE network_results ADD COLUMN viewport TEXT;
ALTER TABLE network_results ADD COLUMN error_category TEXT;


CREATE INDEX idx_content_comparisons_kind ON content_comparisons(test_run_id, kind);
`,
  },
];

/** Every table the application expects after all migrations run. */
export const EXPECTED_TABLES = [
  "projects",
  "documents",
  "test_credentials",
  "test_configurations",
  "test_runs",
  "pages",
  "test_run_pages",
  "test_cases",
  "test_results",
  "screenshots",
  "bugs",
  "bug_evidence",
  "performance_results",
  "accessibility_results",
  "seo_results",
  "link_results",
  "console_results",
  "network_results",
  "ui_results",
  "typography_results",
  "content_comparisons",
  "figma_comparisons",
  "reports",
  "activity_log",
  "jobs",
  "crawl_runs",
  "form_submissions",
  "worker_heartbeats",
] as const;

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;
