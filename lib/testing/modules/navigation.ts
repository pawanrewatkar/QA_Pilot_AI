import type { TestModule, PageTestContext } from "../context";
import { classifyLinkKind } from "../link-check";
import { evidence, outcome, type CheckOutcome } from "../outcome";
import type { InspectedToggle } from "../browser-scripts";
import { click, DANGEROUS_ACTION, describe, inspect, isVisible, locate, MAX_ITEMS_PER_FEATURE, pageState, sameDestination, settle, spec } from "./helpers";

async function testMenuToggle(ctx: PageTestContext, toggle: InspectedToggle): Promise<CheckOutcome> {
  const page = ctx.session.page;
  const s = spec("navigation", `menu-toggle:${toggle.qid}`, {
    title: "Menu toggle opens and closes the navigation",
    section: "Header",
    feature: "Hamburger menu",
    element: describe("button", toggle.text || "menu toggle"),
    steps: ["Click the menu toggle", "Observe the navigation", "Click the toggle again"],
    expected: "First click reveals the menu (aria-expanded=true or more visible links); second click hides it again",
  });
  const locator = locate(ctx, toggle.qid);
  const before = await pageState(ctx);
  const beforeExpanded = await locator.getAttribute("aria-expanded").catch(() => null);
  const controlled = toggle.controls ? page.locator(`[id="${toggle.controls}"]`).first() : null;
  const controlledBefore = controlled ? await isVisible(controlled) : null;

  const opened = await click(locator);
  if (!opened.ok) return outcome.warn(s, `Could not click the menu toggle: ${opened.error}`);
  await settle(ctx, 500);
  const after = await pageState(ctx);
  const afterExpanded = await locator.getAttribute("aria-expanded").catch(() => null);
  const controlledAfter = controlled ? await isVisible(controlled) : null;

  const changes: string[] = [];
  if (beforeExpanded !== afterExpanded) changes.push(`aria-expanded changed ${beforeExpanded} → ${afterExpanded}`);
  if (controlledBefore === false && controlledAfter === true) changes.push(`#${toggle.controls} became visible`);
  if (after.visibleLinks > before.visibleLinks) changes.push(`visible links increased ${before.visibleLinks} → ${after.visibleLinks}`);
  if (after.url !== before.url) return outcome.warn(s, `Clicking the toggle navigated to ${after.url} instead of opening a menu`);

  if (changes.length === 0) {
    const shot = await ctx.capture("Menu after clicking toggle");
    const ev = [evidence.dom("Observed state", `aria-expanded: ${beforeExpanded} → ${afterExpanded}\nvisible links: ${before.visibleLinks} → ${after.visibleLinks}`), ...(shot ? [shot] : [])];
    return toggle.strong
      ? outcome.fail(s, "Clicking the menu toggle produced no visible change (aria-expanded and visible links unchanged)", ev)
      : outcome.warn(s, "No observable change after clicking a likely menu toggle; manual review needed", { evidence: ev });
  }
  const openShot = await ctx.capture("Menu opened");

  await click(locator);
  await settle(ctx, 500);
  const closedExpanded = await locator.getAttribute("aria-expanded").catch(() => null);
  const closed = await pageState(ctx);
  const closedOk = (beforeExpanded !== null && closedExpanded === beforeExpanded) || closed.visibleLinks <= before.visibleLinks;
  if (!closedOk) {
    return outcome.warn(s, `Menu opened (${changes.join("; ")}) but did not close on the second click`, { verifications: changes, evidence: openShot ? [openShot] : [] });
  }
  return outcome.pass(s, `Menu opened and closed: ${changes.join("; ")}`, [...changes, `Second click restored state (aria-expanded=${closedExpanded}, visible links ${closed.visibleLinks})`], { evidence: openShot ? [openShot] : [] });
}

export const navigationModule: TestModule = {
  id: "navigation",
  scope: "combo",
  async run(ctx) {
    const results: CheckOutcome[] = [];
    let inspection = await inspect(ctx);

    const presence = spec("navigation", "presence", {
      title: "Site navigation is present",
      section: "Header",
      feature: "Navigation",
      element: "nav / header links",
      steps: ["Open the page", "Locate navigation landmarks and header links"],
      expected: "Navigation links are available to the user (visible directly or through a menu toggle)",
    });
    const navLinks = inspection.links.filter((l) => (l.source === "navigation" || l.source === "header") && classifyLinkKind(l.rawHref, l.href, ctx.url, l.download) === "internal");
    const visibleNav = navLinks.filter((l) => l.visible);
    const visibleToggles = inspection.menuToggles.filter((t) => t.visible);
    if (inspection.navContainers === 0 && navLinks.length === 0) {
      results.push(outcome.notApplicable(presence, "No navigation landmark or header links found on this page."));
    } else if (visibleNav.length > 0) {
      results.push(outcome.pass(presence, `${visibleNav.length} navigation links visible`, [`${visibleNav.length} visible internal links in header/nav`]));
    } else if (visibleToggles.length > 0) {
      results.push(outcome.pass(presence, "Navigation is collapsed behind a menu toggle at this viewport", [`Menu toggle visible: ${visibleToggles[0].text || visibleToggles[0].qid}`]));
    } else {
      const shot = await ctx.capture("Page without visible navigation");
      results.push(outcome.warn(presence, `Navigation markup exists (${navLinks.length} links) but no navigation link or menu toggle is visible at ${ctx.viewport.width}×${ctx.viewport.height}`, { evidence: shot ? [shot] : [] }));
    }

    // Hamburger / menu toggles.
    for (const toggle of visibleToggles.slice(0, 2)) {
      if (ctx.isCancelled()) return results;
      ctx.setCurrentTest(`Menu toggle ${toggle.text}`);
      await inspect(ctx);
      results.push(await testMenuToggle(ctx, toggle));
      if (!(await ctx.reload())) return results;
    }

    // Navigation link destinations (positive navigation).
    inspection = await inspect(ctx);
    const candidates = inspection.links
      .filter((l) => (l.source === "navigation" || l.source === "header") && l.visible && !l.download && l.target !== "_blank")
      .filter((l) => classifyLinkKind(l.rawHref, l.href, ctx.url, false) === "internal" && !DANGEROUS_ACTION.test(l.text) && !sameDestination(l.href, ctx.url));
    const unique = candidates.filter((l, i) => candidates.findIndex((x) => sameDestination(x.href, l.href)) === i).slice(0, MAX_ITEMS_PER_FEATURE);
    for (const link of unique) {
      if (ctx.isCancelled()) break;
      ctx.setCurrentTest(`Navigate: ${link.text || link.href}`);
      await inspect(ctx); // re-tag after the previous reload (ids are deterministic)
      const s = spec("navigation", `nav-link:${link.href}`, {
        title: `Navigation link opens its destination: ${link.text || link.href}`,
        section: link.source === "header" ? "Header" : "Navigation",
        scenarioType: "POSITIVE",
        feature: "Navigation link",
        element: describe("a", link.text) + ` → ${link.href}`,
        steps: ["Click the navigation link", "Wait for navigation", "Verify the resulting URL and response"],
        expected: `Browser navigates to ${link.href} and the page loads without an error status`,
      });
      const locator = locate(ctx, link.qid);
      const page = ctx.session.page;
      const responsePromise = page.waitForNavigation({ timeout: ctx.options.navigationTimeoutMs, waitUntil: "domcontentloaded" }).catch(() => null);
      const clicked = await click(locator);
      if (!clicked.ok) {
        results.push(outcome.warn(s, `Link could not be clicked: ${clicked.error}`));
        await ctx.reload();
        continue;
      }
      const response = await responsePromise;
      await settle(ctx, 200);
      const landed = page.url();
      const status = response?.status() ?? null;
      if (!response && sameDestination(landed, ctx.url)) {
        const shot = await ctx.capture("No navigation after click");
        results.push(outcome.warn(s, "Clicking the link did not navigate (it may open a sub-menu)", { evidence: shot ? [shot] : [] }));
      } else if (status !== null && status >= 400) {
        const shot = await ctx.capture(`Destination returned HTTP ${status}`);
        results.push(outcome.fail(s, `Navigated to ${landed} but it returned HTTP ${status}`, [evidence.http("Navigation response", `URL: ${landed}\nStatus: ${status}`), ...(shot ? [shot] : [])]));
      } else if (sameDestination(landed, link.href)) {
        results.push(outcome.pass(s, `Navigated to ${landed}${status ? ` (HTTP ${status})` : ""}`, [`URL after click: ${landed}`, ...(status ? [`Response status ${status}`] : [])]));
      } else {
        results.push(outcome.warn(s, `Navigated to ${landed}, which differs from the link target ${link.href} (redirect?)`, { verifications: [`URL after click: ${landed}`] }));
      }
      if (!(await ctx.reload())) break;
    }
    return results;
  },
};
