import { VIEWPORTS } from "@/lib/constants/testing";
import type { Viewport } from "@/types";
import type { PageTestContext, TestModule } from "../context";
import { detail } from "../details";
import { analyzeLayout, LAYOUT_CHECKS, measureLayout, RESPONSIVE_CHECKS, UI_CHECKS, type LayoutCheckKey, type LayoutMeasurement } from "../layout";
import { evidence, outcome, type CheckOutcome } from "../outcome";
import { settle, spec } from "./helpers";

const MAX_ISSUES_LISTED = 20;

function failedImageUrls(ctx: PageTestContext): Set<string> {
  return new Set(ctx.session.network.filter((n) => n.resourceType === "image" && (n.failure || (n.status !== null && n.status >= 400))).map((n) => n.url));
}

async function layoutOutcomes(
  ctx: PageTestContext,
  m: LayoutMeasurement,
  checks: LayoutCheckKey[],
  category: "UI" | "RESPONSIVE",
  viewport: Viewport,
): Promise<CheckOutcome[]> {
  const moduleId = category === "UI" ? "ui" : "responsive";
  const vpLabel = `${viewport.width}×${viewport.height}`;
  const analysis = analyzeLayout(m, checks, failedImageUrls(ctx));
  const results: CheckOutcome[] = [];
  let shot: Awaited<ReturnType<PageTestContext["capture"]>> | undefined;

  for (const [key, issues] of analysis) {
    const def = LAYOUT_CHECKS[key];
    const s = spec(moduleId, `${key}:${viewport.id}`, {
      title: category === "RESPONSIVE" ? `${def.title} at ${vpLabel}` : def.title,
      section: category === "UI" ? "Layout" : `Responsive ${viewport.kind}`,
      feature: category === "UI" ? "UI inspection" : "Responsive layout",
      element: issues[0]?.selector ?? "page",
      steps: [`Render the page at ${vpLabel}`, "Scroll through the page to load lazy content", "Measure element boxes, computed styles and image dimensions"],
      expected: def.expected,
      expectationSource: def.expectationSource,
    });
    const statusForRows = issues.length ? def.severity : "PASS";
    const details = (issues.length ? issues : [null]).slice(0, MAX_ISSUES_LISTED).map((issue) =>
      detail("ui_results", {
        category,
        check_key: key,
        selector: issue?.selector ?? null,
        browser: ctx.browser,
        viewport: viewport.id,
        observed: JSON.stringify(issue?.observed ?? { checked: true }),
        message: issue?.message ?? "No issue measured",
        status: statusForRows,
        element_text: issue?.text ?? null,
      }),
    );
    if (!issues.length) {
      results.push({ ...outcome.pass(s, `No issue measured at ${vpLabel}`, [verificationFor(key, m)], { details }), viewportOverride: viewport.id });
      continue;
    }
    shot ??= await ctx.capture(`${category === "UI" ? "UI" : "Responsive"} issues at ${vpLabel}`);
    const list = issues.slice(0, MAX_ISSUES_LISTED).map((i) => `${i.selector}: ${i.message}`).join("\n");
    const ev = [evidence.dom(`${issues.length} measured issue(s)`, list), ...(shot ? [shot] : [])];
    const actual = `${issues.length} issue(s) at ${vpLabel}. ${issues[0].message}`;
    results.push({
      ...(def.severity === "FAIL" ? outcome.fail(s, actual, ev, { details }) : outcome.warn(s, actual, { evidence: ev, details })),
      viewportOverride: viewport.id,
    });
  }
  return results;
}

function verificationFor(key: LayoutCheckKey, m: LayoutMeasurement): string {
  switch (key) {
    case "horizontal-overflow":
      return `scrollWidth ${m.doc.scrollWidth} ≤ clientWidth ${m.doc.clientWidth}`;
    case "broken-images":
    case "distorted-images":
    case "missing-image-source":
      return `${m.images.length} image(s) measured`;
    case "mobile-navigation":
      return `${m.visibleNavLinks} visible navigation link(s) in ${m.navLinkRows} row(s); menu toggle visible: ${m.menuToggleVisible}`;
    case "header":
      return m.header ? `Header ${m.header.rect.w}×${m.header.rect.h}px in a ${m.viewport.width}×${m.viewport.height} viewport` : "No header element present";
    case "footer":
      return m.footer ? `Footer starts ${-m.footer.overlapsContent}px relative to the end of the main content` : "No footer element present";
    case "grid-consistency":
    case "alignment":
    case "spacing":
      return `${m.groups.length} repeated-item group(s) measured`;
    default:
      return `Measured at ${m.viewport.width}×${m.viewport.height}: no element met the issue criteria`;
  }
}

/** UI inspection at the run's own browser and viewport. */
export const uiModule: TestModule = {
  id: "ui",
  scope: "combo",
  async run(ctx) {
    const m = await measureLayout(ctx.session.page);
    return layoutOutcomes(ctx, m, UI_CHECKS, "UI", ctx.viewport);
  },
};

/**
 * Responsive testing across all six standard viewports (3 desktop, 3 mobile), in the first
 * browser of the run. The window is resized in place, so pages are re-measured after relayout.
 */
export const responsiveModule: TestModule = {
  id: "responsive",
  scope: "page",
  async run(ctx) {
    const page = ctx.session.page;
    const original = page.viewportSize();
    const results: CheckOutcome[] = [];
    try {
      for (const viewport of VIEWPORTS) {
        if (ctx.isCancelled()) break;
        ctx.setCurrentTest(`Responsive ${viewport.width}×${viewport.height}`);
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await settle(ctx, 600);
        const m = await measureLayout(page, { autoscroll: viewport === VIEWPORTS[0] });
        results.push(...(await layoutOutcomes(ctx, m, RESPONSIVE_CHECKS, "RESPONSIVE", viewport)));
      }
    } finally {
      if (original) await page.setViewportSize(original).catch(() => undefined);
    }
    return results;
  },
};
