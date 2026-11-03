-- QA Pilot AI: rollback for PostgreSQL migration 0001 (initial_schema). PROPOSED — review before use; never run automatically.
--
-- Removes ONLY the objects migration 0001 and its runner create in the public schema: the 34 app tables and
-- qa_pilot_migrations. Dropping a table also drops its indexes (including the rowid unique indexes), constraints,
-- identity sequences (rowid), row level security settings and the grants attached to it. Nothing else is touched:
-- no schema, role, extension, function, trigger, event trigger, publication or default privilege.
--
-- Safety:
-- - One transaction: either every table is dropped or none is.
-- - RESTRICT (the default, written explicitly): if anything else depends on these tables (a view, a foreign key from
--   another table), the DROP fails and the whole rollback is undone. If a table was added to a publication (e.g.
--   Supabase Realtime), PostgreSQL removes just that table from the publication; the publication itself stays.
-- - Data guard: stops if any of these tables contains rows. Delete that block only if dropping the data is intended.
-- - IF EXISTS: safe after a partly failed migration (where only qa_pilot_migrations exists) and safe to re-run.
-- - Run as the same role that applied the migration (the table owner: postgres through the session pooler).

BEGIN;
SET LOCAL lock_timeout = '5s';

-- Data guard: refuse to drop tables that hold rows.
DO $$
DECLARE
  t text;
  n bigint;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'external_test_observations',
    'external_test_executions',
    'reports',
    'bug_status_history',
    'bug_occurrences',
    'bug_evidence',
    'performance_results',
    'worker_heartbeats',
    'form_submissions',
    'figma_comparisons',
    'content_comparisons',
    'typography_results',
    'ui_results',
    'network_results',
    'console_results',
    'link_results',
    'seo_results',
    'accessibility_results',
    'jobs',
    'activity_log',
    'test_credentials',
    'external_test_cases',
    'report_bundles',
    'bugs',
    'screenshots',
    'documents',
    'test_results',
    'test_cases',
    'test_run_pages',
    'pages',
    'test_runs',
    'crawl_runs',
    'test_configurations',
    'projects',
    'qa_pilot_migrations'
  ] LOOP
    IF to_regclass(format('public.%I', t)) IS NOT NULL THEN
      EXECUTE format('SELECT count(*) FROM public.%I', t) INTO n;
      IF n > 0 AND t <> 'qa_pilot_migrations' THEN
        RAISE EXCEPTION 'public.% contains % row(s); rollback stopped (nothing was dropped)', t, n;
      END IF;
    END IF;
  END LOOP;
END $$;

-- App tables, children before parents (dependency-safe).
DROP TABLE IF EXISTS public.external_test_observations RESTRICT;
DROP TABLE IF EXISTS public.external_test_executions RESTRICT;
DROP TABLE IF EXISTS public.reports RESTRICT;
DROP TABLE IF EXISTS public.bug_status_history RESTRICT;
DROP TABLE IF EXISTS public.bug_occurrences RESTRICT;
DROP TABLE IF EXISTS public.bug_evidence RESTRICT;
DROP TABLE IF EXISTS public.performance_results RESTRICT;
DROP TABLE IF EXISTS public.worker_heartbeats RESTRICT;
DROP TABLE IF EXISTS public.form_submissions RESTRICT;
DROP TABLE IF EXISTS public.figma_comparisons RESTRICT;
DROP TABLE IF EXISTS public.content_comparisons RESTRICT;
DROP TABLE IF EXISTS public.typography_results RESTRICT;
DROP TABLE IF EXISTS public.ui_results RESTRICT;
DROP TABLE IF EXISTS public.network_results RESTRICT;
DROP TABLE IF EXISTS public.console_results RESTRICT;
DROP TABLE IF EXISTS public.link_results RESTRICT;
DROP TABLE IF EXISTS public.seo_results RESTRICT;
DROP TABLE IF EXISTS public.accessibility_results RESTRICT;
DROP TABLE IF EXISTS public.jobs RESTRICT;
DROP TABLE IF EXISTS public.activity_log RESTRICT;
DROP TABLE IF EXISTS public.test_credentials RESTRICT;
DROP TABLE IF EXISTS public.external_test_cases RESTRICT;
DROP TABLE IF EXISTS public.report_bundles RESTRICT;
DROP TABLE IF EXISTS public."bugs" RESTRICT;
DROP TABLE IF EXISTS public.screenshots RESTRICT;
DROP TABLE IF EXISTS public.documents RESTRICT;
DROP TABLE IF EXISTS public.test_results RESTRICT;
DROP TABLE IF EXISTS public.test_cases RESTRICT;
DROP TABLE IF EXISTS public.test_run_pages RESTRICT;
DROP TABLE IF EXISTS public.pages RESTRICT;
DROP TABLE IF EXISTS public.test_runs RESTRICT;
DROP TABLE IF EXISTS public.crawl_runs RESTRICT;
DROP TABLE IF EXISTS public.test_configurations RESTRICT;
DROP TABLE IF EXISTS public.projects RESTRICT;

-- Migration tracking table (created by the migration runner).
DROP TABLE IF EXISTS public.qa_pilot_migrations RESTRICT;

COMMIT;
