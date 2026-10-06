import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "playwright";
import { runScript } from "../browser-scripts";
import type { TestModule } from "../context";
import { detail } from "../details";
import { evidence, outcome, type CheckOutcome } from "../outcome";
import { spec } from "./helpers";

export const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];
export const AUTOMATED_DISCLAIMER =
  "Automated checks cover only part of WCAG; passing them does not establish WCAG compliance. Manual review (screen reader, keyboard, content, cognitive) is still required.";

interface AxeNode {
  target: unknown[];
  html: string;
  failureSummary?: string;
  impact?: string | null;
}
interface AxeRule {
  id: string;
  impact?: string | null;
  description: string;
  help: string;
  helpUrl: string;
  tags: string[];
  nodes: AxeNode[];
}

const wcagTags = (tags: string[]) => tags.filter((t) => /^wcag\d|^best-practice$/.test(t));
const IMPACTS = new Set(["critical", "serious", "moderate", "minor"]);

/** Converts axe-core results into outcomes and accessibility_results rows. */
export function axeToOutcomes(result: { violations: AxeRule[]; incomplete: AxeRule[]; passes: AxeRule[]; testEngine: { version: string } }, ctx: { browser: string; viewport: string }): CheckOutcome[] {
  const out: CheckOutcome[] = [];
  const ruleSpec = (rule: AxeRule) =>
    spec("accessibility", `axe:${rule.id}`, {
      title: `Accessibility rule: ${rule.help}`,
      section: "Accessibility",
      feature: rule.id,
      element: `${rule.nodes.length} element(s)`,
      steps: [`Run axe-core ${result.testEngine.version} on the rendered page`, `Evaluate rule "${rule.id}" (${wcagTags(rule.tags).join(", ") || "no WCAG tag"})`],
      expected: rule.description,
      expectationSource: "BROWSER_STANDARD",
    });
  const rows = (rule: AxeRule, status: string) =>
    rule.nodes.slice(0, 50).map((n) =>
      detail("accessibility_results", {
        rule_id: rule.id,
        impact: IMPACTS.has(String(n.impact ?? rule.impact)) ? String(n.impact ?? rule.impact) : null,
        description: rule.help,
        help_url: rule.helpUrl,
        target_selector: n.target.map(String).join(" "),
        html_snippet: n.html.slice(0, 2000),
        wcag_tags: JSON.stringify(wcagTags(rule.tags)),
        status,
        browser: ctx.browser,
        viewport: ctx.viewport,
        failure_summary: n.failureSummary ?? null,
        source: "AXE",
      }),
    );
  const nodeList = (rule: AxeRule) => rule.nodes.slice(0, 15).map((n) => `${n.target.map(String).join(" ")}\n  ${n.html.slice(0, 200)}${n.failureSummary ? `\n  ${n.failureSummary.replace(/\n/g, " ")}` : ""}`).join("\n");

  for (const rule of result.violations) {
    out.push(
      outcome.fail(ruleSpec(rule), `axe-core violation (${rule.impact ?? "unknown"} impact) on ${rule.nodes.length} element(s): ${rule.help}. ${AUTOMATED_DISCLAIMER}`, [
        evidence.dom(`axe-core: ${rule.id}`, `${rule.helpUrl}\n${nodeList(rule)}`),
      ], { details: rows(rule, "FAIL") }),
    );
  }
  for (const rule of result.incomplete) {
    out.push(
      outcome.warn(ruleSpec(rule), `axe-core could not decide automatically for ${rule.nodes.length} element(s); manual review required: ${rule.help}`, {
        evidence: [evidence.dom(`axe-core needs review: ${rule.id}`, `${rule.helpUrl}\n${nodeList(rule)}`)],
        details: rows(rule, "WARNING"),
      }),
    );
  }
  out.push(
    outcome.pass(
      spec("accessibility", "axe:passes", {
        title: "Automated accessibility rules passed",
        section: "Accessibility",
        feature: "axe-core",
        element: "page",
        steps: [`Run axe-core ${result.testEngine.version} (${AXE_TAGS.join(", ")})`],
        expected: "Applicable automated rules pass",
        expectationSource: "BROWSER_STANDARD",
      }),
      `${result.passes.length} automated rule(s) passed, ${result.violations.length} failed, ${result.incomplete.length} need review. ${AUTOMATED_DISCLAIMER}`,
      [`axe-core passes: ${result.passes.map((p) => p.id).slice(0, 40).join(", ")}`],
    ),
  );
  return out;
}

interface FocusStep {
  index: number;
  tag: string;
  text: string;
  selector: string;
  changed: string[];
}

const FOCUS_BASELINE_SCRIPT = String.raw`() => {
  const list = Array.from(document.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, [tabindex]:not([tabindex="-1"])'))
    .filter((el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && !el.disabled; })
    .slice(0, 60);
  const props = ["outlineStyle", "outlineWidth", "outlineColor", "boxShadow", "borderColor", "backgroundColor", "color", "textDecorationLine"];
  window.__qapFocus = list.map((el, i) => { el.setAttribute("data-qap-focus", String(i)); const s = getComputedStyle(el); return Object.fromEntries(props.map((p) => [p, s[p]])); });
  return list.length;
}`;

const FOCUS_READ_SCRIPT = String.raw`() => {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  const idx = el.getAttribute("data-qap-focus");
  const s = getComputedStyle(el);
  const base = idx !== null && window.__qapFocus ? window.__qapFocus[Number(idx)] : null;
  const changed = base ? Object.keys(base).filter((p) => base[p] !== s[p] && !(p === "outlineStyle" && s[p] === "none")) : [];
  const visibleOutline = s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0;
  if (visibleOutline && !changed.includes("outlineStyle")) changed.push("outline");
  return { index: idx === null ? -1 : Number(idx), tag: el.tagName.toLowerCase(), text: (el.innerText || el.getAttribute("aria-label") || el.getAttribute("name") || "").trim().slice(0, 60),
    selector: el.id ? "#" + el.id : el.tagName.toLowerCase() + (el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/)[0] : ""), changed };
}`;

/** Presses Tab through the page and records whether each focused element shows a visible change. */
export async function probeKeyboardFocus(page: Page, presses = 15): Promise<{ focusable: number; steps: FocusStep[] }> {
  const focusable = await runScript<number>(page, FOCUS_BASELINE_SCRIPT);
  await page.locator("body").click({ position: { x: 1, y: 1 }, timeout: 2_000 }).catch(() => undefined);
  const steps: FocusStep[] = [];
  for (let i = 0; i < Math.min(presses, focusable + 2); i++) {
    await page.keyboard.press("Tab");
    await page.waitForTimeout(60);
    const step = await runScript<FocusStep | null>(page, FOCUS_READ_SCRIPT);
    if (step) steps.push(step);
  }
  return { focusable, steps };
}

export const accessibilityModule: TestModule = {
  id: "accessibility",
  scope: "page",
  async run(ctx) {
    const page = ctx.session.page;
    let axe;
    try {
      axe = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    } catch (error) {
      return [
        outcome.notExecuted(
          spec("accessibility", "axe:error", { title: "Automated accessibility rules", feature: "axe-core", element: "page", steps: [], expected: "axe-core runs" }),
          `axe-core could not run on this page: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
        ),
      ];
    }
    const results = axeToOutcomes(axe as never, { browser: ctx.browser, viewport: ctx.viewport.id });

    ctx.setCurrentTest("Keyboard focus probe");
    await ctx.reload();
    const { focusable, steps } = await probeKeyboardFocus(ctx.session.page);
    const kbSpec = (key: string, title: string, expected: string) =>
      spec("accessibility", `keyboard:${key}`, { title, section: "Accessibility", feature: "Keyboard", element: "focusable elements", steps: ["Press Tab repeatedly from the top of the page", "Compare each focused element's styles with its unfocused styles"], expected, expectationSource: "BROWSER_STANDARD" });
    if (focusable === 0) {
      results.push(outcome.notApplicable(kbSpec("reach", "Keyboard focus reaches interactive elements", "Tab moves focus through interactive elements"), "No focusable elements on the page."));
      return results;
    }
    const distinct = new Set(steps.map((s) => `${s.index}|${s.selector}`));
    const reach = kbSpec("reach", "Keyboard focus reaches interactive elements", "Tab moves focus through distinct interactive elements without getting stuck");
    if (steps.length === 0) results.push(outcome.warn(reach, `No element received focus after pressing Tab (${focusable} focusable elements on the page)`));
    else if (distinct.size === 1 && steps.length > 3) {
      results.push(outcome.warn(reach, `Focus stayed on ${steps[0].selector} for ${steps.length} Tab presses (possible keyboard trap)`, { evidence: [evidence.dom("Focus sequence", steps.map((s) => s.selector).join(" → "))] }));
    } else results.push(outcome.pass(reach, `Focus moved through ${distinct.size} distinct elements in ${steps.length} Tab presses`, [`Focus sequence: ${steps.slice(0, 8).map((s) => s.selector).join(" → ")}`]));

    const indicator = kbSpec("indicator", "Focused elements show a visible focus indicator", "Each keyboard-focused element visibly changes (outline, shadow, border, colour or underline)");
    const invisible = steps.filter((s) => s.changed.length === 0);
    const rows = steps.map((s) =>
      detail("accessibility_results", {
        rule_id: "focus-visible-probe",
        impact: s.changed.length ? null : "serious",
        description: "Visible keyboard focus indicator",
        help_url: "https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html",
        target_selector: s.selector,
        html_snippet: `<${s.tag}> ${s.text}`,
        wcag_tags: JSON.stringify(["wcag2aa", "wcag247"]),
        status: s.changed.length ? "PASS" : "WARNING",
        browser: ctx.browser,
        viewport: ctx.viewport.id,
        failure_summary: s.changed.length ? `Changed on focus: ${s.changed.join(", ")}` : "No style change detected on focus",
        source: "KEYBOARD_PROBE",
      }),
    );
    if (!steps.length) results.push(outcome.notExecuted(indicator, "No element received keyboard focus, so focus indicators could not be measured."));
    else if (invisible.length) {
      // Visual focus indicators can be drawn in ways styles do not reveal (e.g. pseudo-elements), so this is a review item.
      results.push(outcome.warn(indicator, `${invisible.length} of ${steps.length} focused element(s) showed no measurable style change, e.g. ${invisible[0].selector}`, { evidence: [evidence.dom("Elements without a measured focus change", invisible.map((s) => `${s.selector} "${s.text}"`).join("\n"))], details: rows }));
    } else results.push(outcome.pass(indicator, `All ${steps.length} focused elements changed style on focus`, steps.slice(0, 5).map((s) => `${s.selector}: ${s.changed.join(", ")}`), { details: rows }));
    return results;
  },
};
