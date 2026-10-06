import type { BrowserName, PerformanceFormFactor, Viewport } from "@/types";

/**
 * Collects performance measurements. Implementations:
 * - LocalLighthouseProvider (active): Lighthouse run locally against Playwright's Chromium. No API key.
 * - LocalBrowserTimingProvider (fallback): Navigation/Paint Timing and PerformanceObserver data from the
 *   test browser itself, used only if Lighthouse cannot run. It has no category scores.
 * - GooglePageSpeedProvider (future): PageSpeed Insights API. Not implemented; never used for local results.
 *
 * Every metric is measured; anything that was not measured is null, never estimated.
 */
export type PerformanceSource = "LOCAL_LIGHTHOUSE" | "LOCAL_BROWSER" | "PAGESPEED";

export const PERFORMANCE_SOURCE_LABELS: Record<PerformanceSource, string> = {
  LOCAL_LIGHTHOUSE: "Local Lighthouse result",
  LOCAL_BROWSER: "Local browser timing (fallback)",
  PAGESPEED: "Google PageSpeed result",
};

export interface PerformanceProvider {
  readonly id: string;
  readonly source: PerformanceSource;
  measure(request: PerformanceRequest, signal?: AbortSignal): Promise<PerformanceMeasurement>;
}

export interface PerformanceRequest {
  url: string;
  browser: BrowserName;
  viewport: Viewport;
  formFactor: PerformanceFormFactor;
}

export interface PerformanceMeasurement {
  url: string;
  source: PerformanceSource;
  formFactor: PerformanceFormFactor;
  toolVersion: string | null;
  measuredAt: string;
  /** Lighthouse category scores in [0, 1]; null when the source does not produce them. */
  scores: { performance: number | null; accessibility: number | null; bestPractices: number | null; seo: number | null };
  ttfbMs: number | null;
  fcpMs: number | null;
  lcpMs: number | null;
  cls: number | null;
  tbtMs: number | null;
  speedIndexMs: number | null;
  /** Interaction to Next Paint needs real interactions; a navigation lab run cannot measure it. */
  inpMs: number | null;
  domContentLoadedMs: number | null;
  loadMs: number | null;
  totalBytes: number | null;
  requestCount: number | null;
  /** Problems reported by the tool (e.g. Lighthouse runtime warnings), verbatim. */
  warnings: string[];
}

export class PerformanceProviderUnavailableError extends Error {
  constructor(provider: string, reason: string) {
    super(`${provider} is not available: ${reason}`);
    this.name = "PerformanceProviderUnavailableError";
  }
}

/** Future Google PageSpeed Insights provider. Requires PAGESPEED_API_KEY and is not implemented yet. */
export class GooglePageSpeedProvider implements PerformanceProvider {
  readonly id = "google-pagespeed";
  readonly source = "PAGESPEED" as const;
  async measure(): Promise<PerformanceMeasurement> {
    throw new PerformanceProviderUnavailableError("Google PageSpeed", "not implemented in this version; local Lighthouse is used instead");
  }
}
