import type { ScenarioType } from "@/types";
import type { InspectedSearch } from "../browser-scripts";
import type { PageTestContext, TestModule } from "../context";
import { evidence, outcome, type CheckOutcome } from "../outcome";
import { describe, inspect, isVisible, locate, settle, spec } from "./helpers";

interface SearchAttempt {
  ok: boolean;
  error?: string;
  url: string;
  status: number | null;
  navigated: boolean;
  pageErrors: string[];
  dialogs: string[];
  bodyHasTerm: boolean;
}

async function submitSearch(ctx: PageTestContext, search: InspectedSearch, term: string): Promise<SearchAttempt> {
  const page = ctx.session.page;
  const before = page.url();
  const mark = ctx.session.mark();
  const input = locate(ctx, search.inputQid);
  try {
    await input.fill(term, { timeout: 5_000 });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message.split("\n")[0] : String(error), url: before, status: null, navigated: false, pageErrors: [], dialogs: [], bodyHasTerm: false };
  }
  const nav = page.waitForNavigation({ timeout: 8_000, waitUntil: "domcontentloaded" }).catch(() => null);
  await input.press("Enter").catch(() => undefined);
  const response = await nav;
  await settle(ctx, 600);
  const since = ctx.session.since(mark);
  const trimmed = term.trim();
  const bodyHasTerm = trimmed.length > 0 && ((await page.locator("body").innerText({ timeout: 3_000 }).catch(() => "")) || "").toLowerCase().includes(trimmed.toLowerCase());
  return { ok: true, url: page.url(), status: response?.status() ?? null, navigated: !!response || page.url() !== before, pageErrors: since.pageErrors, dialogs: since.dialogs, bodyHasTerm };
}

function stableHandling(s: ReturnType<typeof spec>, r: SearchAttempt, what: string): CheckOutcome {
  if (!r.ok) return outcome.warn(s, `Could not enter the search value: ${r.error}`);
  if (r.status !== null && r.status >= 500) return outcome.fail(s, `Search for ${what} returned HTTP ${r.status}`, [evidence.http("Search response", `URL: ${r.url}\nStatus: ${r.status}`)]);
  if (r.pageErrors.length) return outcome.fail(s, `Search for ${what} raised a script error: ${r.pageErrors[0]}`, [evidence.note("Uncaught page errors", r.pageErrors.join("\n"))]);
  if (r.dialogs.length) return outcome.warn(s, `A browser dialog appeared after searching for ${what}: ${r.dialogs[0]}`, { evidence: [evidence.note("Dialogs", r.dialogs.join("\n"))] });
  return outcome.pass(s, `Handled without error (${r.navigated ? `navigated to ${r.url}${r.status ? `, HTTP ${r.status}` : ""}` : "no navigation"})`, [
    r.status !== null ? `Response status ${r.status}` : "No error response",
    "No uncaught script errors",
  ]);
}

export const searchModule: TestModule = {
  id: "search",
  scope: "combo",
  async run(ctx) {
    const first = (await inspect(ctx)).searches;
    if (first.length === 0) {
      return [outcome.notApplicable(spec("search", "none", { title: "Site search", feature: "Search", element: "search input", steps: ["Inspect page"], expected: "Search works" }), "No search input was found on this page.")];
    }
    const base = (scenarioType: ScenarioType, key: string, title: string, data: string, expected: string, s: InspectedSearch) =>
      spec("search", key, {
        title,
        section: "Search",
        scenarioType,
        feature: "Search",
        element: describe("input", s.name || "search"),
        testData: data,
        steps: ["Focus the search field", `Type ${data}`, "Press Enter", "Observe the result"],
        expected,
      });

    const cases: { scenario: ScenarioType; key: string; title: string; data: string; value: (s: InspectedSearch, term: string) => string; expected: string; positive?: boolean }[] = [
      { scenario: "POSITIVE", key: "valid", title: "Valid search returns results for a site term", data: "a word taken from the page", value: (_s, t) => t, expected: "The search runs and the results reflect the query (query in URL or results text)", positive: true },
      { scenario: "NEGATIVE", key: "special-chars", title: "Search handles special characters safely", data: `"'<>&% characters`, value: () => `"'<>&%`, expected: "No server error (5xx), no script error and no unexpected dialog" },
      { scenario: "EDGE", key: "whitespace", title: "Search handles a whitespace-only query", data: "three spaces", value: () => "   ", expected: "No server error and no script error" },
      { scenario: "EDGE", key: "unicode", title: "Search handles Unicode input", data: "café 日本語 😀", value: () => "café 日本語 😀", expected: "No server error and no script error" },
      { scenario: "EDGE", key: "long", title: "Search handles a very long query", data: "300-character string", value: () => "qa".repeat(150), expected: "No server error and no script error" },
    ];

    const results: CheckOutcome[] = [];
    for (const c of cases) {
      if (ctx.isCancelled()) break;
      ctx.setCurrentTest(`Search: ${c.title}`);
      const insp = await inspect(ctx);
      const search = insp.searches.find((s) => s.visible) ?? insp.searches[0];
      const term = insp.searchTerm ?? "test";
      const s = base(c.scenario, `${c.key}`, c.title, c.positive ? `"${term}"` : c.data, c.expected, search);
      if (!(await isVisible(locate(ctx, search.inputQid)))) {
        results.push(outcome.notExecuted(s, `Search input exists but is not visible at ${ctx.viewport.width}×${ctx.viewport.height} (it may be behind a toggle).`));
        continue;
      }
      const attempt = await submitSearch(ctx, search, c.value(search, term));
      if (c.positive) {
        if (!attempt.ok) results.push(outcome.warn(s, `Could not type into the search field: ${attempt.error}`));
        else if (attempt.status !== null && attempt.status >= 400) results.push(outcome.fail(s, `Search returned HTTP ${attempt.status}`, [evidence.http("Search response", `URL: ${attempt.url}\nStatus: ${attempt.status}`)]));
        else if (attempt.url.toLowerCase().includes(encodeURIComponent(term).toLowerCase()) || attempt.url.toLowerCase().includes(term.toLowerCase())) {
          results.push(outcome.pass(s, `Search navigated to ${attempt.url}`, [`Query "${term}" present in result URL`, ...(attempt.bodyHasTerm ? [`Result page mentions "${term}"`] : [])], { evidence: (await ctx.capture("Search results").then((x) => (x ? [x] : []))) }));
        } else if (attempt.navigated && attempt.bodyHasTerm) {
          results.push(outcome.pass(s, `Search results page mentions "${term}"`, [`Navigated to ${attempt.url}`, `Result text contains "${term}"`]));
        } else {
          const shot = await ctx.capture("After search");
          results.push(outcome.warn(s, attempt.navigated ? `Navigated to ${attempt.url} but the query could not be confirmed in the result` : "No navigation or detectable result after submitting the search", { evidence: shot ? [shot] : [] }));
        }
      } else {
        results.push(stableHandling(s, attempt, c.data));
      }
      await ctx.reload();
    }

    // Boundary: declared maxlength only.
    const insp = await inspect(ctx);
    const search = insp.searches.find((s) => s.visible);
    if (search) {
      const input = locate(ctx, search.inputQid);
      const max = Number(await input.getAttribute("maxlength").catch(() => null));
      const s = spec("search", "maxlength", {
        title: "Search field enforces its declared maximum length",
        section: "Search",
        scenarioType: "BOUNDARY",
        feature: "Search",
        element: describe("input", search.name || "search"),
        testData: max > 0 ? `${max + 1} characters (maxlength=${max})` : undefined,
        steps: ["Type one character more than the declared maxlength", "Read the field value"],
        expected: "The field keeps at most maxlength characters",
      });
      if (!(max > 0)) results.push(outcome.notApplicable(s, "The search field declares no maxlength; no limit to verify."));
      else {
        await input.fill("", { timeout: 3_000 }).catch(() => undefined);
        await input.pressSequentially("x".repeat(max + 1), { timeout: 10_000 }).catch(() => undefined);
        const len = (await input.inputValue().catch(() => "")).length;
        results.push(len <= max ? outcome.pass(s, `Field kept ${len} of ${max + 1} typed characters`, [`value length ${len} ≤ maxlength ${max}`]) : outcome.fail(s, `Field accepted ${len} characters despite maxlength=${max}`, [evidence.dom("Field", `maxlength=${max}, value length=${len}`)]));
      }
    }
    return results;
  },
};
