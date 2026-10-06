/**
 * Published thresholds used to rate measured values. Ratings never alter the measurement.
 * - Core Web Vitals (web.dev): LCP, CLS, INP, plus FCP and TTFB guidance.
 * - Lighthouse lab metrics: TBT and Speed Index (mobile scoring curve control points).
 * - Lighthouse category colour bands: 90–100 good, 50–89 needs improvement, 0–49 poor.
 */
export type Rating = "good" | "needs-improvement" | "poor";

export const METRIC_THRESHOLDS = {
  lcpMs: { good: 2500, poor: 4000, label: "Largest Contentful Paint", unit: "ms", source: "Core Web Vitals" },
  cls: { good: 0.1, poor: 0.25, label: "Cumulative Layout Shift", unit: "", source: "Core Web Vitals" },
  inpMs: { good: 200, poor: 500, label: "Interaction to Next Paint", unit: "ms", source: "Core Web Vitals" },
  fcpMs: { good: 1800, poor: 3000, label: "First Contentful Paint", unit: "ms", source: "web.dev" },
  ttfbMs: { good: 800, poor: 1800, label: "Time to First Byte", unit: "ms", source: "web.dev" },
  tbtMs: { good: 200, poor: 600, label: "Total Blocking Time", unit: "ms", source: "Lighthouse" },
  speedIndexMs: { good: 3400, poor: 5800, label: "Speed Index", unit: "ms", source: "Lighthouse" },
} as const;

export type MetricKey = keyof typeof METRIC_THRESHOLDS;

export function rateMetric(key: MetricKey, value: number): Rating {
  const t = METRIC_THRESHOLDS[key];
  return value <= t.good ? "good" : value <= t.poor ? "needs-improvement" : "poor";
}

export function rateScore(score: number): Rating {
  return score >= 0.9 ? "good" : score >= 0.5 ? "needs-improvement" : "poor";
}

export function ratingToStatus(r: Rating): "PASS" | "WARNING" | "FAIL" {
  return r === "good" ? "PASS" : r === "needs-improvement" ? "WARNING" : "FAIL";
}

export function formatMetric(key: MetricKey, value: number): string {
  return key === "cls" ? value.toFixed(3) : `${Math.round(value)} ms`;
}
