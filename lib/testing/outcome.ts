import type { EvidenceItem, ExpectationSource, ScenarioType, TestResultStatus } from "@/types";
import type { DetailRow } from "./details";

/** Browser-independent identity of a test case on one page. */
export interface CaseSpec {
  /** Unique within the page and module, stable across browsers/viewports. */
  key: string;
  module: string;
  title: string;
  section: string;
  scenarioType: ScenarioType;
  feature: string;
  element: string;
  preconditions?: string;
  testData?: string;
  steps: string[];
  expected: string;
  /** Where the expected result comes from (default: functionality detected on the page). */
  expectationSource?: ExpectationSource;
}

export interface CheckOutcome {
  spec: CaseSpec;
  status: TestResultStatus;
  actual: string;
  /** Concrete observations proving the verdict (e.g. "aria-selected changed false → true"). */
  verifications: string[];
  evidence: EvidenceItem[];
  durationMs: number | null;
  /** Measurement rows stored in the per-check tables (ui_results, seo_results, …), linked to this result. */
  details?: DetailRow[];
  /** Viewport the check was actually measured at, when it differs from the run combination (responsive testing). */
  viewportOverride?: string;
}

export interface FinalizedOutcome extends CheckOutcome {
  executedAt: string | null;
  /** Set when a rule changed the status the module proposed. */
  adjustment: string | null;
}

/**
 * Enforces the result-integrity rules before anything is stored:
 * - PASS requires at least one recorded verification; otherwise it becomes WARNING.
 * - FAIL requires reproducible evidence; otherwise it becomes WARNING.
 * - An AI exploratory expectation can never produce a FAIL (it becomes WARNING: review required).
 * - Only executed verdicts (PASS / FAIL / WARNING) carry an execution timestamp.
 */
export function finalizeOutcome(outcome: CheckOutcome, now: () => Date = () => new Date()): FinalizedOutcome {
  let status = outcome.status;
  let adjustment: string | null = null;
  if (status === "PASS" && outcome.verifications.length === 0) {
    status = "WARNING";
    adjustment = "Proposed PASS had no recorded verification; downgraded to WARNING.";
  } else if (status === "FAIL" && outcome.evidence.length === 0) {
    status = "WARNING";
    adjustment = "Proposed FAIL had no captured evidence; downgraded to WARNING.";
  } else if (status === "FAIL" && outcome.spec.expectationSource === "AI_EXPLORATORY") {
    status = "WARNING";
    adjustment = "The expectation came from AI exploration, which cannot establish a verified failure; marked for review.";
  }
  const executed = status === "PASS" || status === "FAIL" || status === "WARNING";
  return {
    ...outcome,
    status,
    actual: adjustment ? `${outcome.actual} (${adjustment})` : outcome.actual,
    executedAt: executed ? now().toISOString() : null,
    adjustment,
  };
}

type Extra = { evidence?: EvidenceItem[]; verifications?: string[]; durationMs?: number | null; details?: DetailRow[] };

export const outcome = {
  pass(spec: CaseSpec, actual: string, verifications: string[], extra: Extra = {}): CheckOutcome {
    return { spec, status: "PASS", actual, verifications, evidence: extra.evidence ?? [], durationMs: extra.durationMs ?? null, details: extra.details };
  },
  fail(spec: CaseSpec, actual: string, evidence: EvidenceItem[], extra: Extra = {}): CheckOutcome {
    return { spec, status: "FAIL", actual, verifications: extra.verifications ?? [], evidence, durationMs: extra.durationMs ?? null, details: extra.details };
  },
  warn(spec: CaseSpec, actual: string, extra: Extra = {}): CheckOutcome {
    return { spec, status: "WARNING", actual, verifications: extra.verifications ?? [], evidence: extra.evidence ?? [], durationMs: extra.durationMs ?? null, details: extra.details };
  },
  notExecuted(spec: CaseSpec, reason: string): CheckOutcome {
    return { spec, status: "NOT EXECUTED", actual: reason, verifications: [], evidence: [], durationMs: null };
  },
  notApplicable(spec: CaseSpec, reason: string): CheckOutcome {
    return { spec, status: "NOT APPLICABLE", actual: reason, verifications: [], evidence: [], durationMs: null };
  },
};

/** Evidence helpers. */
export const evidence = {
  note: (label: string, content: string): EvidenceItem => ({ type: "note", label, content: content.slice(0, 4000) }),
  http: (label: string, content: string): EvidenceItem => ({ type: "http", label, content: content.slice(0, 4000) }),
  dom: (label: string, content: string): EvidenceItem => ({ type: "dom", label, content: content.slice(0, 4000) }),
};
