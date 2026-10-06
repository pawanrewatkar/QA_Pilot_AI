import { measureBrowserTiming } from "@/lib/performance/browser-timing";
import { LocalLighthouseProvider } from "@/lib/performance/lighthouse-provider";
import { PERFORMANCE_SOURCE_LABELS, type PerformanceMeasurement, type PerformanceProvider } from "@/lib/performance/provider";
import { formatMetric, METRIC_THRESHOLDS, rateMetric, rateScore, ratingToStatus, type MetricKey } from "@/lib/performance/ratings";
import { resolveRunOptions } from "@/types";
import type { TestModule } from "../context";
import { detail } from "../details";
import { evidence, outcome, type CheckOutcome } from "../outcome";
import { spec } from "./helpers";

const CATEGORIES = [
  ["performance", "Performance"],
  ["accessibility", "Accessibility"],
  ["bestPractices", "Best Practices"],
  ["seo", "SEO"],
] as const;

const METRICS: MetricKey[] = ["lcpMs", "cls", "inpMs", "fcpMs", "tbtMs", "speedIndexMs", "ttfbMs"];

/** Builds outcomes and the performance_results row from one measurement. Pure; no thresholds invented. */
export function performanceOutcomes(m: PerformanceMeasurement, ctx: { browser: string; viewport: string }): CheckOutcome[] {
  const label = PERFORMANCE_SOURCE_LABELS[m.source];
  const ff = m.formFactor === "mobile" ? "mobile" : "desktop";
  const lab = `${label}, ${ff}, ${m.toolVersion ?? "unknown tool"}. Lab measurements vary between runs and machines.`;
  const base = (key: string, title: string, expected: string) =>
    spec("performance", `${m.source}:${ff}:${key}`, {
      title: `${title} (${ff})`,
      section: "Performance",
      feature: label,
      element: m.url,
      steps: [m.source === "LOCAL_LIGHTHOUSE" ? `Run ${m.toolVersion} locally with ${ff} settings` : `Read browser performance entries after loading the page (${m.toolVersion})`, "Record the measured value"],
      expected,
      expectationSource: "BROWSER_STANDARD",
    });
  const results: CheckOutcome[] = [];
  const measuredLine = `Measured by ${lab}`;

  for (const [key, name] of CATEGORIES) {
    const s = base(`score-${key}`, `Lighthouse ${name} score`, "90–100 (Lighthouse 'good' band); 50–89 needs improvement; 0–49 poor");
    const score = m.scores[key];
    if (score === null) {
      results.push(outcome.notExecuted(s, m.source === "LOCAL_LIGHTHOUSE" ? `Lighthouse did not report a ${name} score.` : `${label} does not produce Lighthouse category scores; no score was invented.`));
      continue;
    }
    const pct = Math.round(score * 100);
    const status = ratingToStatus(rateScore(score));
    const actual = `${name} score ${pct}/100. ${lab}`;
    if (status === "PASS") results.push(outcome.pass(s, actual, [`${name} score ${pct}`]));
    else if (status === "WARNING") results.push(outcome.warn(s, actual, { verifications: [`${name} score ${pct}`] }));
    else results.push(outcome.fail(s, actual, [evidence.note("Measurement", `${name} score ${pct}/100\n${measuredLine}`)]));
  }

  for (const key of METRICS) {
    const t = METRIC_THRESHOLDS[key];
    const s = base(key, t.label, `${t.source}: good ≤ ${formatMetric(key, t.good)}, poor > ${formatMetric(key, t.poor)}`);
    const value = m[key];
    if (value === null) {
      results.push(
        outcome.notExecuted(
          s,
          key === "inpMs"
            ? "INP needs real user interactions and is not measured in a navigation lab run; no value was estimated."
            : `${t.label} was not reported by ${label}${m.source === "LOCAL_BROWSER" ? " in this browser engine" : ""}.`,
        ),
      );
      continue;
    }
    const status = ratingToStatus(rateMetric(key, value));
    const actual = `${t.label}: ${formatMetric(key, value)} (${rateMetric(key, value).replace("-", " ")}). ${lab}`;
    if (status === "PASS") results.push(outcome.pass(s, actual, [`${t.label} ${formatMetric(key, value)} ≤ ${formatMetric(key, t.good)}`]));
    else if (status === "WARNING") results.push(outcome.warn(s, actual, { verifications: [`${t.label} ${formatMetric(key, value)}`] }));
    else results.push(outcome.fail(s, actual, [evidence.note("Measurement", `${t.label} ${formatMetric(key, value)} > poor threshold ${formatMetric(key, t.poor)}\n${measuredLine}`)]));
  }

  const overall = m.scores.performance !== null ? ratingToStatus(rateScore(m.scores.performance)) : m.lcpMs !== null ? ratingToStatus(rateMetric("lcpMs", m.lcpMs)) : null;
  results[0].details = [
    detail("performance_results", {
      browser: ctx.browser,
      viewport: ctx.viewport,
      source: m.source,
      ttfb_ms: m.ttfbMs,
      fcp_ms: m.fcpMs,
      lcp_ms: m.lcpMs,
      cls: m.cls,
      tbt_ms: m.tbtMs,
      dom_content_loaded_ms: m.domContentLoadedMs,
      load_ms: m.loadMs,
      total_bytes: m.totalBytes,
      request_count: m.requestCount,
      raw: JSON.stringify({ warnings: m.warnings }),
      measured_at: m.measuredAt,
      performance_score: m.scores.performance,
      accessibility_score: m.scores.accessibility,
      best_practices_score: m.scores.bestPractices,
      seo_score: m.scores.seo,
      speed_index_ms: m.speedIndexMs,
      inp_ms: m.inpMs,
      form_factor: m.formFactor,
      tool_version: m.toolVersion,
      status: overall,
    }),
  ];
  return results;
}

export function createPerformanceModule(provider: PerformanceProvider = new LocalLighthouseProvider()): TestModule {
  return {
    id: "performance",
    scope: "page",
    async run(ctx) {
      const { performance } = resolveRunOptions(ctx.options);
      const results: CheckOutcome[] = [];
      for (const formFactor of performance.formFactors) {
        if (ctx.isCancelled()) break;
        ctx.setCurrentTest(`Performance (${formFactor}): ${provider.id}`);
        let m: PerformanceMeasurement;
        try {
          m = await provider.measure({ url: ctx.url, browser: ctx.browser, viewport: ctx.viewport, formFactor });
        } catch (error) {
          const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
          // Fall back to the test browser's own timing data, clearly labelled, without category scores.
          await ctx.reload();
          try {
            m = await measureBrowserTiming(ctx.session.page, ctx.url, formFactor, `${ctx.browser} ${ctx.viewport.width}×${ctx.viewport.height}`);
            m.warnings.push(`Lighthouse unavailable: ${reason}`);
          } catch (fallbackError) {
            results.push(
              outcome.notExecuted(
                spec("performance", `unavailable:${formFactor}`, { title: `Performance measurement (${formFactor})`, section: "Performance", feature: "Performance", element: ctx.url, steps: [], expected: "Metrics measured" }),
                `Neither local Lighthouse (${reason}) nor browser timing (${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}) could measure this page.`,
              ),
            );
            continue;
          }
        }
        results.push(...performanceOutcomes(m, { browser: ctx.browser, viewport: ctx.viewport.id }));
      }
      return results;
    },
  };
}

export const performanceModule = createPerformanceModule();
