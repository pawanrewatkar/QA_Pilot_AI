import type { Locator } from "playwright";
import { normalizeCrawlUrl } from "@/lib/crawler/normalize";
import { classifyBrowserError } from "@/lib/playwright/errors";
import type { ExpectationSource, ScenarioType } from "@/types";
import { INSPECT_SCRIPT, PAGE_STATE_SCRIPT, qapSelector, runScript, STATE_SIGNATURE_SCRIPT, type Inspection } from "../browser-scripts";
import type { PageTestContext } from "../context";
import type { CaseSpec } from "../outcome";

/** Visible text on controls the engine must never activate automatically. */
export const DANGEROUS_ACTION =
  /\b(delete|remove|destroy|buy|purchase|pay|checkout|check out|place order|order now|add to (cart|bag|basket)|subscribe|unsubscribe|log ?out|sign ?out|cancel (my )?(account|subscription|order)|donate|book now|reserve|submit|send|apply now|deactivate|reset)\b/i;

export const MAX_ITEMS_PER_FEATURE = 5;

export function spec(
  module: string,
  key: string,
  fields: {
    title: string;
    section?: string;
    scenarioType?: ScenarioType;
    feature: string;
    element: string;
    steps: string[];
    expected: string;
    preconditions?: string;
    testData?: string;
    expectationSource?: ExpectationSource;
  },
): CaseSpec {
  return {
    key: `${module}:${key}`,
    module,
    title: fields.title,
    section: fields.section ?? "Page",
    scenarioType: fields.scenarioType ?? "FUNCTIONAL",
    feature: fields.feature,
    element: fields.element,
    preconditions: fields.preconditions,
    testData: fields.testData,
    steps: fields.steps,
    expected: fields.expected,
    expectationSource: fields.expectationSource,
  };
}

export async function inspect(ctx: PageTestContext): Promise<Inspection> {
  return runScript<Inspection>(ctx.session.page, INSPECT_SCRIPT);
}

export function locate(ctx: PageTestContext, qid: string): Locator {
  return ctx.session.page.locator(qapSelector(qid)).first();
}

export async function pageState(ctx: PageTestContext) {
  return runScript<{ visibleLinks: number; openDialogs: number; url: string }>(ctx.session.page, PAGE_STATE_SCRIPT);
}

export async function stateSignature(ctx: PageTestContext, qid: string) {
  return runScript<string | null>(ctx.session.page, STATE_SIGNATURE_SCRIPT, qid);
}

export async function tryAction(action: () => Promise<unknown>): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await action();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: classifyBrowserError(error).message };
  }
}

export async function click(locator: Locator, timeoutMs = 5_000) {
  return tryAction(async () => {
    await locator.scrollIntoViewIfNeeded({ timeout: timeoutMs });
    await locator.click({ timeout: timeoutMs });
  });
}

/** Waits briefly for UI transitions (animations, async rendering) to settle. */
export async function settle(ctx: PageTestContext, ms = 400) {
  await ctx.session.page.waitForTimeout(ms);
}

export function sameDestination(a: string, b: string): boolean {
  const na = normalizeCrawlUrl(a, undefined, { queryParams: "strip-tracking" });
  const nb = normalizeCrawlUrl(b, undefined, { queryParams: "strip-tracking" });
  return !!na && na === nb;
}

export function describe(tag: string, text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t ? `${tag} "${t.slice(0, 60)}"` : tag;
}

/**
 * Tests up to `max` items found by `pick`, each starting from a freshly loaded page so one
 * interaction can never leak state into the next. Re-inspection keeps `data-qap` ids valid.
 */
export async function forEachItem<T>(
  ctx: PageTestContext,
  max: number,
  pick: (inspection: Inspection) => T[],
  test: (item: T, index: number) => Promise<CaseOutcomeLike | CaseOutcomeLike[] | null>,
): Promise<CaseOutcomeLike[]> {
  const results: CaseOutcomeLike[] = [];
  const total = Math.min(max, pick(await inspect(ctx)).length);
  for (let i = 0; i < total; i++) {
    if (ctx.isCancelled()) break;
    if (i > 0 && !(await ctx.reload())) break;
    const item = pick(await inspect(ctx))[i];
    if (!item) break;
    const r = await test(item, i);
    if (Array.isArray(r)) results.push(...r);
    else if (r) results.push(r);
  }
  if (total > 0) await ctx.reload();
  return results;
}

type CaseOutcomeLike = import("../outcome").CheckOutcome;

export async function isVisible(locator: Locator): Promise<boolean> {
  return locator.isVisible().catch(() => false);
}
