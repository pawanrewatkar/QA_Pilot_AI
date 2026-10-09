import type { TestModule } from "@/lib/testing/context";
import { evidence, outcome, type CheckOutcome } from "@/lib/testing/outcome";
import { spec } from "@/lib/testing/modules/helpers";
import { interpretCase } from "./interpret";
import { runExternalCase } from "./run-case";
import type { ExternalCase, ExternalStatus } from "./types";

/** Run-scoped keys in PageTestContext.shared, provided by the executor for external runs. */
export const EXTERNAL_CASES_KEY = "external:cases";
export const EXTERNAL_SINK_KEY = "external:sink";

export type StoredExternalCase = ExternalCase & { id: string };

export interface ExternalObservationInput {
  caseId: string;
  browser: string;
  viewport: string;
  status: ExternalStatus;
  actual: string;
  screenshotKey: string | null;
  durationMs: number;
}

export const externalSpec = (c: ExternalCase) =>
  spec("external", `row-${c.rowNumber}`, {
    title: c.caseRef ? `${c.caseRef}: ${c.title}` : c.title,
    section: "External Test Case",
    feature: "External test case",
    element: c.caseRef ?? `Row ${c.rowNumber}`,
    steps: c.steps ? c.steps.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [],
    expected: c.expected ?? "",
    preconditions: c.preconditions ?? undefined,
    testData: c.testData ?? undefined,
    // The expected result comes straight from the user's test case: the highest expectation source.
    expectationSource: "REQUIREMENT",
  });

/**
 * Runs every external test case, sequentially, in each browser × viewport of the run. Each case becomes
 * a standard result (so evidence, bugs, history and comparison work as for any other module) and an
 * observation with this module's own status (which adds HUMAN INTERACTION, stored as WARNING in the
 * standard result: a person must review it).
 */
export const externalModule: TestModule = {
  id: "external",
  scope: "combo",
  async run(ctx) {
    const cases = (ctx.shared.get(EXTERNAL_CASES_KEY) as StoredExternalCase[] | undefined) ?? [];
    const sink = ctx.shared.get(EXTERNAL_SINK_KEY) as ((o: ExternalObservationInput) => void) | undefined;
    const results: CheckOutcome[] = [];
    for (const c of cases) {
      if (ctx.isCancelled()) break;
      ctx.setCurrentTest(`${c.caseRef ? `${c.caseRef} - ` : ""}${c.title}`.slice(0, 200));
      const s = externalSpec(c);
      let res;
      try {
        res = await runExternalCase(ctx, c, interpretCase(c, ctx.url), ctx.url);
      } catch (error) {
        res = { status: "NOT EXECUTED" as const, actual: `The test case stopped with an unexpected error: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`, verifications: [], evidence: [], durationMs: 0 };
      }
      sink?.({
        caseId: c.id,
        browser: ctx.browser,
        viewport: ctx.viewport.id,
        status: res.status,
        actual: res.actual,
        screenshotKey: res.evidence.find((e) => e.type === "screenshot")?.storageKey ?? null,
        durationMs: res.durationMs,
      });
      const extra = { evidence: res.evidence, durationMs: res.durationMs };
      switch (res.status) {
        case "PASS":
          results.push(outcome.pass(s, res.actual, res.verifications, extra));
          break;
        case "FAIL":
          results.push(outcome.fail(s, res.actual, res.evidence.length ? res.evidence : [evidence.note("Observed", res.actual)], extra));
          break;
        case "HUMAN INTERACTION":
          results.push(outcome.warn(s, res.actual, extra));
          break;
        case "NOT APPLICABLE":
          results.push(outcome.notApplicable(s, res.actual));
          break;
        default:
          results.push(outcome.notExecuted(s, res.actual));
      }
    }
    return results;
  },
};
