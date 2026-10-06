import type { Page } from "playwright";
import { runScript } from "@/lib/testing/browser-scripts";
import type { PerformanceFormFactor } from "@/types";
import type { PerformanceMeasurement } from "./provider";

/** Reads Navigation Timing, Paint Timing, LCP and layout-shift entries recorded by the browser. */
const TIMING_SCRIPT = String.raw`async () => {
  const nav = performance.getEntriesByType("navigation")[0];
  const paint = performance.getEntriesByType("paint").find((p) => p.name === "first-contentful-paint");
  const observe = (type) => new Promise((resolve) => {
    try {
      const entries = [];
      const po = new PerformanceObserver((list) => entries.push(...list.getEntries()));
      po.observe({ type, buffered: true });
      setTimeout(() => { po.disconnect(); resolve(entries); }, 300);
    } catch (e) { resolve(null); }
  });
  const lcp = await observe("largest-contentful-paint");
  const shifts = await observe("layout-shift");
  const resources = performance.getEntriesByType("resource");
  return {
    ttfb: nav ? nav.responseStart - nav.startTime : null,
    dcl: nav ? nav.domContentLoadedEventEnd - nav.startTime : null,
    load: nav && nav.loadEventEnd > 0 ? nav.loadEventEnd - nav.startTime : null,
    fcp: paint ? paint.startTime : null,
    lcp: lcp && lcp.length ? lcp[lcp.length - 1].startTime : null,
    cls: shifts ? shifts.filter((s) => !s.hadRecentInput).reduce((sum, s) => sum + s.value, 0) : null,
    bytes: resources.reduce((sum, r) => sum + (r.transferSize || 0), nav ? nav.transferSize || 0 : 0),
    requests: resources.length + (nav ? 1 : 0),
  };
}`;

/**
 * Fallback measurement from the test browser's own page load. Engines differ: LCP and CLS are
 * only reported by Chromium; other engines return null for them, which is recorded as such.
 */
export async function measureBrowserTiming(page: Page, url: string, formFactor: PerformanceFormFactor, browserLabel: string): Promise<PerformanceMeasurement> {
  const t = await runScript<{ ttfb: number | null; dcl: number | null; load: number | null; fcp: number | null; lcp: number | null; cls: number | null; bytes: number; requests: number }>(page, TIMING_SCRIPT);
  const round = (v: number | null) => (v === null || !Number.isFinite(v) ? null : Math.round(v));
  return {
    url,
    source: "LOCAL_BROWSER",
    formFactor,
    toolVersion: `Browser Performance APIs (${browserLabel})`,
    measuredAt: new Date().toISOString(),
    scores: { performance: null, accessibility: null, bestPractices: null, seo: null },
    ttfbMs: round(t.ttfb),
    fcpMs: round(t.fcp),
    lcpMs: round(t.lcp),
    cls: t.cls === null ? null : Math.round(t.cls * 1000) / 1000,
    tbtMs: null,
    speedIndexMs: null,
    inpMs: null,
    domContentLoadedMs: round(t.dcl),
    loadMs: round(t.load),
    totalBytes: t.bytes || null,
    requestCount: t.requests || null,
    warnings: [],
  };
}
