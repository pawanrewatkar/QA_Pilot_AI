import { chromium } from "playwright";
import type { PerformanceFormFactor } from "@/types";
import { PerformanceProviderUnavailableError, type PerformanceMeasurement, type PerformanceProvider, type PerformanceRequest } from "./provider";

type Audit = { numericValue?: number; score?: number | null };
interface LighthouseResultLike {
  lighthouseVersion: string;
  runtimeError?: { code: string; message: string };
  runWarnings?: string[];
  categories: Record<string, { score: number | null }>;
  audits: Record<string, Audit | undefined>;
}

/** Maps a Lighthouse result (LHR) to a measurement. Missing audits stay null. */
export function measurementFromLhr(lhr: LighthouseResultLike, url: string, formFactor: PerformanceFormFactor): PerformanceMeasurement {
  const num = (id: string) => {
    const v = lhr.audits[id]?.numericValue;
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  const score = (id: string) => {
    const v = lhr.categories[id]?.score;
    return typeof v === "number" ? v : null;
  };
  const requests = lhr.audits["network-requests"] as unknown as { details?: { items?: unknown[] } } | undefined;
  return {
    url,
    source: "LOCAL_LIGHTHOUSE",
    formFactor,
    toolVersion: `Lighthouse ${lhr.lighthouseVersion}`,
    measuredAt: new Date().toISOString(),
    scores: { performance: score("performance"), accessibility: score("accessibility"), bestPractices: score("best-practices"), seo: score("seo") },
    ttfbMs: num("server-response-time"),
    fcpMs: num("first-contentful-paint"),
    lcpMs: num("largest-contentful-paint"),
    cls: num("cumulative-layout-shift"),
    tbtMs: num("total-blocking-time"),
    speedIndexMs: num("speed-index"),
    inpMs: num("interaction-to-next-paint"),
    domContentLoadedMs: null,
    loadMs: null,
    totalBytes: num("total-byte-weight"),
    requestCount: Array.isArray(requests?.details?.items) ? requests!.details!.items!.length : null,
    warnings: lhr.runWarnings ?? [],
  };
}

/**
 * Runs Lighthouse locally against Playwright's bundled Chromium (no Google API, no key).
 * Each measurement uses a fresh, isolated Chrome instance with throttling per the form factor.
 */
export class LocalLighthouseProvider implements PerformanceProvider {
  readonly id = "local-lighthouse";
  readonly source = "LOCAL_LIGHTHOUSE" as const;

  async measure(request: PerformanceRequest): Promise<PerformanceMeasurement> {
    let chromePath: string;
    try {
      chromePath = chromium.executablePath();
    } catch (error) {
      throw new PerformanceProviderUnavailableError("Local Lighthouse", `Chromium not found (${error instanceof Error ? error.message : String(error)})`);
    }
    const chromeLauncher = await import("chrome-launcher");
    const { default: lighthouse } = await import("lighthouse");
    const chrome = await chromeLauncher.launch({ chromePath, chromeFlags: ["--headless=new", "--no-sandbox", "--disable-gpu"] });
    try {
      const config =
        request.formFactor === "desktop"
          ? ((await import("lighthouse/core/config/desktop-config.js")) as { default: object }).default
          : undefined;
      const result = await lighthouse(
        request.url,
        { port: chrome.port, output: "json", logLevel: "error", onlyCategories: ["performance", "accessibility", "best-practices", "seo"] },
        config as never,
      );
      const lhr = result?.lhr as unknown as LighthouseResultLike | undefined;
      if (!lhr) throw new PerformanceProviderUnavailableError("Local Lighthouse", "no result was produced");
      if (lhr.runtimeError) throw new PerformanceProviderUnavailableError("Local Lighthouse", `${lhr.runtimeError.code}: ${lhr.runtimeError.message}`);
      return measurementFromLhr(lhr, request.url, request.formFactor);
    } finally {
      chrome.kill();
    }
  }
}
