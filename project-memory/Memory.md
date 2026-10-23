# QA Pilot AI — Project Memory

> **Instructions for future Claude Code sessions — read first**
> 1. Read this whole file before changing anything.
> 2. Then inspect the current codebase. **The code is the source of truth.** If this file and the code disagree, trust the code and correct this file.
> 3. Follow the existing architecture. Reuse existing services, repositories, providers, components and the status system. Do not build second versions of them (see §4.1).
> 4. Read `AGENTS.md` / `CLAUDE.md`. This project uses **Next.js 16**, whose APIs differ from older versions; check `node_modules/next/dist/docs/` before writing Next.js code.
> 5. After any significant implementation change (new feature, migration, architecture decision, or a known bug fixed or found), **update this file**: status (§6), decisions (§9) and, if relevant, the schema and commands.
> 6. Never put credentials, tokens or passwords in this file.

*Last verified against the code: 2026-10-23 (git `4ec51e8 "Phase 6 completed"`, working tree clean).*

---

## 1. Project overview

**QA Pilot AI** is a local-first platform for website QA automation. For a project's website it:

- discovers the pages (crawler);
- runs real browser checks with Playwright (Chromium, Firefox, WebKit);
- records only results backed by evidence;
- turns verified failures into bugs;
- produces Excel, PDF and HTML reports;
- keeps the history of every run and compares runs for regressions;
- runs customer-supplied Excel test cases and writes the results back to Excel.

**Branding.** The app name is "QA Pilot AI". The footer must read exactly `© Pawan Rewatkar. All Rights Reserved.` (`lib/constants/brand.ts`). The Copyright & IP page is at `/copyright`, linked from the sidebar and the footer. It must not use any anti-copy techniques (no blocking selection, right-click or keyboard shortcuts).

**Tech stack**

| Area | Technology |
| --- | --- |
| App | Next.js 16.3 App Router (Turbopack), React 19, TypeScript, Tailwind 4, Radix UI, lucide-react, zod 4 |
| Data | SQLite via better-sqlite3 (WAL mode, foreign keys on) |
| Browser engine | Playwright 1.63, axe-core with @axe-core/playwright, local Lighthouse with chrome-launcher |
| Documents | ExcelJS (Excel reports and external test cases), unpdf and mammoth (reading PDF and DOCX reference documents) |
| Tests | Vitest 5; the worker runs on tsx; Node 24 for development (requires ≥ 20.9) |

**Architecture**

```
Next.js web app ──server actions──► jobs table (SQLite) ◄──claim── Worker process (npm run worker)
  pages / API routes / polling         ▲                           Playwright browsers, Lighthouse,
                                       └──── results, evidence, bugs, reports ── report rendering
Storage: local filesystem (data/storage)   DB: data/qa-pilot.db
```

- **Two processes.** The web app (UI, server actions, API routes) and the worker (`worker/index.ts`). The web app never launches a browser.
- **Job queue.** Job types are `crawl.project`, `run.execute` and `report.generate` (`worker/jobs/job-queue.ts`, `registry.ts`).
  - Jobs are claimed atomically.
  - The worker sends a heartbeat every 5 s.
  - When a worker starts, it marks jobs owned by dead workers as FAILED (`recoverAbandonedWork`).
- **Providers behind interfaces** (each can be replaced): `DatabaseProvider`, `StorageProvider`, `AIProvider`, `FigmaProvider`, `PerformanceProvider`, `EmailProvider`, `CrawlerProvider`, `TestingProvider`, `PdfRenderer`, `DuplicateDetector`, `ExternalTestCaseSourceProvider`.

**Deployment goal.** The app runs locally today.

- **Future shared deployment:** the web app on Vercel, the Playwright worker as a long-running container or VM (`deploy/worker.Dockerfile` is a template), a hosted database (implement `DatabaseProvider`, e.g. Supabase), and object storage (implement `StorageProvider`).
- **Not deployed yet.** Nothing has been deployed, and no deployment is automated.

---

## 2. Development phases (all six are implemented and committed)

| Phase | Commit | Scope (implemented) |
| --- | --- | --- |
| 1 Foundation | `6f23068` (with 2 and 3) | UI shell and navigation, dashboard, projects (CRUD, website URL, Figma URL, Test Email, reference document upload), test configurations, SQLite `DatabaseProvider`, storage, provider interfaces, settings (provider status, never secret values), Copyright & IP page, env/README |
| 2 Crawler and core QA | `6f23068` | Crawler (robots.txt, sitemap, depth and page limits, exclusions, query rules, page-type detection, live progress, cancel); Playwright engine in the worker; test runs (pages × browsers × viewports × modules); link, navigation, functional, components, search, filters, pagination, breadcrumb, forms, newsletter, login/logout, console, network checks; positive/negative/edge/boundary scenarios; result model with evidence |
| 3 Advanced QA | `6f23068` | UI and responsive layout analysis, typography, accessibility (axe plus a keyboard probe), SEO, local Lighthouse performance (browser-timing fallback), content comparison against PDF/DOCX/MD/TXT (EXACT and SECTION modes; SEMANTIC needs AI → NOT EXECUTED), ecommerce (cart, never pay), Figma architecture (→ NOT EXECUTED), expectation hierarchy, per-check detail tables |
| 4 Bugs, reports, history | `85bbde2` | Bug engine (FAIL only), evidence, deterministic duplicate detection, reopening on recurrence, bug list and detail; Excel testing report (13 sheets) and bug report (3 sheets); PDF (local Chromium); standalone HTML; Report Center; run history; regression comparison; dashboard analytics; secret redaction |
| 5 Integration and hardening | `1bf470b` | Report types selected per run are auto-generated on completion; per-page and per-screenshot failure isolation; project deletion removes all records and files and cancels queued jobs; FK indexes (migration 5); accessible status colours (contrast); responsive grid fixes; security headers; worker log redaction; README (architecture, environment, security, Vercel, future integrations); end-to-end test suite |
| 6 External Test Case Testing | `4ec51e8` | `/external-test-cases`: Excel source (upload, local path, Google Drive shared link) → worksheet → column mapping → preview → devices (desktop, mobile, tablet) → browsers → output (Existing Sheet / New Result Sheet) → execution → statuses including HUMAN INTERACTION → result Excel with versioned columns → history and bugs |

---

## 3. Functional requirements and current behaviour

### 3.1 Navigation (`components/layout/nav-items.ts`)
- **Workspace:** Dashboard `/`, Projects, Test Runs, Pages, Test Cases, External Test Case Testing, Bugs, Reports, History.
- **System:** Settings, Copyright & IP.

### 3.2 Routes
- **Pages:**
  - `/` (dashboard)
  - `/projects`, `/projects/new`, `/projects/[id]`, `/projects/[id]/edit`, `/projects/[id]/configure`, `/projects/[id]/pages` (crawl and page selection)
  - `/test-runs`, `/test-runs/new`, `/test-runs/[id]`, `/test-runs/[id]/compare`
  - `/pages`, `/test-cases`
  - `/bugs`, `/bugs/[id]`
  - `/reports`, `/history` (`?tab=activity`)
  - `/external-test-cases`, `/external-test-cases/[id]`
  - `/settings`, `/copyright`
- **API:**
  - `/api/test-runs/[id]` and `/api/crawl-runs/[id]` (polling)
  - `/api/artifacts?key=` (screenshots, known keys only)
  - `/api/documents/[id]`
  - `/api/reports/[id]/[kind]` (`?download=1`; HTML is served with a sandbox CSP)
  - `/api/external-test-cases/[id]` (progress) and `/api/external-test-cases/[id]/download`
  - `/api/workers`

### 3.3 Test modules (`lib/constants/testing.ts`, engine `lib/testing/registry.ts`)

| Group | Modules |
| --- | --- |
| Core | ui, functional, positive, negative, edge, boundary |
| Links and navigation | links, navigation, breadcrumb, pagination, social-links, downloads |
| Forms | forms, newsletter, search, filters, dropdowns, login, logout |
| Components | tabs, accordion, modals, carousel, ecommerce |
| Quality | performance, accessibility, seo, responsive, console, network |
| Content and design | content, figma, typography |

- **Scenario modules:** positive, negative, edge and boundary select scenario-type cases from the feature modules.
- **Internal module:** `external` (External Test Case Testing). It is listed in `INTERNAL_TEST_MODULES` and is not selectable in website runs.
- **Labels:** `page-load` is a pseudo-module, labelled "Page load".
- **Parity test:** a unit test keeps `IMPLEMENTED_MODULE_IDS` in step with the registry.

### 3.4 Viewports
- **`VIEWPORTS`** (website runs, and the responsive sweep iterates over them): desktop 1920×1080, 1440×900 and 1366×768; mobile 390×844, 375×812 and 412×915.
- **`TABLET_VIEWPORTS`** (Phase 6, external tests only): 768×1024 and 820×1180. They are deliberately kept out of `VIEWPORTS` so the existing behaviour is unchanged.
- **Lookup:** use `ALL_VIEWPORTS` / `findViewport()`.
- **Emulation:** phones and tablets get touch and mobile emulation (`lib/playwright/browsers.ts`).

### 3.5 Reports (`lib/reports`)
- **Files:**
  - `QA_Testing_Report_<site>_<date>.xlsx`: Summary, Page Wise Testing, UI Testing, Functional Testing, Positive Negative Edge Testing, Links, Performance, Accessibility, SEO, Console & Network, Content Comparison, Figma Comparison and Typography, plus UI Measurements and Link Checks.
  - `QA_Bug_Report_<site>_<date>.xlsx`: Bug Report, Bug Summary, Testing Type Bug Count.
  - PDF: rendered locally by headless Chromium with JavaScript off and the network blocked.
  - HTML: a standalone file with inline CSS, JS and SVG and base64 screenshots.
- **Formats offered in the UI:** EXCEL, PDF and HTML. JSON and CSV exist in the database CHECK constraint but are **not implemented**, and were removed from the UI.
- **Report "sections" on configurations** are stored but **ignored**: reports include every section that has data.
- **Caps:** 60 embedded screenshots; the PDF shows at most 1,500 test cases and 400 rows per detail table; Excel and HTML include up to 5,000 rows per detail table.

### 3.6 External Test Case Testing (`lib/external-tests`)
- **Sources:**
  - upload (`.xlsx` / `.xlsm`, up to `MAX_UPLOAD_MB`);
  - local path (only inside `EXTERNAL_TEST_CASES_DIR`, default `./data/test-cases`);
  - Google Drive / Sheets link shared as "Anyone with the link". No OAuth; redirects only to Google hosts; otherwise the error "Unable to access the Google Drive file…". `GoogleDriveTestCaseProvider` (OAuth) is a placeholder.
- **Parsing:**
  - The header row is auto-detected in the first 20 rows.
  - Empty rows are ignored; at most 2,000 cases per sheet.
  - The original workbook is never modified; the uploaded draft is stored under `external-drafts/<uuid>/` until the execution starts.
- **Mapping:** synonyms detect caseId, title, scenario, steps, expected, url, testData and preconditions. The user can correct the mapping. Title or scenario and expected are **required**; steps are optional.
- **Interpretation** (`interpret.ts`) is deterministic, never AI:
  - Actions: open, click, fill, search, select, hover, scroll, check/uncheck, press, submit, add to cart, verify.
  - Upload steps and password steps → NOT EXECUTED or HUMAN INTERACTION.
  - Missing steps are inferred only for clear cases (search, sorting, add to cart, a navigation target).
- **Evaluation** (`evaluate.ts`): the expected result becomes checks, judged against observed facts:
  - checks: navigation, text, validationError, success, element, pageLoads, sorted, cartAdded, results, noNavigation, expanded, download, url;
  - outcomes: PASS / FAIL / UNDETERMINED (→ HUMAN INTERACTION) / BLOCKED (→ NOT EXECUTED).
- **Execution:** the run is a `test_runs` row with `run_type = EXTERNAL_TEST_CASE`, modules `["external"]`, inside the existing `executeRun`.
  - Cases run one after another per browser × viewport, each from a clean session (cookies cleared).
  - Collapsed menus are opened when a target is hidden.
- **Aggregation across combos** (worst first): FAIL > HUMAN INTERACTION > NOT EXECUTED > PASS > NOT APPLICABLE. The Actual Result lists each device.
- **Output:** `QA_External_Test_Result_<site>_<date>.xlsx`, either:
  - **EXISTING_SHEET:** the result columns are added to the selected sheet; or
  - **NEW_SHEET:** the sheet is copied to "<Sheet> Results" (or "(2)", …) with all original columns, and the original sheet is untouched.

---

## 4. Technical decisions and constraints

### 4.1 Reuse — do not duplicate
| Need | Use the existing … |
| --- | --- |
| Database access | `DatabaseProvider` (`lib/database/provider.ts`), `LocalDatabaseProvider`, repositories in `lib/database/local/*`; server components call `requestDb()` (`lib/server/db.ts`, which calls `connection()`) |
| Worker writes | `SqliteEngineStore` (`lib/database/local/engine-store.ts`) |
| Browsers | `launchBrowser` / `createContext` (`lib/playwright/browsers.ts`), `PageSession` (console, network, downloads, dialogs, guard modes) |
| Results | `finalizeOutcome` / `outcome.*` / `evidence.*` (`lib/testing/outcome.ts`), `spec()` (`lib/testing/modules/helpers.ts`), `store.recordOutcome` |
| Detail tables | `DETAIL_COLUMNS` (`lib/testing/details.ts`), `DETAIL_VIEWS` (`lib/constants/detail-views.ts`) |
| Screenshots | `ctx.capture()` in the run executor (masking via `sensitiveMask`), `store.saveScreenshot` |
| Bugs | `createBugsForRun` (`lib/bugs/engine.ts`), `classify.ts`, `duplicates.ts` |
| Reports / Excel styling | `lib/reports/*`, `STATUS_FILL`, `HEADER_FILL` (`lib/reports/excel.ts`), `websiteSlug`, `reportFileNames` |
| HTTP | `fetchUrl` (`lib/net/http.ts`, supports `readBody: "bytes"`) |
| URL validation | `normalizeWebsiteUrl`, `isSameSite` (`lib/validation/url.ts`), `normalizeCrawlUrl` |
| Files | `validateDocument`, `matchesSignature`, `sanitizeFileName` (`lib/documents/validate.ts`) |
| Safe test data | `safeValueFor` (`lib/forms/test-data.ts`) |
| Redaction | `redactText` / `redactRecord` (`lib/reports/redact.ts`) |
| History / comparison | `HistoryRepository`, `lib/regression/compare.ts` |
| UI | `components/ui/*`, `PageHeader`, `EmptyState`, `Pagination`, `ConfirmDialog`, `AutoRefresh`, `SubmitButton`, `usePolling`, status badges (`components/shared/status-badges.tsx`) |

### 4.2 Code-level constraints
- **Browser-side code.** Code that runs inside the page must be a **plain JS string** run with `runScript(page, fnSource, arg)` or `page.evaluate(string)`. tsx injects `__name` helpers, which break function serialization.
- **Imports.** Only the worker may import Playwright or the engine. Client components import plain constants and types only. Keep heavy modules (ExcelJS, writer) out of web-side repositories: for example, `aggregateStatus` lives in a lightweight `status.ts`.
- **SQL.** SQL is always parameterized. Dynamic identifiers come only from whitelists.
- **Migrations.** Migrations are append-only (never edit one that has shipped) and additive, never deleting data. Every foreign-key column must be indexed; the test in `tests/phase5.test.ts` enforces this.
- **Next.js 16.**
  - `params` and `searchParams` are async.
  - Use the `PageProps<"/route">` and `RouteContext<"/api/…">` types (generated by `next typegen`).
  - Call `await connection()` before synchronous SQLite reads in server components.
  - Server actions have an 11 MB body limit.

### 4.3 Database (`lib/database/schema.ts`, migrations 1–6)
- **v1** `initial_schema`:
  - projects, documents, test_credentials (username plus a `secret_ref` only; **no passwords stored**);
  - test_configurations, test_runs, pages, test_run_pages, test_cases, test_results;
  - screenshots, bugs, bug_evidence;
  - performance, accessibility, seo, link, console, network, ui, typography, content and figma tables;
  - reports, activity_log, jobs.
- **v2** `crawler_and_test_engine`: crawl_runs, form_submissions and worker_heartbeats, plus columns on pages, runs, cases and results.
- **v3** `advanced_testing_modules`: measurement columns, and `performance_results` rebuilt with a source of LOCAL_LIGHTHOUSE, LOCAL_BROWSER or PAGESPEED.
- **v4** `bugs_reports_history`: `bugs` and `bug_evidence` rebuilt, plus bug_occurrences, bug_status_history, report_bundles, `screenshots.kind/label` and `reports.bundle_id/kind`.
- **v5** `foreign_key_indexes`: 31 FK indexes.
- **v6** `external_test_cases`: `test_runs.run_type` (WEBSITE | EXTERNAL_TEST_CASE), plus external_test_executions, external_test_cases and external_test_observations.
- **Total:** 34 tables (`EXPECTED_TABLES`).
- **Deletion:** deleting a project cascades to all of its rows. `ProjectRepository.storagePrefixes()` together with the service deletes `projects/<id>`, `runs/<runId>` and `reports/<bundleId>`, and cancels queued jobs.

### 4.4 Local-first constraints and prohibited dependencies
- The core app must work **without** the Anthropic/Claude API, Supabase, the Figma API, the Google PageSpeed API, an external email API, or any paid cloud service. These are future, optional providers only.
- **AI** (`AIProvider`, currently `LocalAnalysisProvider`, deterministic and offline):
  - AI may assist with test case generation, exploratory scenarios, prioritisation, expected-behaviour analysis, bug titles, root-cause and severity suggestions, duplicate suggestions, semantic content comparison, Figma comparison and summaries.
  - AI must **never** invent executions, evidence, screenshots, performance numbers, Figma measurements, expected content or test results.
  - An AI-derived expectation can produce at most a WARNING, never a FAIL (`finalizeOutcome`).
- **No hostile anti-copy techniques.**

### 4.5 Security (implemented)
- **Secrets.** Environment variables are read only on the server (`lib/config/env.ts`, zod); there are no `NEXT_PUBLIC_` variables. Settings shows only whether a key is present.
- **Redaction.** Text in reports, bugs and worker logs is redacted: URL credentials, sensitive query parameters, bearer and basic tokens, JWTs, password and API-key values, card numbers; email addresses are masked.
- **Screenshots.** Password, payment, one-time-code and `data-sensitive` fields are masked in screenshots.
- **Uploads.** Uploads are allow-listed and checked by size and file signature. Storage keys are validated, so paths cannot escape the storage folder. Download file names are sanitized. Excel content is treated as data only.
- **HTTP headers.** Responses send `nosniff`, Referrer-Policy, `X-Frame-Options: SAMEORIGIN` and Permissions-Policy.
- **No authentication.** Use the app only on a trusted machine. The server actions are marked where auth checks belong.

---

## 5. Business rules (must hold)

1. **Statuses (website runs):** exactly `PASS`, `FAIL`, `WARNING`, `NOT EXECUTED`, `NOT APPLICABLE`, enforced by database CHECK constraints.
   - PASS requires a recorded verification; FAIL requires evidence. Otherwise `finalizeOutcome` downgrades the result to WARNING.
   - A verdict needs `executed_at`.
   - NOT EXECUTED always carries a reason. NOT APPLICABLE means the feature is absent or irrelevant.
2. **External Test Case statuses:** `PASS`, `FAIL`, `HUMAN INTERACTION`, `NOT EXECUTED`, `NOT APPLICABLE`.
   - HUMAN INTERACTION is stored in the standard results as WARNING (review required).
   - The Actual Result of a HUMAN INTERACTION case starts with **"This test case needs human interaction."**, and its Actual Result and Status cells are **yellow** (`FFFFF59D`).
   - Triggers: OTP, SMS, CAPTCHA, two-factor, payment or order, a real inbox, a physical device, third-party login, real credentials, visual or business judgement, or an expectation that cannot be measured.
   - Actual Results always describe what was observed, never just "Pass" or "Fail".
3. **No fabricated results.** Never fake a PASS, FAIL, bug, screenshot, PageSpeed value, Figma measurement, expected content or metric. Figma is not configured → NOT EXECUTED. Lighthouse or content extraction failure → NOT EXECUTED.
4. **Bugs:** created **only from a FAIL with evidence**, never from a WARNING or NOT EXECUTED.
   - The fingerprint is the normalized page URL plus the case key. A recurrence adds an occurrence to the same bug.
   - Bugs are **never auto-resolved**. A RESOLVED or CLOSED bug that fails again becomes REOPENED.
   - Regression comparison reports "Resolved" only when the same check executed and PASSED.
5. **Form and email safety:**
   - Non-GET requests are intercepted unless "Allow real form submissions" is on, and then each form is submitted at most once (`form_submissions` ledger).
   - Email fields receive only the project's **Test Email**; without one → NOT EXECUTED. No addresses are ever generated.
   - No spam, no repeated newsletter sign-ups, no brute force or credential stuffing.
6. **Ecommerce:** product, variant, quantity, add to cart, cart, update and remove are allowed. **Never** place an order, submit a payment, enter real card data or complete a purchase → HUMAN INTERACTION or NOT EXECUTED. Destructive actions (delete, unsubscribe, cancel account) are not performed.
7. **Excel results must never overwrite earlier executions:**
   - Columns are checked by **content**, not just by header.
   - An empty `Actual Result / Status / Date` set is reused. A set with any data, **even partial**, counts as used, and the next set is added: `Actual Result 2 / Status 2 / Date 2`, then 3, and so on.
   - Columns mapped as test-case inputs are never used for results.
   - The Date column records the real execution date. Original data and formatting are preserved, and the uploaded original is never changed.
8. **Run isolation:** each run stores its own configuration snapshot, pages, modules, browsers, viewports, results, evidence (`runs/<runId>/…`), bug occurrences and reports. A new run never overwrites an earlier one.

---

## 6. Project status (verified 2026-10-23)

**Implemented and committed:** everything in §2.

**Checks run on 2026-10-23:** `tsc --noEmit` ✅, `npm run lint` ✅, `npm run test:unit` ✅ (10 files, 243 tests).

**Last full run (2026-10-09, at the Phase 6 commit):**
- `npm test` (unit and real-browser integration): ✅ 15 files, 283 tests.
- `npm run test:e2e`: ✅ 8/8, covering:
  - the full UI workflow (project → crawl → select → run → bugs → auto reports → history → compare);
  - the external Excel workflow through the UI;
  - an axe scan of 19 pages with no serious or critical issues;
  - no horizontal overflow at 390 px.
- `npm run build`: ✅.

Integration and e2e were not re-run on 2026-10-23.

**Partially implemented, or reserved for later:**
- Figma comparison: the provider architecture exists; checks are NOT EXECUTED.
- Semantic (AI) content comparison: NOT EXECUTED. AI is the local deterministic provider only.
- Login and logout positive tests: there is no credential-store UI → NOT EXECUTED.
- Supabase `DatabaseProvider`: a stub that throws `DatabaseNotImplementedError`. Cloud `StorageProvider`: not implemented.
- Google PageSpeed and email/SMTP providers: not implemented. The email provider is a local outbox.
- Private Google Drive access (OAuth): placeholder only.
- JSON and CSV report formats: not implemented, and hidden from the UI.
- Report "sections" settings: stored but ignored.

**Known limitations and bugs (none critical known):**
- No authentication and no multi-user support. One worker runs jobs one at a time.
- Lighthouse scores vary between runs. Automated accessibility checks cover only part of WCAG.
- External tests:
  - deterministic interpretation only; unusual phrasing → NOT EXECUTED or HUMAN INTERACTION;
  - links that open a new tab are not followed;
  - `.xls` and `.csv` are unsupported;
  - Excel charts and images may not survive in the output;
  - abandoned drafts remain under `data/storage/external-drafts/`;
  - if a worker dies mid-run, external cases stay without a status (the run is marked FAILED by recovery).
- Uploads are limited by Vercel's 4.5 MB request body if the app is deployed there.

**Suggested next steps:**
1. Authentication and per-project access.
2. Hosted `DatabaseProvider` and cloud `StorageProvider`, with the job queue moved to the hosted database.
3. An encrypted credential store and its UI, to enable login testing.
4. Parallel and multiple workers.
5. Optional AI and Figma providers that follow the rules in §4.4.
6. External tests: following new tabs, a cleanup job for old drafts, `.csv` support, and finalizing external cases when stale-worker recovery runs.

---

## 7. Development and testing commands (from `package.json`)

```bash
npm install
npm run browsers:install      # Playwright Chromium, Firefox and WebKit (one-time)
cp .env.example .env.local    # optional; every setting has a local default
npm run dev:all               # web app (http://localhost:3000) + worker
npm run dev | npm run worker  # or run them separately; without the worker, jobs stay queued
npm run worker -- --once      # process the available jobs, then exit
npm run db:migrate            # create or migrate SQLite (also happens automatically)
npm run lint
npm run typecheck             # next typegen && tsc --noEmit
npm test                      # unit + real-browser integration (skipped if browsers are missing)
npm run test:unit             # fast
npm run test:integration      # tests/integration against the local fixture site
npm run build && npm run test:e2e   # e2e: production app + worker + fixture site (needs .next)
npm run build && npm start
```

**Test layout**

| Location | Contents |
| --- | --- |
| `tests/*.test.ts` | Unit tests: database, validation, crawler, engine rules, advanced modules, Phase 4 (`phase4.test.ts`), Phase 5 (`phase5.test.ts`), external tests (`external-tests.test.ts`) |
| `tests/integration/` | Real browser: engine, advanced, crawler, reports, external-tests (the 13-case acceptance workbook) |
| `tests/e2e/workflow.e2e.ts` | UI end-to-end, run with `vitest.e2e.config.mts` |
| `tests/fixtures/site-server.ts` | Deterministic local website with known defects, cart and checkout flow, and a `/catalog` sort page. Its recorded writes are used to assert that nothing was submitted |

Always use the fixture site for automated tests, never third-party sites.

**Tooling gotcha.** In shell heredocs and `node -e` patch scripts, `\n`, `\b` and quotes get mangled. Prefer the Edit/Write tools, or write `.cjs` scripts with the Write tool.

---

## 8. Git, environment and deployment

- **Repository:** `https://github.com/pawanrewatkar/QA_Pilot_AI.git`, branch `main`.
  - Git identity (repo-local): `pawanrewatkar <pawanrewatkar28@gmail.com>`.
  - Commit or push only when the user asks.
- **Top-level folders:**
  - `app/` (routes and server actions)
  - `components/` (ui, shared, layout, dashboard, crawl, test-runs, test-config, projects, external-tests)
  - `lib/` (database, testing, crawler, playwright, bugs, reports, regression, external-tests, services, validation, providers, storage, ai, figma, performance, email, content, forms, net, config, constants)
  - `worker/` (index, jobs, crawler, test-engine)
  - `types/`, `tests/`, `scripts/`, `deploy/`, `data/` (git-ignored except README)
- **`.gitignore`** excludes `node_modules`, `.next`, `data/*`, every `.env*` file except `.env.example`, `.vercel`, `*.pem`, coverage and other test output.
- **Environment variables** (names only; see `.env.example`):
  - `DATABASE_PROVIDER` (local), `DATABASE_PATH`
  - `STORAGE_PROVIDER` (local), `STORAGE_PATH`, `MAX_UPLOAD_MB`, `EXTERNAL_TEST_CASES_DIR`
  - `AI_PROVIDER` (local)
  - reserved, with no effect today: `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `FIGMA_ACCESS_TOKEN`, `PAGESPEED_API_KEY`, `EMAIL_PROVIDER`, `SMTP_URL`
- **Vercel readiness:**
  - The web app is Vercel-compatible.
  - The worker **must not** run on Vercel serverless (time limits, no browsers); use `deploy/worker.Dockerfile` (`mcr.microsoft.com/playwright:v1.63.0-noble`).
  - SQLite and local storage need a shared disk, so hosted providers are needed for Vercel.
  - `next.config.ts` keeps `better-sqlite3` and `playwright` external.

---

## 9. Decisions log and open questions

**Decisions**
- External tests reuse `test_runs` (adding `run_type`) and the `external` engine module, rather than a separate run system. Website-run validation does not accept `external`.
- HUMAN INTERACTION is stored as WARNING in `test_results`, and as its own status in the `external_test_*` tables. This keeps the standard five-status CHECK constraint intact.
- Tablet viewports are kept separate (`TABLET_VIEWPORTS`) so the responsive module and website-run forms are unchanged.
- Bugs use deterministic fingerprints. Related bugs are shown but never merged. Future AI may only suggest duplicates.
- Reports are generated in the worker. Each file in a bundle succeeds or fails independently: a PDF failure does not block the HTML or Excel files.
- Regression comparison uses noise thresholds: score ±5, LCP ±10% and 100 ms, TBT ±10% and 50 ms, CLS ±0.02. Results from different sources are not compared.
- Project deletion cancels queued jobs and asks running jobs to stop. Run evidence is stored under `runs/<runId>`; external source workbooks under `projects/<id>/external-test-cases/`.
- An external execution without a chosen project reuses the project with the same host, or creates one through the `createProject` service.

**Open questions (to confirm with the user)**
- Authentication model and multi-user support before any shared deployment.
- Which hosted database and storage to use (Supabase or other), and how the worker will be hosted.
- Whether to implement the JSON and CSV report formats and per-section report options, or remove them from the database and configuration model.
- Whether real credential-based login testing is wanted (it needs a secure secret store).
- Whether external tests should support `.csv` / `.xls` files and links that open in a new tab.
