import { getTestModule } from "@/lib/constants/testing";
import type { BugSeverity } from "@/types";
import type {
  AICapability,
  AIProvider,
  BugCandidate,
  DuplicateMatch,
  FailureObservation,
  PrioritizationContext,
  ResultCounts,
  Suggestion,
  TextComparison,
} from "./provider";

const SOURCE = "local-analysis";

/** Modules whose failures usually block users or revenue. */
const HIGH_IMPACT_MODULES = new Set(["login", "logout", "ecommerce", "forms", "functional"]);
const LOW_IMPACT_MODULES = new Set(["typography", "seo", "content", "social-links", "breadcrumb"]);

/** Base execution priority per module; lower runs first. Unlisted modules default to 50. */
const MODULE_PRIORITY: Record<string, number> = {
  functional: 10,
  links: 12,
  navigation: 14,
  console: 16,
  network: 18,
  forms: 20,
  login: 20,
  logout: 22,
  ecommerce: 24,
  accessibility: 30,
  responsive: 32,
  performance: 34,
  seo: 40,
};

const STOP_WORDS = new Set(["a", "an", "the", "of", "on", "in", "to", "is", "and", "or", "for", "at", "with"]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

function pathOf(url?: string): string | null {
  if (!url) return null;
  try {
    return new URL(url).pathname || "/";
  } catch {
    return null;
  }
}

/**
 * Deterministic, offline implementation of AIProvider. It only rearranges and scores
 * the information it is given; it never calls a network service or invents observations.
 */
export class LocalAnalysisProvider implements AIProvider {
  readonly id = "local";
  readonly label = "Local Analysis (rule-based)";
  readonly external = false;
  readonly capabilities: ReadonlySet<AICapability> = new Set<AICapability>([
    "bug-title",
    "severity",
    "duplicate-detection",
    "result-summary",
    "prioritization",
    "text-comparison",
    "root-cause",
  ]);

  async suggestBugTitle(o: FailureObservation): Promise<Suggestion<string>> {
    const moduleLabel = getTestModule(o.module)?.label.replace(/ Testing$/, "") ?? o.module;
    const location = pathOf(o.pageUrl);
    const message = o.message.trim().replace(/\s+/g, " ");
    const short = message.length > 90 ? `${message.slice(0, 87)}...` : message;
    const value = `[${moduleLabel}] ${short}${location ? ` on ${location}` : ""}`;
    return { value, rationale: "Composed from the module, the observed failure message and the page path.", source: SOURCE };
  }

  async suggestSeverity(o: FailureObservation): Promise<Suggestion<BugSeverity>> {
    const text = `${o.message} ${o.checkKey ?? ""}`.toLowerCase();
    let severity: BugSeverity;
    let rationale: string;

    if (o.httpStatus !== undefined && o.httpStatus >= 500) {
      severity = "CRITICAL";
      rationale = `Server error (HTTP ${o.httpStatus}) observed.`;
    } else if (/crash|uncaught|unhandled|white screen|cannot (log ?in|checkout|submit)/.test(text)) {
      severity = "CRITICAL";
      rationale = "Failure message indicates a blocking error.";
    } else if (HIGH_IMPACT_MODULES.has(o.module) && o.status === "FAIL") {
      severity = "HIGH";
      rationale = `Failure in a user-critical module (${o.module}).`;
    } else if (o.httpStatus === 404 || (o.consoleErrors?.length ?? 0) > 0) {
      severity = "MEDIUM";
      rationale = o.httpStatus === 404 ? "Broken resource (HTTP 404)." : "Console errors were recorded.";
    } else if (o.status === "WARNING" || LOW_IMPACT_MODULES.has(o.module)) {
      severity = "LOW";
      rationale = o.status === "WARNING" ? "Recorded as a warning, not a failure." : `Cosmetic or non-blocking module (${o.module}).`;
    } else {
      severity = "MEDIUM";
      rationale = "Default severity for a confirmed failure without stronger signals.";
    }
    return { value: severity, rationale, source: SOURCE };
  }

  async findDuplicateBugs(candidate: BugCandidate, existing: BugCandidate[], threshold = 0.8): Promise<DuplicateMatch[]> {
    const candidateTokens = new Set(tokenize(candidate.title).filter((t) => !STOP_WORDS.has(t)));
    const matches: DuplicateMatch[] = [];
    for (const bug of existing) {
      if (!bug.id || bug.id === candidate.id) continue;
      if (candidate.fingerprint && bug.fingerprint && candidate.fingerprint === bug.fingerprint) {
        matches.push({ id: bug.id, score: 1, reason: "fingerprint" });
        continue;
      }
      const score = jaccard(candidateTokens, new Set(tokenize(bug.title).filter((t) => !STOP_WORDS.has(t))));
      if (score >= threshold) matches.push({ id: bug.id, score: Math.round(score * 1000) / 1000, reason: "similar-title" });
    }
    return matches.sort((a, b) => b.score - a.score);
  }

  async summarizeResults(c: ResultCounts): Promise<Suggestion<string>> {
    const executed = c.pass + c.fail + c.warning;
    const total = executed + c.notExecuted + c.notApplicable;
    if (total === 0) {
      return { value: "No test results have been recorded.", rationale: "All counts are zero.", source: SOURCE };
    }
    const passRate = executed > 0 ? Math.round((c.pass / executed) * 1000) / 10 : 0;
    const parts = [
      `${executed} of ${total} checks executed`,
      executed > 0 ? `${passRate}% pass rate` : null,
      `${c.fail} failed`,
      `${c.warning} warnings`,
      c.notExecuted > 0 ? `${c.notExecuted} not executed` : null,
      c.notApplicable > 0 ? `${c.notApplicable} not applicable` : null,
    ].filter(Boolean);
    return { value: `${parts.join(", ")}.`, rationale: "Computed directly from recorded result counts.", source: SOURCE };
  }

  async prioritizeModules(moduleIds: string[], ctx: PrioritizationContext): Promise<Suggestion<string[]>> {
    const previouslyFailed = new Set(ctx.previouslyFailedModules ?? []);
    const score = (id: string) => {
      let s = MODULE_PRIORITY[id] ?? 50;
      if (previouslyFailed.has(id)) s -= 25;
      if (ctx.hasForms && (id === "forms" || id === "negative" || id === "boundary")) s -= 8;
      if (ctx.isEcommerce && id === "ecommerce") s -= 15;
      return s;
    };
    const value = [...new Set(moduleIds)].sort((a, b) => score(a) - score(b) || a.localeCompare(b));
    return {
      value,
      rationale: "Ordered by a fixed module weight, boosted for previously failing modules and project context.",
      source: SOURCE,
    };
  }

  async compareText(expected: string, actual: string): Promise<TextComparison> {
    const expectedTokens = tokenize(expected);
    const actualTokens = tokenize(actual);
    const e = new Set(expectedTokens);
    const a = new Set(actualTokens);
    return {
      similarity: Math.round(jaccard(e, a) * 1000) / 1000,
      missingWords: [...e].filter((t) => !a.has(t)),
      extraWords: [...a].filter((t) => !e.has(t)),
    };
  }

  async suggestRootCause(o: FailureObservation): Promise<Suggestion<string | null>> {
    const text = o.message.toLowerCase();
    const rules: [boolean, string][] = [
      [o.httpStatus !== undefined && o.httpStatus >= 500, "Server-side error; check application/server logs for this route."],
      [o.httpStatus === 404, "Resource or route does not exist; check the link target or deployment."],
      [o.httpStatus === 401 || o.httpStatus === 403, "Access control rejected the request; verify authentication and permissions."],
      [/timeout|timed out/.test(text), "Element or response did not appear in time; check slow resources or missing elements."],
      [/cors|blocked by/.test(text), "Cross-origin or content-security policy blocked a request."],
      [/mixed content/.test(text), "HTTP resource loaded on an HTTPS page."],
      [/not visible|hidden|overlap/.test(text), "Layout or CSS issue hiding or overlapping the element."],
    ];
    const hit = rules.find(([match]) => match);
    return {
      value: hit ? hit[1] : null,
      rationale: hit ? "Matched a known failure pattern in the observation." : "No known pattern matched; no suggestion made.",
      source: SOURCE,
    };
  }
}
