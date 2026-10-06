import type { TestModule, PageTestContext } from "../context";
import { classifyLinkKind } from "../link-check";
import { evidence, outcome, type CheckOutcome } from "../outcome";
import { click, DANGEROUS_ACTION, describe, forEachItem, inspect, isVisible, locate, MAX_ITEMS_PER_FEATURE, pageState, sameDestination, settle, spec } from "./helpers";

async function bodyText(ctx: PageTestContext) {
  return (await ctx.session.page.locator("body").innerText({ timeout: 3_000 }).catch(() => "")).slice(0, 50_000);
}

const shot = async (ctx: PageTestContext, label: string) => {
  const s = await ctx.capture(label);
  return s ? [s] : [];
};

// ---------------------------------------------------------------- filters & sorting

export const filtersModule: TestModule = {
  id: "filters",
  scope: "combo",
  async run(ctx) {
    const results: CheckOutcome[] = [];
    results.push(
      ...(await forEachItem(ctx, 2, (i) => i.selects.filter((s) => s.isSort && s.visible), async (sel) => {
        const choice = sel.options.find((o, i) => i !== sel.selectedIndex && !o.disabled && o.value !== "");
        const s = spec("filters", `sort:${sel.name || sel.qid}`, {
          title: `Sorting changes the listing: ${sel.label || sel.name}`,
          section: "Listing",
          scenarioType: "POSITIVE",
          feature: "Sorting",
          element: describe("select", sel.label || sel.name),
          testData: choice?.text,
          steps: ["Record the listing", `Choose sort option "${choice?.text}"`, "Compare URL and listing"],
          expected: "The URL or the listing order changes to reflect the chosen sort",
        });
        if (!choice) return outcome.notApplicable(s, "Sort control has no alternative option.");
        const beforeUrl = ctx.session.page.url();
        const beforeText = await bodyText(ctx);
        const nav = ctx.session.page.waitForNavigation({ timeout: 8_000 }).catch(() => null);
        await locate(ctx, sel.qid).selectOption(choice.value, { timeout: 5_000 }).catch(() => undefined);
        await nav;
        await settle(ctx, 800);
        const afterUrl = ctx.session.page.url();
        const afterText = await bodyText(ctx);
        if (afterUrl !== beforeUrl) return outcome.pass(s, `URL changed to ${afterUrl}`, [`URL ${beforeUrl} → ${afterUrl}`]);
        if (afterText !== beforeText) return outcome.pass(s, "Listing content changed after sorting", ["Rendered listing text differs after choosing the sort option"]);
        return outcome.warn(s, "Neither the URL nor the listing changed after choosing a different sort option", { evidence: await shot(ctx, "After sort") });
      })),
    );
    results.push(
      ...(await forEachItem(ctx, 3, (i) => i.filters.filter((f) => f.visible && !DANGEROUS_ACTION.test(f.text)), async (f) => {
        const s = spec("filters", `filter:${f.text || f.qid}`, {
          title: `Filter applies: ${f.text || f.kind}`,
          section: "Listing",
          scenarioType: "POSITIVE",
          feature: "Filter",
          element: describe(f.kind, f.text),
          steps: ["Record the listing", "Activate the filter", "Compare URL, control state and listing"],
          expected: "The URL, the filter state or the listing changes",
        });
        const el = locate(ctx, f.qid);
        const beforeUrl = ctx.session.page.url();
        const beforeText = await bodyText(ctx);
        const beforeChecked = f.kind === "checkbox" || f.kind === "radio" ? await el.isChecked().catch(() => null) : null;
        const nav = ctx.session.page.waitForNavigation({ timeout: 8_000 }).catch(() => null);
        const r = await click(el);
        if (!r.ok) return outcome.warn(s, `Filter could not be activated: ${r.error}`);
        const response = await nav;
        await settle(ctx, 800);
        if (response && response.status() >= 400) return outcome.fail(s, `Filter navigation returned HTTP ${response.status()}`, [evidence.http("Filter response", `URL: ${ctx.session.page.url()}\nStatus: ${response.status()}`)]);
        const changes: string[] = [];
        const afterUrl = ctx.session.page.url();
        if (afterUrl !== beforeUrl) changes.push(`URL ${beforeUrl} → ${afterUrl}`);
        if (beforeChecked !== null) {
          const afterChecked = await el.isChecked().catch(() => null);
          if (afterChecked !== beforeChecked) changes.push(`checked ${beforeChecked} → ${afterChecked}`);
        }
        if ((await bodyText(ctx)) !== beforeText) changes.push("listing content changed");
        return changes.length ? outcome.pass(s, changes.join("; "), changes) : outcome.warn(s, "No observable change after activating the filter", { evidence: await shot(ctx, "After filter") });
      })),
    );
    return results.length
      ? results
      : [outcome.notApplicable(spec("filters", "none", { title: "Filters and sorting", feature: "Filter / sorting", element: "filter / sort controls", steps: ["Inspect page"], expected: "Filters work" }), "No filter or sort controls were found.")];
  },
};

// ---------------------------------------------------------------- pagination

export const paginationModule: TestModule = {
  id: "pagination",
  scope: "combo",
  async run(ctx) {
    const results = await forEachItem(ctx, 1, (i) => i.pagination.filter((p) => p.nextQid), async (p) => {
      const s = spec("pagination", `next:${p.nextHref ?? p.nextQid}`, {
        title: "Next page control loads the next page of results",
        section: "Pagination",
        scenarioType: "POSITIVE",
        feature: "Pagination",
        element: describe("a", "next") + (p.nextHref ? ` → ${p.nextHref}` : ""),
        steps: ["Record the current listing", "Click the next-page control", "Compare URL and content"],
        expected: "A different page loads (URL changes) with different content and no error status",
      });
      const el = locate(ctx, p.nextQid!);
      if (!(await isVisible(el))) return outcome.notApplicable(s, "Pagination control is not visible at this viewport.");
      const beforeUrl = ctx.session.page.url();
      const beforeText = await bodyText(ctx);
      const nav = ctx.session.page.waitForNavigation({ timeout: ctx.options.navigationTimeoutMs }).catch(() => null);
      const r = await click(el);
      if (!r.ok) return outcome.warn(s, `Next control could not be clicked: ${r.error}`);
      const response = await nav;
      await settle(ctx, 600);
      const afterUrl = ctx.session.page.url();
      if (response && response.status() >= 400) return outcome.fail(s, `Next page returned HTTP ${response.status()}`, [evidence.http("Pagination", `URL: ${afterUrl}\nStatus: ${response.status()}`), ...(await shot(ctx, "Next page error"))]);
      const afterText = await bodyText(ctx);
      if (afterUrl !== beforeUrl && afterText !== beforeText) return outcome.pass(s, `Loaded ${afterUrl}`, [`URL ${beforeUrl} → ${afterUrl}`, "Page content differs"]);
      if (afterText !== beforeText) return outcome.pass(s, "Content changed without a URL change (client-side pagination)", ["Listing content changed after clicking next"]);
      if (afterUrl !== beforeUrl) return outcome.warn(s, `URL changed to ${afterUrl} but the content looks identical`, { evidence: await shot(ctx, "Next page") });
      return outcome.fail(s, "Clicking the next-page control changed neither the URL nor the content", [evidence.dom("Pagination", `URL stayed ${beforeUrl}; content unchanged`), ...(await shot(ctx, "Pagination unchanged"))]);
    });
    return results.length
      ? results
      : [outcome.notApplicable(spec("pagination", "none", { title: "Pagination", feature: "Pagination", element: ".pagination / rel=next", steps: ["Inspect page"], expected: "Pagination works" }), "No pagination controls were found.")];
  },
};

// ---------------------------------------------------------------- breadcrumbs

export const breadcrumbModule: TestModule = {
  id: "breadcrumb",
  scope: "combo",
  async run(ctx) {
    const insp = await inspect(ctx);
    const crumb = insp.breadcrumbs[0];
    if (!crumb) {
      return [outcome.notApplicable(spec("breadcrumb", "none", { title: "Breadcrumb trail", feature: "Breadcrumb", element: "breadcrumb", steps: ["Inspect page"], expected: "Breadcrumb works" }), "No breadcrumb trail was found on this page.")];
    }
    const results: CheckOutcome[] = [];
    const last = crumb.items[crumb.items.length - 1];
    const current = spec("breadcrumb", "current", {
      title: "Breadcrumb ends with the current page",
      section: "Breadcrumb",
      feature: "Breadcrumb",
      element: crumb.items.map((i) => i.text).join(" › "),
      steps: ["Read the breadcrumb trail", "Compare the last item with the page heading/title"],
      expected: "The last item represents the current page (aria-current or matches the page heading)",
    });
    const heading = `${insp.h1} ${insp.title}`.toLowerCase();
    if (last.current) results.push(outcome.pass(current, `Last item "${last.text}" is marked aria-current="page"`, [`aria-current on "${last.text}"`]));
    else if (last.text && heading.includes(last.text.toLowerCase())) results.push(outcome.pass(current, `Last item "${last.text}" matches the page heading`, [`"${last.text}" found in heading/title`]));
    else results.push(outcome.warn(current, `Last item "${last.text}" is not marked current and does not match the heading "${insp.h1}"`));

    const parent = [...crumb.items].reverse().find((i) => i.href && !sameDestination(i.href, ctx.url));
    if (parent?.href) {
      const s = spec("breadcrumb", `parent:${parent.href}`, {
        title: `Breadcrumb link opens: ${parent.text}`,
        section: "Breadcrumb",
        scenarioType: "POSITIVE",
        feature: "Breadcrumb",
        element: describe("a", parent.text) + ` → ${parent.href}`,
        steps: [`Click the "${parent.text}" breadcrumb`, "Verify the destination"],
        expected: `Browser navigates to ${parent.href} without an error status`,
      });
      const link = ctx.session.page.locator(`[data-qap="${crumb.qid}"] a[href]`).filter({ hasText: parent.text }).first();
      const nav = ctx.session.page.waitForNavigation({ timeout: ctx.options.navigationTimeoutMs }).catch(() => null);
      const r = await click(link);
      const response = await nav;
      const landed = ctx.session.page.url();
      if (!r.ok) results.push(outcome.warn(s, `Breadcrumb link could not be clicked: ${r.error}`));
      else if (response && response.status() >= 400) results.push(outcome.fail(s, `Destination returned HTTP ${response.status()}`, [evidence.http("Breadcrumb navigation", `URL: ${landed}\nStatus: ${response.status()}`)]));
      else if (sameDestination(landed, parent.href)) results.push(outcome.pass(s, `Navigated to ${landed}`, [`URL after click: ${landed}`]));
      else results.push(outcome.warn(s, `Navigated to ${landed} instead of ${parent.href}`));
      await ctx.reload();
    }
    return results;
  },
};

// ---------------------------------------------------------------- buttons & CTAs

export const functionalModule: TestModule = {
  id: "functional",
  scope: "combo",
  async run(ctx) {
    const results = await forEachItem(ctx, MAX_ITEMS_PER_FEATURE, (i) => i.ctas.filter((c) => c.visible && c.text), async (cta) => {
      const isLink = cta.tag === "a" && cta.href;
      const s = spec("functional", `cta:${cta.text}:${cta.href ?? ""}`, {
        title: `${isLink ? "Call-to-action" : "Button"} responds: ${cta.text}`,
        section: "Content",
        scenarioType: "FUNCTIONAL",
        feature: isLink ? "CTA link" : "Button",
        element: describe(cta.tag, cta.text) + (cta.href ? ` → ${cta.href}` : ""),
        steps: ["Click the control", "Observe URL, dialogs and page state"],
        expected: isLink ? `Navigates to ${cta.href} without an error status` : "The click produces an observable result (navigation, dialog, or state change)",
      });
      if (DANGEROUS_ACTION.test(cta.text)) return outcome.notExecuted(s, `Skipped for safety: "${cta.text}" may perform a purchase, submission or destructive action.`);
      if (isLink && classifyLinkKind(cta.href!, cta.href!, ctx.url, false) !== "internal") {
        return outcome.notExecuted(s, "External call-to-action; its destination is verified by Link Testing instead of clicking away from the site.");
      }
      const page = ctx.session.page;
      const before = await pageState(ctx);
      const beforeText = await bodyText(ctx);
      const mark = ctx.session.mark();
      const nav = page.waitForNavigation({ timeout: 8_000 }).catch(() => null);
      const r = await click(locate(ctx, cta.qid));
      if (!r.ok) return outcome.warn(s, `Control could not be clicked: ${r.error}`);
      const response = await nav;
      await settle(ctx, 600);
      const since = ctx.session.since(mark);
      const after = await pageState(ctx).catch(() => ({ url: page.url(), openDialogs: 0, visibleLinks: 0 }));
      if (since.pageErrors.length) return outcome.fail(s, `Clicking raised a script error: ${since.pageErrors[0]}`, [evidence.note("Uncaught page errors", since.pageErrors.join("\n")), ...(await shot(ctx, "After click"))]);
      if (response && response.status() >= 400) return outcome.fail(s, `Navigation returned HTTP ${response.status()}`, [evidence.http("Navigation", `URL: ${after.url}\nStatus: ${response.status()}`), ...(await shot(ctx, "Error page"))]);
      if (isLink) {
        if (sameDestination(after.url, cta.href!)) return outcome.pass(s, `Navigated to ${after.url}`, [`URL after click: ${after.url}`, ...(response ? [`HTTP ${response.status()}`] : [])]);
        if (cta.href!.includes("#") && sameDestination(cta.href!.split("#")[0], ctx.url)) return outcome.pass(s, "In-page link scrolled within the page", [`Anchor target ${cta.href}`]);
        return outcome.warn(s, `Navigated to ${after.url}, expected ${cta.href}`);
      }
      const changes: string[] = [];
      if (after.url !== before.url) changes.push(`URL ${before.url} → ${after.url}`);
      if (after.openDialogs > before.openDialogs) changes.push("a dialog opened");
      if (since.downloads.length) changes.push("a download started");
      if ((await bodyText(ctx)) !== beforeText) changes.push("page content changed");
      return changes.length
        ? outcome.pass(s, `Observed: ${changes.join("; ")}`, changes)
        : outcome.warn(s, "No observable result after clicking (the button may depend on other input)", { evidence: await shot(ctx, "After click") });
    });
    return results.length
      ? results
      : [outcome.notApplicable(spec("functional", "none", { title: "Buttons and calls to action", feature: "Button / CTA", element: "button, .btn, .cta", steps: ["Inspect page"], expected: "Buttons respond" }), "No standalone buttons or call-to-action links were found.")];
  },
};
