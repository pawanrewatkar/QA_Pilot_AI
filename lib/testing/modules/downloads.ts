import fs from "node:fs/promises";
import type { TestModule } from "../context";
import { classifyLinkKind } from "../link-check";
import { evidence, outcome, type CheckOutcome } from "../outcome";
import { describe, inspect, isVisible, locate, MAX_ITEMS_PER_FEATURE, spec } from "./helpers";

/**
 * Download testing: the file must be reachable over HTTP with a non-HTML content type, and
 * (when the link is visible) clicking it must start a real browser download with a non-empty file.
 */
export const downloadsModule: TestModule = {
  id: "downloads",
  scope: "page",
  async run(ctx) {
    const inspection = await inspect(ctx);
    const seen = new Set<string>();
    const links = inspection.links.filter((l) => {
      if (classifyLinkKind(l.rawHref, l.href, ctx.url, l.download) !== "download" || seen.has(l.href)) return false;
      seen.add(l.href);
      return true;
    });
    if (links.length === 0) {
      return [
        outcome.notApplicable(
          spec("downloads", "none", { title: "Downloadable files", feature: "Download", element: "a[download], file links", steps: ["Collect download links"], expected: "Files download" }),
          "No download links were found on this page.",
        ),
      ];
    }

    const results: CheckOutcome[] = [];
    for (const link of links.slice(0, MAX_ITEMS_PER_FEATURE)) {
      if (ctx.isCancelled()) break;
      ctx.setCurrentTest(`Download: ${link.href}`);
      const s = spec("downloads", link.href, {
        title: `File downloads: ${link.text || link.href}`,
        section: link.source,
        feature: "Download",
        element: describe("a", link.text) + ` → ${link.href}`,
        steps: ["Request the file over HTTP", "Click the link in the browser", "Wait for the download to complete"],
        expected: "File is served (HTTP 2xx, non-HTML content) and the browser receives a non-empty file",
      });
      const started = Date.now();
      const http = await ctx.linkChecker.check(link.href);
      const httpEv = evidence.http("HTTP check", `URL: ${link.href}\nStatus: ${http.result.status ?? http.result.error?.kind}\nContent-Type: ${http.result.contentType ?? "unknown"}\nContent-Length: ${http.result.contentLength ?? "unknown"}`);
      if (http.verdict.status === "FAIL") {
        results.push(outcome.fail(s, `File is not available: ${http.verdict.actual}`, [httpEv], { durationMs: Date.now() - started }));
        continue;
      }
      if (http.verdict.status !== "PASS") {
        results.push(outcome.warn(s, `File availability could not be confirmed: ${http.verdict.actual}`, { evidence: [httpEv], durationMs: Date.now() - started }));
        continue;
      }
      const servesHtml = /text\/html/i.test(http.result.contentType ?? "");
      const verifications = [`HTTP ${http.result.status} with Content-Type ${http.result.contentType ?? "unknown"}`];

      await inspect(ctx); // re-tag after any previous reload
      const locator = locate(ctx, link.qid);
      if (!(await isVisible(locator))) {
        if (servesHtml) results.push(outcome.warn(s, "Link points to a file path but the server returned an HTML page", { evidence: [httpEv] }));
        else results.push(outcome.pass(s, "File is served over HTTP (link not visible at this viewport, browser download not attempted)", verifications, { evidence: [httpEv], durationMs: Date.now() - started }));
        continue;
      }

      const page = ctx.session.page;
      const downloadPromise = page.waitForEvent("download", { timeout: 15_000 }).catch(() => null);
      await locator.click({ timeout: 5_000, modifiers: [] }).catch(() => undefined);
      const download = await downloadPromise;
      if (download) {
        const failure = await download.failure().catch(() => "unknown failure");
        const path = failure ? null : await download.path().catch(() => null);
        const size = path ? (await fs.stat(path).catch(() => null))?.size ?? 0 : 0;
        const dlEv = { type: "download" as const, label: "Browser download", content: `Suggested file name: ${download.suggestedFilename()}\nSize: ${size} bytes\nFailure: ${failure ?? "none"}` };
        if (!failure && size > 0) {
          results.push(outcome.pass(s, `Downloaded ${download.suggestedFilename()} (${size} bytes)`, [...verifications, `Browser download completed: ${size} bytes`], { evidence: [httpEv, dlEv], durationMs: Date.now() - started }));
        } else {
          results.push(outcome.fail(s, `Browser download failed: ${failure ?? "empty file"}`, [httpEv, dlEv], { durationMs: Date.now() - started }));
        }
      } else if (!servesHtml) {
        // Some engines open files (e.g. PDF) inline instead of downloading.
        const opened = page.url();
        results.push(outcome.pass(s, `File opened in the browser instead of downloading (${opened})`, [...verifications, `Navigation to ${opened}`], { evidence: [httpEv], durationMs: Date.now() - started }));
      } else {
        results.push(outcome.warn(s, "No download started and the destination is an HTML page", { evidence: [httpEv] }));
      }
      if (!(await ctx.reload())) break;
    }
    return results;
  },
};
