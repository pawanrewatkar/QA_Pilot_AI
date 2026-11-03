# Browser-test worker on GitHub Actions

Status: **prepared, not enabled.** The workflow (`.github/workflows/qa-worker.yml`) exists but has never run: no
secrets, environments or repository settings have been created. Local development does not use it (`npm run worker`
works exactly as before).

## What it does

The web app queues work in the `jobs` table (crawls, test runs, report generation). A workflow run starts the same
worker as local development (`npm run worker -- --once`) on a GitHub-hosted runner:

1. Refuses to start unless the database and storage are hosted (`DATABASE_PROVIDER=supabase`,
   `STORAGE_PROVIDER=supabase`): the runner's disk is discarded afterwards, so local SQLite or local files would lose
   every result.
2. Registers a heartbeat (every 5 s) and marks jobs of workers that stopped heart-beating (over 30 s) as FAILED.
3. Claims queued jobs one at a time (PostgreSQL `FOR UPDATE SKIP LOCKED`: two workers never take the same job), runs
   them in Chromium, Firefox and WebKit, and writes results to the database and screenshots/reports to the private
   bucket.
4. Exits when the queue is empty, or stops claiming new jobs after `max_runtime_minutes` (default 45) and exits once
   the job in progress finishes.

## Trigger

**Manual only** (Actions → QA worker → Run workflow). Jobs queued in the app wait until a run is started. Options for
later, each needing its own approval:

- **Schedule** (`on: schedule`, at most every 5 minutes, often delayed, only from the default branch; GitHub disables
  schedules in repositories without activity for 60 days). Simple, but most runs find an empty queue (minutes cost).
- **Dispatch from the app** (`workflow_dispatch` through the GitHub API when a job is queued). Immediate, but the web
  app needs a server-side GitHub token limited to this repository with `Actions: write` only, stored as a Vercel
  secret.

While no worker is running, the app's worker banner shows the worker as offline; that is expected with on-demand runs.

## Required GitHub settings (not done)

| Setting | Value |
|---|---|
| Settings → Environments → **`qa-worker`** | Create it. Deployment branches: `main` only. Optional: required reviewers, so each run is approved |
| Environment secret **`DATABASE_URL`** | Supabase **session-mode pooler** connection string (Dashboard → Connect → Session pooler: host `aws-0-<region>.pooler.supabase.com`, port 5432, user `postgres.<project-ref>`), password percent-encoded, **no** `sslmode`. Not the direct `db.<ref>.supabase.co` string: it is IPv6-only and GitHub-hosted runners have no IPv6 |
| Environment variable **`DATABASE_SSL_CA`** | Supabase's CA certificate, PEM text (Dashboard → Database settings → SSL Configuration). Public, so a variable. The worker verifies the database server against it and refuses to connect without verified TLS |
| Environment secret **`SUPABASE_SECRET_KEY`** | Supabase secret key (`sb_secret_…`), used server-side for Storage only |
| Environment variable **`SUPABASE_URL`** | `https://<project-ref>.supabase.co` (not secret) |
| Environment variable `STORAGE_BUCKET` | Optional; defaults to `qa-pilot-artifacts` |
| Settings → Actions → General → Actions permissions | Recommended: allow only actions created by GitHub (the workflow uses only `actions/checkout`, `actions/setup-node`, `actions/cache`, pinned to commits) |
| Settings → Actions → General → Workflow permissions | Read repository contents; do **not** allow Actions to create or approve pull requests |
| Fork pull request workflows | Leave approval required (the workflow has no pull request trigger and forks never receive environment secrets) |

Secrets go only into the `qa-worker` environment, never repository-wide, and never into Vercel's public
(`NEXT_PUBLIC_`) variables.

## Security properties of the workflow

- `permissions: contents: read`; checkout keeps no credentials (`persist-credentials: false`).
- Actions are pinned to full commit hashes.
- Secrets reach only the **Run worker** step, as environment variables; no step interpolates secrets, inputs or event
  data into a script (no script injection). `npm ci` and browser installation run without secrets.
- GitHub masks secret values in logs; the worker never prints connection strings or keys.
- The database connection always uses TLS with a verified certificate (`DATABASE_SSL_CA`); it is never downgraded.
- Browsers opened on tested websites (Chromium, Firefox, WebKit, Lighthouse's Chrome) get an allow-listed environment
  (`lib/playwright/browser-env.ts`): no `DATABASE_URL`, `SUPABASE_SECRET_KEY` or other worker settings.
- **The repository is public, so workflow logs are public.** On GitHub Actions the worker hides web addresses in its
  log lines (`<url>`), on top of the usual redaction; run names, job ids, counts and error kinds still appear. Full
  details stay in the database, visible only to the owner in the app. Making the repository private removes this
  exposure entirely.
- No results are uploaded as GitHub artifacts or caches; screenshots and reports go only to the private bucket. The
  browser cache contains Playwright browsers only.

## Reliability

| Concern | Behaviour |
|---|---|
| Job ids and status | Each job is claimed once (status RUNNING, attempt counted, locked by the worker id `host:pid`), then COMPLETED or FAILED with its error |
| Runtime | Stops claiming after `max_runtime_minutes` (45); hard job timeout 90 minutes; one workflow run at a time (`concurrency: qa-worker`) |
| Cancellation by the user | Cancelling a pending run cancels its job; a running run is flagged and the worker stops at its next check (about once a second) |
| Cancelling the workflow run | The worker receives a stop signal, finishes the current step and records what it has; if it is killed, the next worker marks the job FAILED (abandoned-work recovery) |
| Retries | Crawl, test-run and report jobs are not retried automatically (`max_attempts = 1`); a failed job records its error and the run shows it |
| Failure reporting | Job errors, run status and the activity log in the app; the workflow run itself fails only when the worker cannot start (e.g. database unreachable, settings invalid) |
| Cleanup | Browsers are closed per run; the runner is discarded after each workflow run |

## Artifacts

With `STORAGE_PROVIDER=supabase`, everything the worker stores goes to the private bucket under the same keys as
locally: screenshots `runs/<run>/<page>/<browser>-<viewport>/…png`, external result workbooks `runs/<run>/external/…`,
reports `reports/<bundle>/…`. The web app serves them only through its ownership-checked routes.

## Before the first run

1. Hosted schema applied (`scripts/pg-migrate.ts --apply`, approval pending) and the read-only bucket check passed
   (`scripts/storage-check.ts`).
2. The web app uses the **same** database and bucket (`DATABASE_PROVIDER=supabase`, `STORAGE_PROVIDER=supabase`);
   otherwise it never sees the worker's results.
3. First runs against a **non-production** Supabase project, testing a site you own (never a customer's site), with a
   single small run queued from the app. Check the run, screenshots, bug and report in the app, then the workflow log.

## Verification so far (local only)

`tests/integration/worker-lifecycle.test.ts` drives the same worker loop (`worker/loop.ts`) on PostgreSQL (PGlite) with
the Supabase Storage provider against a local fake of the Storage API, testing a local fixture site in Chromium:
queue → claim → run → results, bugs and screenshots → report bundle (HTML, PDF, Excel) → owner-only access; cancel while
queued and while running; runtime limit; a failing job; recovery after a killed worker; no URLs or keys in the log.
It does **not** prove the hosted pieces: a real workflow run, Supabase connectivity, the hosted schema or the bucket.

## Local development

Unchanged: `npm run worker` (or `npm run dev:all`) with the defaults (SQLite and local files). The GitHub Actions
checks apply only when `GITHUB_ACTIONS=true`, which GitHub sets on its runners.
