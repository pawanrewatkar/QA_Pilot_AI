# worker/crawler

**Status:** implemented (Phase 2).

`crawl-job.ts` runs a `crawl_runs` record with `WebsiteCrawler` (`lib/crawler`) and persists pages and progress through `SqliteEngineStore`.
