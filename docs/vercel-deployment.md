# Deploying the web app on Vercel

Status: **prepared, not deployed.** No Vercel project settings, environment variables or domains have been changed.
The Vercel project `qa-pilot-ai` exists but is not connected to the repository and has no production domain.

## Architecture on Vercel

| Part | Where it runs |
|---|---|
| Pages, server actions, API routes (short requests only) | Vercel functions (Node.js runtime) |
| Data | Supabase PostgreSQL (`DATABASE_PROVIDER=supabase`) |
| Screenshots, uploaded documents, reports | Private Supabase Storage bucket, read only through the app's ownership-checked routes |
| Crawls, browser test runs, report generation (PDF via Chromium) | The worker on GitHub Actions (`docs/github-actions-worker.md`); the app only queues jobs in the database |
| Sign-in | Supabase Auth (`AUTH_PROVIDER=supabase`), server-side only |

No browser automation runs in a Vercel function: the app never imports the crawler, test engine, PDF renderer or
worker; report generation is queued (`reports.requestBundle`). Playwright and `better-sqlite3` are server external
packages and are never bundled for the browser.

## Project settings

| Setting | Value |
|---|---|
| Framework preset | Next.js (auto-detected; no `vercel.json` needed) |
| Root directory | repository root |
| Install command | default (`npm install`; `package-lock.json` is committed) |
| Build command | default (`next build`) |
| Output directory | default (`.next`) |
| Node.js version | 24.x (`engines.node` is `>=22.19.0`; 24 matches the worker workflow) |
| Function region | `hnd1` (Tokyo), next to the Supabase project in `ap-northeast-1`; every request makes several database round trips |
| Production branch | `main` |
| Preview deployments | Protected (Vercel Authentication), and **without** the production variables below; see "Preview deployments" |

## Environment variables (Production scope)

Values are never stored in the repository. Secrets: mark **Sensitive**.

| Name | Value | Exposure |
|---|---|---|
| `AUTH_PROVIDER` | `supabase` | server |
| `NEXT_PUBLIC_SUPABASE_URL` | `https://<project-ref>.supabase.co` | public by design |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | publishable key (`sb_publishable_…`); a secret key is refused | public by design |
| `NEXT_PUBLIC_SITE_URL` | `https://<production-domain>` (origin only, https) | public; used for email links instead of the Host header |
| `AUTH_ALLOWED_EMAILS` | comma-separated emails and/or `@domain` entries | **server only, Sensitive** |
| `DATABASE_PROVIDER` | `supabase` | server |
| `DATABASE_URL` | Supabase **transaction pooler** string: `postgresql://postgres.<project-ref>:<password>@<pooler-host>:6543/postgres`, password percent-encoded | **server only, Sensitive** |
| `DATABASE_POOL_MAX` | `2` (per function instance; the pooler multiplexes) | server |
| `DATABASE_SSL_CA` | Supabase CA certificate (PEM, Dashboard → Database settings → SSL Configuration). **Required:** without it (or `sslmode=verify-full`) the app refuses to connect; put no `sslmode` in `DATABASE_URL` when set | server |
| `STORAGE_PROVIDER` | `supabase` | server |
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` (optional; falls back to `NEXT_PUBLIC_SUPABASE_URL`) | server |
| `SUPABASE_SECRET_KEY` | secret key (`sb_secret_…`), Storage only | **server only, Sensitive** |
| `STORAGE_BUCKET` | `qa-pilot-artifacts` (default) | server |

Do **not** set on Vercel: `QA_PILOT_LOCAL_MODE`, `DATABASE_PATH`, `STORAGE_PATH`, `EXTERNAL_TEST_CASES_DIR`,
`WORKER_MAX_RUNTIME_MINUTES`, or any `NEXT_PUBLIC_` name for a secret.

### What is validated at runtime

- `lib/config/env.ts` validates every value (types, ranges, enums) and fails with the setting's name, never its value.
- `lib/config/deployment.ts`: on Vercel (`VERCEL` set) the app refuses to open the database or storage unless
  `DATABASE_PROVIDER=supabase` and `STORAGE_PROVIDER=supabase`. Nothing silently falls back to SQLite or local files.
- `lib/auth/identity.ts`: local single-user mode is refused on Vercel. With `AUTH_PROVIDER=supabase` and missing or
  invalid public values, every protected page shows `/auth-required` and no data is accessible (fail closed).
- Supabase Storage refuses publishable/anon keys; Auth refuses a secret key.

## Supabase settings (dashboard)

- **Authentication → URL Configuration:**
  - Site URL: `https://<production-domain>`.
  - Redirect URLs: `https://<production-domain>/auth/confirm**` (sign-up and reset links add `?next=…`), plus
    `http://localhost:3000/auth/confirm**` for local testing only.
- **Sign-ups:** disable public sign-ups (or add a "before user created" hook) — the app re-checks
  `AUTH_ALLOWED_EMAILS` on every request either way.
- **Email:** the built-in sender is rate-limited and meant for testing; configure SMTP before inviting real users.
- **Storage:** bucket `qa-pilot-artifacts` must be **private** (checked by `scripts/storage-check.ts`).

## Serverless database connections

One `pg` pool per function instance (cached on `globalThis`), created lazily on the first query, at most
`DATABASE_POOL_MAX` connections, idle connections closed after 30 s, connect timeout 10 s, query timeout 30 s. Use the
transaction pooler (port 6543): the app uses no session features (no session advisory locks, `LISTEN`, `SET` or named
prepared statements). Migrations run separately (`scripts/pg-migrate.ts`, session pooler on port 5432), never from
Vercel.

## Preview deployments

Previews have `VERCEL` set too, so without the hosted settings they show an error rather than using SQLite. Giving
previews the production variables would let preview code read and write production data and send production email
links, so: keep production variables in the Production scope only; for previews either disable them or give them a
separate non-production Supabase project and their own `NEXT_PUBLIC_SITE_URL`.

## Known limits on Vercel (not blocking)

- Request bodies are capped at 4.5 MB: reference documents and workbooks above that are refused by Vercel.
- External Test Case Testing "local path" sources read a folder on the server; on Vercel use upload or Google Drive.
- With on-demand GitHub Actions runs, the worker banner reports the worker as offline between runs; its text still
  suggests `npm run worker` (local instructions).

## Checks run for this document

`next build` with `VERCEL=1` and Supabase settings set to canary placeholder values: build succeeds without
connecting to a database, and no secret value, connection string, allow-list entry or server-only setting name
appears in the client bundles (`.next/static`) or is inlined into server output.
