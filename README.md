# QA Pilot AI

Website testing and QA automation platform. QA Pilot AI inspects websites, discovers their pages, runs real browser-based QA checks, captures evidence and records verifiable results.

**Current phase: Phase 4 (bugs, reports, history and regression).**

- Phase 1 delivered the application shell, project management, test configuration, the local database, the provider architecture and the worker scaffolding.
- Phase 2 adds:
  - a real website crawler
  - page type detection
  - a Playwright test engine for Chromium, Firefox and WebKit that runs in a separate worker process
  - live test runs with evidence
- Phase 3 adds UI, Responsive, Typography, Accessibility (axe-core), SEO, Performance (local Lighthouse), Content comparison (PDF/DOCX), Ecommerce and enhanced Console/Network/Forms testing, plus the Figma provider architecture and an expectation hierarchy.
- Phase 4 adds an evidence-based bug engine, a bug dashboard, Excel/PDF/standalone-HTML reports with a Report Center, test-run history, regression comparison between runs, and dashboard analytics from real data.

© Pawan Rewatkar. All Rights Reserved. See the in-app **Copyright & IP** page.

---

## Requirements

- Node.js **20.9 or newer** (developed on Node 24)
- npm 10+
- Playwright browser binaries (one-time download, about 500 MB; see below)
- No external accounts, API keys or cloud services

`better-sqlite3` ships prebuilt binaries for common platforms. If your platform has none, npm builds it from source, which needs Python and a C++ toolchain (on Windows: "Desktop development with C++" from the Visual Studio Build Tools).

## Installation

```bash
git clone <your-repo-url> qa-pilot-ai
cd qa-pilot-ai
npm install
npm run browsers:install     # downloads Chromium, Firefox and WebKit for Playwright
cp .env.example .env.local   # optional: every setting has a local default
```

## Running locally

The app has two processes:

- the **web app**, which serves the UI and queues work;
- the **worker**, which runs crawls and browser tests.

Start both together:

```bash
npm run dev:all          # web app on http://localhost:3000 + worker
```

or in two terminals:

```bash
npm run dev              # terminal 1: web app
npm run worker           # terminal 2: background worker
```

If the worker is not running, crawls and test runs stay queued and the UI shows a "worker is not running" banner.

### Typical workflow

1. **Projects → New project.** Enter the website URL, plus an optional Test Email used for form testing.
2. **Pages & crawl.** Set the depth, page limit, timeout, retries, exclusions, robots.txt and sitemap rules, then press **Start crawl**. While it runs you see progress, the current URL and depth, and you can stop it.
3. Review the discovered pages. You can search, filter by page type or status, select or deselect pages, and add URLs manually.
4. **New test run.** Optionally start from a saved configuration. Choose pages, modules, browsers and viewports, and set the safety options, then press **Start test run**.
5. Watch live progress: the current page, the current test and result counts. You can cancel the run.
6. Review the results. Failures are listed first. Expand a row to see steps, expected and actual results, the verifications made, and evidence such as screenshots, HTTP checks and console or network logs. **Test Cases** lists the generated cases.

### Commands

| Command | What it does |
| --- | --- |
| `npm run dev` / `npm run worker` / `npm run dev:all` | Web app / worker / both |
| `npm run build`, `npm start` | Production build and serve |
| `npm run lint` | ESLint |
| `npm run typecheck` | Generate route types and run `tsc --noEmit` |
| `npm test` | All tests (unit and real-browser integration) |
| `npm run test:unit` | Fast unit tests only |
| `npm run test:integration` | Real-browser tests against a local fixture website (skipped if browsers are not installed) |
| `npm run browsers:install` | Install Playwright browsers |
| `npm run db:migrate` | Create or migrate the SQLite database |

## What the engine does

### Website crawler (`lib/crawler`, `worker/crawler`)

- **Before crawling:**
  - validates and normalizes the start URL;
  - confirms the site is reachable (over HTTP, then a real browser if the server rejects plain clients);
  - follows redirects only within the site. An off-site redirect stops the crawl with a clear message.
- **Discovery sources:**
  - header, navigation, footer, CTA, breadcrumb, pagination and in-content links;
  - buttons that navigate (`data-href`, `onclick` location changes);
  - `robots.txt` sitemaps and `sitemap.xml`, including sitemap indexes.
  - Each page records every source it was found through.
- **Normalization and deduplication:**
  - removes fragments and default ports;
  - lower-cases the host and normalizes the trailing slash and `index.html`;
  - sorts query parameters and strips tracking parameters (configurable);
  - collapses redirect aliases into one page;
  - detects crawl traps (repeated path segments, session ids, very deep paths).
- **Limits and rules:**
  - maximum depth, maximum pages, per-page timeout, retries for transient errors;
  - wildcard or substring exclusions;
  - same-domain restriction (optionally including subdomains);
  - robots.txt (Allow/Disallow with wildcards, crawl-delay).
- **Never visited:** logout, sign-out, delete, remove and unsubscribe URLs, plus non-HTML files.
- **Error handling:** a failing page (404, 500, timeout) is recorded as Failed and the crawl continues.
- **Page type detection:** classifies each page as one of 19 types (Homepage, About, Contact, Services, Product Listing/Detail, Collection, Blog Listing/Detail, FAQ, Pricing, Login, Signup, Dashboard, Search, Cart, Checkout, Account, Landing Page) or Other. It uses the URL path, title and heading keywords, structured data (JSON-LD and microdata) and DOM signals, and stores a confidence score.

### Test engine (`lib/testing`, `lib/playwright`, `worker/test-engine`)

**How a run is executed**

- A run is pages × browsers × viewports × modules. Each unit gets a fresh browser context.
- One failure never stops the run:
  - If a browser fails to start, its units are recorded as `NOT EXECUTED`.
  - If a page fails to load, the page-load check records `FAIL` or `WARNING` with evidence, and that page's checks are recorded as `NOT EXECUTED`.
  - If a module throws or times out, only that module is recorded as `NOT EXECUTED`.
  - Page crashes are detected and the tab is reopened.
- The engine classifies navigation timeouts, SSL, DNS and connection errors, blocked requests and page crashes for Chromium, Firefox and WebKit.
- It collects console messages, uncaught page errors, network traffic, downloads and dialogs.
- Screenshots are stored as evidence.

**Implemented modules**

| Module | What is verified |
| --- | --- |
| Link | Every unique link: internal, external, navigation, CTA, footer, mailto (address syntax), tel (dialable number). HEAD with GET fallback; redirects followed. |
| Social link, Download | Social profile links. Downloads must be served as non-HTML and complete a non-empty browser download. |
| Navigation | Navigation is present; nav links really navigate to their destination; the hamburger menu opens and closes (`aria-expanded`, the controlled element, visible links). |
| Functional | Buttons and CTAs produce an observable result. Purchase, submit, subscribe, delete and logout controls are skipped for safety. |
| Dropdown | Native selects take a value; custom dropdowns open and close with Escape. |
| Tabs | The clicked tab becomes selected and its panel is visible; arrow-key navigation works. |
| Accordion | `<details>` and ARIA accordions open and close. |
| Modal | A dialog opens, and closes with Escape or its close button. |
| Slider/Carousel | The active slide changes (position-aware state signature). |
| Search | Positive (term from the page appears in the result URL or page), negative (special characters), edge (whitespace, Unicode, long text) and boundary (declared maxlength) cases. |
| Filter, Pagination, Breadcrumb | Filters and sorting change the URL or content; the next page loads different content; the breadcrumb marks the current page and its parent link works. |
| Form | Negative (empty required fields, invalid email or phone, invalid `pattern` attributes), positive (valid data accepted client-side; optional real submission), edge (Unicode and special characters, whitespace-only, long text) and boundary (declared min/max length and range). |
| Newsletter, Login, Logout | Newsletter validation and an optional single sign-up; login validation and an optional single invalid-credentials attempt; logout is `NOT EXECUTED` until test credentials exist. |
| Console, Network | Uncaught errors (FAIL) and console errors (WARNING); console warnings are stored for review, never treated as failures. Failed JS, CSS, images, fonts and other requests per type (first-party FAIL, third-party WARNING), CORS errors and mixed content (WARNING). Rows stored with page, browser, viewport and timestamp. |
| Positive / Negative / Edge / Boundary | Select those scenario types across the feature modules above. |

### Advanced modules (Phase 3)

| Module | What is measured | Stored in |
| --- | --- | --- |
| UI | Horizontal overflow, broken/missing/distorted images, clipped text and buttons/CTAs, covered interactive elements, content outside cards, grid width consistency, alignment and spacing of repeated items, header and footer problems, off-screen content. Only measured facts are reported; unambiguous defects (overflow, broken images, clipped controls, form fields off-screen) are FAIL, others WARNING. | `ui_results` |
| Responsive | The same measurements at all six viewports (1920×1080, 1440×900, 1366×768, 390×844, 375×812, 412×915), plus mobile navigation and 24×24px touch targets (WCAG 2.5.8) on mobile. Screenshots are saved when problems are found. | `ui_results` |
| Typography | Font family, size, weight, line height, letter spacing, colour, tag and text for H1–H6, paragraphs, links, buttons, CTAs, labels and navigation. With no Figma/reference source, the comparison is NOT EXECUTED and no expected values are invented. Four reporting modes: typography only, + HTML tags, + content, complete measurable UI. | `typography_results` |
| Accessibility | axe-core (WCAG 2.0/2.1/2.2 A/AA + best practice) via @axe-core/playwright: violations FAIL with node evidence, "incomplete" WARNING; keyboard Tab probe for focus reach and visible focus indicators. Every result states that automated checks are not WCAG compliance. | `accessibility_results` |
| SEO | Title, meta description, H1, heading hierarchy, canonical (and whether it resolves), robots meta, robots.txt, sitemap, image alt, Open Graph (og:image resolves), Twitter card, broken links, duplicate titles/descriptions across tested pages. | `seo_results` |
| Performance | Local Lighthouse (no Google API) per form factor: Performance, Accessibility, Best Practices and SEO scores; LCP, CLS, FCP, TBT, Speed Index, TTFB. INP needs real interactions and is NOT EXECUTED. Rated with published thresholds. If Lighthouse cannot run, a clearly labelled browser-timing fallback without scores is used. | `performance_results` |
| Content | Compares page text with the project's reference document (PDF, DOCX, Markdown, text). Exact and section modes run locally; semantic mode needs an AI provider and is NOT EXECUTED. Finds missing, changed, misspelled, heading, extra, repeated, re-ordered and CTA differences, excluding header/footer/navigation/cookie/author/reviews/ads/recommendations/dynamic content or custom selectors. Pages that do not correspond to the document are NOT APPLICABLE. | `content_comparisons` |
| Ecommerce | Product listing → detail → size/colour/variant → quantity → add to cart → cart contents → update quantity → checkout navigation → remove. Checkout is followed only by GET navigation with all writes blocked; orders are never placed and payment is never submitted. | test results |
| Forms (additions) | Accessible labels on every field; duplicate-submission protection measured by double-clicking submit with all requests intercepted. | test results |
| Figma | Provider architecture (`FigmaProvider`, not-configured fallback, REST placeholder). Without design data every comparison is NOT EXECUTED. | `figma_comparisons` (future) |

The run page has a tab per detail table (UI & Responsive, Typography, Accessibility, SEO, Performance, Content, Console, Network) with page, browser, viewport and status filters.

### Expectation hierarchy

Every test case records where its expected result comes from, highest authority first: explicit requirements, acceptance criteria, Figma, reference document, standard browser behaviour, detected functionality, AI exploratory expectation. A **FAIL is a verified failure** backed by evidence; a **WARNING is a potential issue that needs review**. An AI-derived expectation can never produce a FAIL (the engine downgrades it to WARNING).

### Result integrity

Statuses are exactly `PASS`, `FAIL`, `WARNING`, `NOT EXECUTED` and `NOT APPLICABLE`. Before storing a result, the engine enforces these rules (see `lib/testing/outcome.ts`):

- **PASS** requires at least one concrete verification. Examples: `aria-selected changed to true`, `HTTP 200 from …`, `browser download completed: 24 bytes`. A click alone is never enough; a PASS without a verification is downgraded to WARNING.
- **FAIL** requires captured evidence (HTTP response, DOM state, screenshot or logs); otherwise it is downgraded to WARNING. Links are only marked FAIL for 404 or 410, a 5xx error reproduced on retry, DNS failure or a redirect loop. Bot protection (401, 403, 429, 999), timeouts and unusual responses are marked WARNING.
- **WARNING** means a person should review it; **NOT EXECUTED** means the check could not run (with a reason); **NOT APPLICABLE** means the feature does not exist on the page.
- The database itself rejects PASS, FAIL or WARNING without an execution timestamp.

### Bugs (Phase 4, `lib/bugs`)

- A bug is created **only from a FAIL result** (a verified failure with evidence). WARNING, NOT EXECUTED and NOT APPLICABLE never create bugs. The engine runs automatically at the end of every test run; for older runs use **Create bugs from failures** on the run page (idempotent).
- Each bug has a project-scoped ID (`BUG-0001`), page, section, test type, scenario type, device, browser, deterministic severity (with the rule's reason) and priority (P0–P3, raised one level on the homepage, cart, checkout and login pages), expected and actual results, steps to reproduce, element, selector, technical details (verifications, console errors, failed requests) and its evidence: viewport, full-page and element screenshots, HTTP/console/network logs, URL, browser, viewport and timestamp.
- **Duplicates** are detected deterministically: the fingerprint is the normalised page URL plus the test case's stable identity (module, check and element). A recurrence in a later run, browser or viewport adds an occurrence to the same bug. Bugs on the same page with the same test type and element are shown as *related* and are never merged. The `DuplicateDetector` interface is ready for a future AI-assisted detector, which may only suggest.
- Bugs are **never resolved automatically**. A later run that passes, or in which a failure is not observed, leaves the bug open. When a RESOLVED or CLOSED bug fails again, the engine reopens it and records this in the bug's history.

### Reports (Phase 4, `lib/reports`)

**Generate report** on a finished run queues a `report.generate` job; the worker builds four files under `data/storage/reports/<id>/` and the **Reports** page (Report Center) offers View, Download PDF, Download HTML, Download Testing Excel and Download Bug Excel.

- `QA_Testing_Report_<website>_<date>.xlsx`: Summary, Page Wise Testing, UI Testing, Functional Testing, Positive Negative Edge Testing, Links, Performance, Accessibility, SEO, Console & Network, Content Comparison, Figma Comparison and Typography sheets, with header styling, filters, frozen headers, wrapped text and status colours.
- `QA_Bug_Report_<website>_<date>.xlsx`: Bug Report, Bug Summary and Testing Type Bug Count sheets.
- PDF: rendered locally by headless Chromium with a cover page, scope, configuration, summary, statistics, page results, test cases, bugs, UI, typography, performance, accessibility, SEO, content comparison and screenshots.
- HTML: a single self-contained file that works offline, with charts, a section index, searchable and filterable tables, and embedded screenshots. When opened from the app, it is served with a sandboxing Content-Security-Policy.

Every report carries "QA Pilot AI" and "© Pawan Rewatkar. All Rights Reserved.". Charts and tables are drawn only from recorded results, and empty sections say so. Secrets are removed from report and bug text: credentials in URLs, sensitive query parameters, bearer tokens, JWTs, password and API-key values, and card numbers. Email addresses are masked. Password, payment and one-time-code fields, and fields marked `data-sensitive`, are masked in screenshots at capture time.

### History and regression (Phase 4, `lib/regression`)

The **History** page lists every run with its pages, test totals, status counts, bugs (with new bugs and severity split), average performance score and LCP, and accessibility and SEO failure counts. It also keeps the activity log.

**Compare** (on a run or in History) matches results by stable identity: page, test case key, browser and viewport. Each result is labelled New, Resolved, Still Failing, Changed, Unchanged or Unable to Compare.

- **Resolved** requires the same check to have executed and passed in the newer run.
- A check that was not executed, or that only changed text or screenshots, is never reported as resolved.

The comparison also lists new bugs, previously existing bugs, and bugs not observed in this run (which stay open). It shows performance changes beyond lab-noise thresholds, and accessibility and UI findings that appeared or disappeared. Findings are compared only where the check ran in both runs.

## Safety

- **Form submissions are intercepted by default.** Validation tests run in a guarded browser mode that aborts every non-GET request and every page navigation, so nothing reaches the website. The integration tests assert that the fixture server receives zero writes.
- **Real submissions** (contact or newsletter forms, and one invalid-login attempt) happen only when **Allow real form submissions** is enabled for that run. Even then:
  - each form is submitted at most once, ever, per project (recorded in a `form_submissions` ledger);
  - forms with a CAPTCHA and payment forms are never submitted;
  - email fields use only the project's Test Email. Without one, the case is `NOT EXECUTED`; no other address is ever invented.
- **Never performed:** purchases, payments, account creation, brute force or credential stuffing, exploit payloads, real duplicate submissions, or clicks on destructive controls. (Duplicate-submission protection is measured with every request intercepted.)
- **Ecommerce:** items are added to a cart in an isolated browser session only. Checkout is reached by GET navigation with all writes blocked; payment fields are never filled and payment is never submitted.
- The crawler only visits the project's own site, honours robots.txt by default, waits between requests, and never visits state-changing URLs.
- Screenshot evidence is served only for storage keys recorded by a run, so arbitrary files cannot be read through the artifact route.

## Database

SQLite in `data/qa-pilot.db` (`DATABASE_PATH`). It is created and migrated automatically; `npm run db:migrate` does the same by hand. Migrations never delete data.

Migration 4 (Phase 4) rebuilds `bugs` and `bug_evidence` (copying existing rows) with the bug fields, fingerprint, occurrence tracking and screenshot kinds. It adds `bug_occurrences`, `bug_status_history` and `report_bundles`, adds `kind`/`label` to `screenshots`, and adds `bundle_id`/`kind` to `reports`.

Migration 3 (Phase 3) adds measurement columns to the Phase 1 per-check tables (`ui_results`, `typography_results`, `accessibility_results`, `seo_results`, `content_comparisons`, `console_results`, `network_results`), `test_cases.expectation_source`, and rebuilds `performance_results` (copying existing rows) so local Lighthouse results are labelled distinctly from browser-timing and future PageSpeed results.

Migration 2 (Phase 2) is additive and adds:

- the `crawl_runs` table;
- new columns on `pages`: name, description, type, confidence, crawl status, discovery sources, selection, final URL, error;
- new columns on `test_runs`: progress, current page and test, cancellation, options;
- new columns on `test_cases`: code, section, scenario type, feature, element, test data, page URL;
- new columns on `test_results`: page, URL, evidence, verifications;
- the `form_submissions` and `worker_heartbeats` tables.

WAL mode lets the web app and the worker share the database. To reset, stop both processes and delete `data/` contents except `README.md` and `.gitkeep`.

## Architecture

```
Next.js web app ──(server action)──► jobs table (SQLite) ◄──(claim)── Worker process
     ▲  polls /api/test-runs/[id], /api/crawl-runs/[id]                │ Playwright: Chromium / Firefox / WebKit
     └──────────────── progress, results, evidence ◄──────────────────┘ writes via SqliteEngineStore
```

- **Job queue.** Jobs are claimed atomically with `UPDATE … RETURNING`. The worker sends a heartbeat every 5 s. When it starts, it marks jobs owned by dead workers as FAILED, so a run never stays RUNNING forever.
- **Cancellation.** A cancel request sets a flag that the worker checks between steps. A run that is still queued is cancelled immediately.
- **Browser scripts.** Code that runs in the page is plain JavaScript strings (`lib/testing/browser-scripts.ts`, `lib/crawler/extract.ts`), because tsx/esbuild helpers do not exist inside the page.
- **Bundle boundaries.** Playwright and the engine are imported only by the worker; client components import plain constants.

```
app/                 Pages, server actions, API routes (crawl/test-run progress, artifacts, workers)
components/          UI: crawl/, test-runs/, test-config/, projects/, shared/, ui/
lib/crawler/         Normalization, robots, sitemap, extraction, page types, WebsiteCrawler, Playwright loader
lib/playwright/      Browser launch/contexts, PageSession (console/network/downloads/guard), error classification
lib/testing/         Outcome rules, link checker, module registry, modules/*
lib/forms/           Form analysis (in-browser) and safe synthetic test data
lib/net/http.ts      HTTP client with manual redirects and error classification
lib/database/local/  LocalDatabaseProvider, engine repositories, SqliteEngineStore (worker writes)
worker/              Entry point, job queue, crawl job, run executor
tests/               Unit tests, integration tests, fixtures/site-server.ts (local website with known defects)
```

## Deployment (GitHub → Vercel)

- The web app is Vercel-compatible. The **worker must run on a long-lived host** (VM, container, Railway/Fly) with Playwright browsers installed, not in serverless functions.
- SQLite and local storage are not persistent on Vercel. A shared deployment needs a hosted database (the planned Supabase provider) and cloud storage that both processes can reach.
- Vercel limits request bodies to 4.5 MB (relevant for reference-document uploads).
- **There is no authentication yet.** Add it before exposing the app to anyone else (see the notes in the server action files).

## Limitations (end of Phase 4)

- Figma comparison and semantic (AI) content comparison are NOT EXECUTED: no Figma provider or AI provider is implemented.
- Automated accessibility checks cover only part of WCAG; manual review is still needed.
- Lighthouse scores are lab measurements on this machine and vary between runs. Lighthouse adds roughly 10 seconds per page and form factor, and always uses Chromium.
- UI checks for grids, alignment and spacing only consider repeated card-like items, and report WARNING rather than FAIL because layouts can be intentional. Responsive testing resizes the window in the run's first browser, so mobile user agent and touch emulation apply only when the run itself uses a mobile viewport.
- PDF headings are inferred from text layout (PDFs carry no heading structure); DOCX and Markdown headings are exact. Scanned (image-only) PDFs have no extractable text.
- There is no UI for storing test credentials, so positive login and logout tests are `NOT EXECUTED`.
- Interactive checks use heuristics for custom (non-ARIA) components. When the intent of a component cannot be confirmed from its markup, the engine records `WARNING` rather than `FAIL`.
- Each module tests up to 5 items of a kind per page, 3 forms per page, and a configurable number of links per page (default 100), to keep runs bounded. Real sites with many modules and browsers can take several minutes per page.
- Reports embed at most 60 screenshots (failures first). The PDF caps test cases at 1,500 rows and detail tables at 400 rows, and says so; the Excel and HTML reports include up to 5,000 rows per detail table.
- PDF generation needs the Playwright Chromium browser on the worker machine. Without it, the PDF is marked FAILED and the other three files are still produced.
- Single worker, sequential execution. The crawler always uses Chromium; tests use whichever browsers you select.
