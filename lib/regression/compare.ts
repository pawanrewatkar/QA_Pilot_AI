import type { TestResultStatus } from "@/types";

/**
 * Regression comparison between two runs, keyed by stable identifiers only:
 * test case key (page + module + check + element) × browser × viewport.
 *
 * "Resolved" requires a verified PASS in the newer run. A failure that was not executed, became a
 * WARNING, or simply looks different (text, screenshot) is never reported as resolved.
 */
export const REGRESSION_CATEGORIES = ["NEW", "RESOLVED", "STILL_FAILING", "CHANGED", "UNCHANGED", "UNABLE_TO_COMPARE"] as const;
export type RegressionCategory = (typeof REGRESSION_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<RegressionCategory, string> = {
  NEW: "New",
  RESOLVED: "Resolved",
  STILL_FAILING: "Still Failing",
  CHANGED: "Changed",
  UNCHANGED: "Unchanged",
  UNABLE_TO_COMPARE: "Unable to Compare",
};

export interface KeyedResult {
  caseKey: string;
  browser: string | null;
  viewport: string | null;
  status: TestResultStatus;
  title: string;
  module: string;
  pageUrl: string | null;
}

export interface ResultComparison {
  key: string;
  category: RegressionCategory;
  reason: string;
  title: string;
  module: string;
  pageUrl: string | null;
  browser: string | null;
  viewport: string | null;
  previous: TestResultStatus | null;
  current: TestResultStatus | null;
}

const VERDICT = new Set<TestResultStatus>(["PASS", "FAIL", "WARNING"]);
const resultKey = (r: Pick<KeyedResult, "caseKey" | "browser" | "viewport">) => `${r.caseKey}|${r.browser ?? ""}|${r.viewport ?? ""}`;

export function classifyPair(previous: TestResultStatus | null, current: TestResultStatus | null): { category: RegressionCategory; reason: string } {
  if (previous === null && current === null) return { category: "UNABLE_TO_COMPARE", reason: "Not tested in either run" };
  if (previous === null) {
    return current === "FAIL" ? { category: "NEW", reason: "New failing check (not tested in the previous run)" } : { category: "UNABLE_TO_COMPARE", reason: "Not tested in the previous run" };
  }
  if (current === null) {
    return { category: "UNABLE_TO_COMPARE", reason: previous === "FAIL" ? "Failed previously but was not tested in this run, so it cannot be confirmed as resolved" : "Not tested in this run" };
  }
  if (previous === "FAIL" && current === "FAIL") return { category: "STILL_FAILING", reason: "Failed in both runs" };
  if (current === "FAIL") {
    return VERDICT.has(previous) ? { category: "NEW", reason: `Failed now; was ${previous} before` } : { category: "NEW", reason: `Failed now; was ${previous} before (could not be checked then)` };
  }
  if (previous === "FAIL" && current === "PASS") return { category: "RESOLVED", reason: "Failed before and was verified as passing now" };
  if (previous === "FAIL") {
    return current === "WARNING"
      ? { category: "CHANGED", reason: "Failed before; now only a warning (needs review, not verified as resolved)" }
      : { category: "UNABLE_TO_COMPARE", reason: `Failed before; now ${current}, so it cannot be confirmed as resolved` };
  }
  if (previous === current) return { category: "UNCHANGED", reason: `${current} in both runs` };
  if (!VERDICT.has(previous) || !VERDICT.has(current)) return { category: "UNABLE_TO_COMPARE", reason: `${previous} before, ${current} now` };
  return { category: "CHANGED", reason: `${previous} before, ${current} now` };
}

/** One entry per check that exists in either run. */
export function compareResults(previous: KeyedResult[], current: KeyedResult[]): ResultComparison[] {
  // When a check ran several times for one key (rare), the worst outcome represents it.
  const rank: Record<TestResultStatus, number> = { FAIL: 0, WARNING: 1, PASS: 2, "NOT EXECUTED": 3, "NOT APPLICABLE": 4 };
  const index = (list: KeyedResult[]) => {
    const m = new Map<string, KeyedResult>();
    for (const r of list) {
      const k = resultKey(r);
      const existing = m.get(k);
      if (!existing || rank[r.status] < rank[existing.status]) m.set(k, r);
    }
    return m;
  };
  const prev = index(previous);
  const curr = index(current);
  const out: ResultComparison[] = [];
  for (const key of new Set([...prev.keys(), ...curr.keys()])) {
    const p = prev.get(key) ?? null;
    const c = curr.get(key) ?? null;
    const ref = (c ?? p)!;
    const { category, reason } = classifyPair(p?.status ?? null, c?.status ?? null);
    out.push({ key, category, reason, title: ref.title, module: ref.module, pageUrl: ref.pageUrl, browser: ref.browser, viewport: ref.viewport, previous: p?.status ?? null, current: c?.status ?? null });
  }
  const order: RegressionCategory[] = ["NEW", "STILL_FAILING", "CHANGED", "UNABLE_TO_COMPARE", "RESOLVED", "UNCHANGED"];
  return out.sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category) || a.title.localeCompare(b.title));
}

export function countCategories(items: { category: RegressionCategory }[]): Record<RegressionCategory, number> {
  const counts = Object.fromEntries(REGRESSION_CATEGORIES.map((c) => [c, 0])) as Record<RegressionCategory, number>;
  for (const i of items) counts[i.category]++;
  return counts;
}

// ---------------------------------------------------------------- performance

export interface PerfPoint {
  pageUrl: string;
  formFactor: string | null;
  source: string;
  performanceScore: number | null;
  accessibilityScore: number | null;
  lcpMs: number | null;
  cls: number | null;
  tbtMs: number | null;
}

export type Direction = "IMPROVED" | "REGRESSED" | "UNCHANGED" | "UNABLE_TO_COMPARE";

export interface MetricChange {
  metric: string;
  previous: number | null;
  current: number | null;
  direction: Direction;
}

export interface PerfComparison {
  pageUrl: string;
  formFactor: string | null;
  changes: MetricChange[];
  overall: Direction;
}

/** Thresholds that separate a real change from normal lab noise. Higher is better for scores. */
const PERF_RULES: { metric: keyof PerfPoint; label: string; higherIsBetter: boolean; minDelta: (prev: number) => number }[] = [
  { metric: "performanceScore", label: "Performance score", higherIsBetter: true, minDelta: () => 0.05 },
  { metric: "accessibilityScore", label: "Accessibility score", higherIsBetter: true, minDelta: () => 0.05 },
  { metric: "lcpMs", label: "LCP", higherIsBetter: false, minDelta: (p) => Math.max(100, p * 0.1) },
  { metric: "tbtMs", label: "TBT", higherIsBetter: false, minDelta: (p) => Math.max(50, p * 0.1) },
  { metric: "cls", label: "CLS", higherIsBetter: false, minDelta: () => 0.02 },
];

export function comparePerformance(previous: PerfPoint[], current: PerfPoint[]): PerfComparison[] {
  const key = (p: PerfPoint) => `${p.pageUrl}|${p.formFactor ?? ""}`;
  const prev = new Map(previous.map((p) => [key(p), p]));
  const out: PerfComparison[] = [];
  for (const c of current) {
    const p = prev.get(key(c));
    const changes: MetricChange[] = PERF_RULES.map((rule) => {
      const pv = p ? (p[rule.metric] as number | null) : null;
      const cv = c[rule.metric] as number | null;
      if (!p || p.source !== c.source || pv === null || cv === null) return { metric: rule.label, previous: pv, current: cv, direction: "UNABLE_TO_COMPARE" as Direction };
      const delta = cv - pv;
      if (Math.abs(delta) < rule.minDelta(pv)) return { metric: rule.label, previous: pv, current: cv, direction: "UNCHANGED" as Direction };
      const better = rule.higherIsBetter ? delta > 0 : delta < 0;
      return { metric: rule.label, previous: pv, current: cv, direction: (better ? "IMPROVED" : "REGRESSED") as Direction };
    });
    const directions = changes.map((x) => x.direction);
    const overall: Direction = directions.every((d) => d === "UNABLE_TO_COMPARE")
      ? "UNABLE_TO_COMPARE"
      : directions.includes("REGRESSED")
        ? "REGRESSED"
        : directions.includes("IMPROVED")
          ? "IMPROVED"
          : "UNCHANGED";
    out.push({ pageUrl: c.pageUrl, formFactor: c.formFactor, changes, overall });
  }
  return out;
}

// ---------------------------------------------------------------- finding sets (accessibility rules, UI checks)

export interface FindingSetComparison {
  scope: string;
  newFindings: string[];
  fixedFindings: string[];
  persistingFindings: string[];
  comparable: boolean;
}

/**
 * Compares sets of findings (e.g. violated axe rules, failing UI checks) per scope (page/viewport).
 * A scope is only comparable when it was examined in both runs; otherwise nothing is called fixed.
 */
export function compareFindingSets(previous: Map<string, Set<string>>, current: Map<string, Set<string>>, examinedPrevious: Set<string>, examinedCurrent: Set<string>): FindingSetComparison[] {
  const scopes = new Set([...previous.keys(), ...current.keys()]);
  const out: FindingSetComparison[] = [];
  for (const scope of scopes) {
    const p = previous.get(scope) ?? new Set<string>();
    const c = current.get(scope) ?? new Set<string>();
    const comparable = examinedPrevious.has(scope) && examinedCurrent.has(scope);
    out.push({
      scope,
      comparable,
      newFindings: comparable ? [...c].filter((x) => !p.has(x)) : [],
      fixedFindings: comparable ? [...p].filter((x) => !c.has(x)) : [],
      persistingFindings: comparable ? [...c].filter((x) => p.has(x)) : [...c],
    });
  }
  return out.sort((a, b) => a.scope.localeCompare(b.scope));
}

// ---------------------------------------------------------------- full run comparison

export interface RunComparison {
  current: import("@/types").RunHistoryRecord;
  previous: import("@/types").RunHistoryRecord;
  results: ResultComparison[];
  counts: Record<RegressionCategory, number>;
  bugs: {
    /** First seen in the current run. */
    new: import("@/types").BugRecord[];
    /** Seen in the current run and already known before it. */
    existing: import("@/types").BugRecord[];
    /** Seen in the previous run but not in this one. Never marked resolved automatically. */
    notObserved: import("@/types").BugRecord[];
  };
  performance: PerfComparison[];
  accessibility: FindingSetComparison[];
  ui: FindingSetComparison[];
}
