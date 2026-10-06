import type { BugSeverity, TestResultStatus } from "@/types";

/**
 * Analysis assistant contract.
 *
 * Ground rules for every implementation (local or LLM-backed):
 * - Outputs are *suggestions* derived from the inputs passed in. They are never test
 *   results, evidence, screenshots, measurements, PageSpeed metrics or expected content.
 * - An implementation must not fabricate observations that were not in its input.
 * - The application must keep working when only LocalAnalysisProvider is available.
 */
export interface AIProvider {
  readonly id: string;
  readonly label: string;
  /** True for providers that send data to an external service. */
  readonly external: boolean;
  readonly capabilities: ReadonlySet<AICapability>;

  suggestBugTitle(observation: FailureObservation): Promise<Suggestion<string>>;
  suggestSeverity(observation: FailureObservation): Promise<Suggestion<BugSeverity>>;
  findDuplicateBugs(candidate: BugCandidate, existing: BugCandidate[], threshold?: number): Promise<DuplicateMatch[]>;
  summarizeResults(counts: ResultCounts): Promise<Suggestion<string>>;
  prioritizeModules(moduleIds: string[], context: PrioritizationContext): Promise<Suggestion<string[]>>;
  compareText(expected: string, actual: string): Promise<TextComparison>;
  suggestRootCause(observation: FailureObservation): Promise<Suggestion<string | null>>;
}

export type AICapability =
  | "bug-title"
  | "severity"
  | "duplicate-detection"
  | "result-summary"
  | "prioritization"
  | "text-comparison"
  | "root-cause"
  | "scenario-generation"
  | "expectation-analysis"
  | "figma-comparison";

export interface Suggestion<T> {
  value: T;
  /** Human-readable explanation of how the suggestion was derived. */
  rationale: string;
  /** Identifies the provider that produced it, for audit trails. */
  source: string;
}

/** A real, observed failure produced by the testing engine. */
export interface FailureObservation {
  module: string;
  checkKey?: string;
  status: Extract<TestResultStatus, "FAIL" | "WARNING">;
  message: string;
  pageUrl?: string;
  selector?: string;
  httpStatus?: number;
  consoleErrors?: string[];
}

export interface BugCandidate {
  id?: string;
  title: string;
  fingerprint?: string | null;
}

export interface DuplicateMatch {
  id: string;
  score: number;
  reason: "fingerprint" | "similar-title";
}

export interface ResultCounts {
  pass: number;
  fail: number;
  warning: number;
  notExecuted: number;
  notApplicable: number;
}

export interface PrioritizationContext {
  hasForms?: boolean;
  isEcommerce?: boolean;
  previouslyFailedModules?: string[];
}

export interface TextComparison {
  similarity: number; // 0..1
  missingWords: string[];
  extraWords: string[];
}

export class AICapabilityUnavailableError extends Error {
  constructor(provider: string, capability: AICapability) {
    super(`AI provider "${provider}" does not support "${capability}".`);
    this.name = "AICapabilityUnavailableError";
  }
}
