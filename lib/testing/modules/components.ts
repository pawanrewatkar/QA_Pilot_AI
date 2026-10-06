import type { TestModule, PageTestContext } from "../context";
import { evidence, outcome, type CheckOutcome } from "../outcome";
import type { InspectedToggle } from "../browser-scripts";
import { click, DANGEROUS_ACTION, describe, forEachItem, isVisible, locate, MAX_ITEMS_PER_FEATURE, pageState, settle, spec, stateSignature } from "./helpers";

const none = (module: string, feature: string, element: string, reason: string) =>
  outcome.notApplicable(spec(module, "none", { title: `${feature} behaviour`, feature, element, steps: ["Inspect the page"], expected: `${feature} works` }), reason);

async function shot(ctx: PageTestContext, label: string) {
  const s = await ctx.capture(label);
  return s ? [s] : [];
}

async function expandedState(ctx: PageTestContext, toggle: InspectedToggle) {
  const page = ctx.session.page;
  const el = locate(ctx, toggle.qid);
  const expanded = await el.getAttribute("aria-expanded").catch(() => null);
  const target = toggle.controls ? page.locator(`[id="${toggle.controls}"]`).first() : null;
  const targetVisible = target ? await isVisible(target) : null;
  return { expanded, targetVisible };
}

// ---------------------------------------------------------------- dropdowns

export const dropdownsModule: TestModule = {
  id: "dropdowns",
  scope: "combo",
  async run(ctx) {
    const results: CheckOutcome[] = [];
    const selects = (i: import("../browser-scripts").Inspection) => i.selects.filter((s) => s.visible && !s.isSort && s.options.filter((o) => !o.disabled).length >= 2);
    results.push(
      ...(await forEachItem(ctx, MAX_ITEMS_PER_FEATURE, selects, async (sel) => {
        const choices = sel.options.map((o, i) => ({ ...o, i })).filter((o) => !o.disabled && o.i !== sel.selectedIndex && o.value !== "");
        const choice = choices[0];
        const s = spec("dropdowns", `select:${sel.name || sel.qid}`, {
          title: `Dropdown accepts a selection: ${sel.label || sel.name || "select"}`,
          section: sel.inForm ? "Form" : "Page",
          scenarioType: "POSITIVE",
          feature: "Dropdown (select)",
          element: describe("select", sel.label || sel.name),
          steps: ["Open the dropdown", `Choose "${choice?.text ?? "another option"}"`, "Read the selected value"],
          expected: "The chosen option becomes the selected value",
          testData: choice ? `${choice.text} (${choice.value})` : undefined,
        });
        if (!choice) return outcome.notApplicable(s, "Dropdown has no other selectable option.");
        const el = locate(ctx, sel.qid);
        const before = ctx.session.page.url();
        const r = await tryChoose(el, choice.value);
        if (!r.ok) return outcome.warn(s, `Option could not be selected: ${r.error}`);
        await settle(ctx, 300);
        const after = ctx.session.page.url();
        if (after !== before) return outcome.pass(s, `Selection navigated to ${after}`, [`Selected "${choice.text}"`, `URL changed ${before} → ${after}`]);
        const value = await el.inputValue().catch(() => null);
        return value === choice.value
          ? outcome.pass(s, `Selected value is "${value}"`, [`select.value changed to "${value}"`])
          : outcome.fail(s, `Selected value is "${value}" after choosing "${choice.value}"`, [evidence.dom("Select state", `expected value: ${choice.value}\nactual value: ${value}`), ...(await shot(ctx, "Dropdown after selection"))]);
      })),
    );

    results.push(
      ...(await forEachItem(ctx, MAX_ITEMS_PER_FEATURE, (i) => i.popupToggles.filter((t) => t.visible && !DANGEROUS_ACTION.test(t.text)), async (toggle) => {
        const out: CheckOutcome[] = [];
        const s = spec("dropdowns", `popup:${toggle.text || toggle.qid}`, {
          title: `Custom dropdown opens: ${toggle.text || "menu"}`,
          feature: "Dropdown (custom)",
          element: describe("button", toggle.text),
          steps: ["Click the dropdown trigger", "Observe the popup"],
          expected: "The dropdown popup becomes visible / aria-expanded becomes true",
        });
        const before = await expandedState(ctx, toggle);
        const r = await click(locate(ctx, toggle.qid));
        if (!r.ok) return outcome.warn(s, `Trigger could not be clicked: ${r.error}`);
        await settle(ctx);
        const after = await expandedState(ctx, toggle);
        const changes = [
          before.expanded !== after.expanded ? `aria-expanded ${before.expanded} → ${after.expanded}` : null,
          before.targetVisible === false && after.targetVisible ? `#${toggle.controls} became visible` : null,
        ].filter((c): c is string => !!c);
        if (!changes.length) {
          const ev = [evidence.dom("Observed", `aria-expanded: ${before.expanded} → ${after.expanded}; popup visible: ${before.targetVisible} → ${after.targetVisible}`), ...(await shot(ctx, "Dropdown after click"))];
          out.push(toggle.strong ? outcome.fail(s, "Clicking the dropdown trigger did not open it", ev) : outcome.warn(s, "No observable change after clicking the trigger", { evidence: ev }));
          return out;
        }
        out.push(outcome.pass(s, `Dropdown opened: ${changes.join("; ")}`, changes, { evidence: await shot(ctx, "Dropdown open") }));

        const close = spec("dropdowns", `popup-escape:${toggle.text || toggle.qid}`, {
          title: `Custom dropdown closes with Escape: ${toggle.text || "menu"}`,
          feature: "Dropdown (custom)",
          element: describe("button", toggle.text),
          steps: ["Open the dropdown", "Press Escape"],
          expected: "The popup closes (WAI-ARIA menu/listbox convention)",
        });
        await ctx.session.page.keyboard.press("Escape");
        await settle(ctx);
        const closed = await expandedState(ctx, toggle);
        const closedOk = (after.expanded !== null && closed.expanded === before.expanded) || (after.targetVisible === true && closed.targetVisible === false);
        out.push(closedOk ? outcome.pass(close, "Popup closed after Escape", [`aria-expanded ${after.expanded} → ${closed.expanded}`]) : outcome.warn(close, "Popup stayed open after pressing Escape; review keyboard support", { evidence: await shot(ctx, "After Escape") }));
        return out;
      })),
    );

    return results.length ? results : [none("dropdowns", "Dropdown", "select / [aria-haspopup]", "No interactive dropdowns were found at this viewport.")];
  },
};

async function tryChoose(el: import("playwright").Locator, value: string) {
  try {
    await el.selectOption(value, { timeout: 5_000 });
    return { ok: true as const };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message.split("\n")[0] : String(error) };
  }
}

// ---------------------------------------------------------------- tabs

export const tabsModule: TestModule = {
  id: "tabs",
  scope: "combo",
  async run(ctx) {
    const results = await forEachItem(ctx, 3, (i) => i.tablists, async (tabs, index) => {
      const out: CheckOutcome[] = [];
      const target = tabs.find((t) => !t.selected) ?? tabs[1];
      const previous = tabs.find((t) => t.selected);
      const s = spec("tabs", `tablist-${index}:${target.label}`, {
        title: `Selecting a tab shows its panel: ${target.label}`,
        feature: "Tabs",
        element: describe('[role="tab"]', target.label),
        steps: [`Click the "${target.label}" tab`, "Check aria-selected and the associated tab panel"],
        expected: "The clicked tab becomes selected (aria-selected=true) and its panel is visible",
      });
      const tabEl = locate(ctx, target.qid);
      if (!(await isVisible(tabEl))) return outcome.notApplicable(s, "Tab list is not visible at this viewport.");
      const r = await click(tabEl);
      if (!r.ok) return outcome.warn(s, `Tab could not be clicked: ${r.error}`);
      await settle(ctx, 300);
      const selected = await tabEl.getAttribute("aria-selected").catch(() => null);
      const panel = target.controls ? ctx.session.page.locator(`[id="${target.controls}"]`).first() : null;
      const panelVisible = panel ? await isVisible(panel) : null;
      const prevSelected = previous ? await locate(ctx, previous.qid).getAttribute("aria-selected").catch(() => null) : null;
      const verifications = [`aria-selected="${selected}" on "${target.label}"`];
      if (panel) verifications.push(`panel #${target.controls} visible: ${panelVisible}`);
      if (previous) verifications.push(`previous tab "${previous.label}" aria-selected="${prevSelected}"`);
      if (selected === "true" && panelVisible !== false) out.push(outcome.pass(s, `"${target.label}" selected${panel ? " and its panel is visible" : ""}`, verifications));
      else out.push(outcome.fail(s, `After clicking, aria-selected="${selected}"${panel ? `, panel visible: ${panelVisible}` : ""}`, [evidence.dom("Tab state", verifications.join("\n")), ...(await shot(ctx, "Tabs after click"))]));

      const kb = spec("tabs", `tablist-${index}:keyboard`, {
        title: "Arrow keys move between tabs",
        feature: "Tabs",
        element: describe('[role="tablist"]', tabs.map((t) => t.label).join(" | ")),
        steps: ["Focus the selected tab", "Press ArrowRight"],
        expected: "Focus moves to the next tab (WAI-ARIA tabs pattern)",
      });
      await tabEl.focus().catch(() => undefined);
      await ctx.session.page.keyboard.press("ArrowRight");
      await settle(ctx, 200);
      const focusedQid = await ctx.session.page.evaluate("document.activeElement && document.activeElement.getAttribute('data-qap')").catch(() => null);
      const moved = focusedQid && focusedQid !== target.qid && tabs.some((t) => t.qid === focusedQid);
      out.push(moved ? outcome.pass(kb, "Focus moved to the next tab", [`Focused element after ArrowRight: ${focusedQid}`]) : outcome.warn(kb, "ArrowRight did not move focus to another tab; keyboard support should be reviewed"));
      return out;
    });
    return results.length ? results : [none("tabs", "Tabs", '[role="tablist"]', "No ARIA tab lists were found on this page.")];
  },
};

// ---------------------------------------------------------------- accordions

export const accordionModule: TestModule = {
  id: "accordion",
  scope: "combo",
  async run(ctx) {
    const results: CheckOutcome[] = [];
    results.push(
      ...(await forEachItem(ctx, MAX_ITEMS_PER_FEATURE, (i) => i.details.filter((d) => d.visible), async (d) => {
        const s = spec("accordion", `details:${d.text}`, {
          title: `Disclosure toggles: ${d.text}`,
          feature: "Accordion (details/summary)",
          element: describe("summary", d.text),
          steps: ["Click the summary", "Check the open state", "Click again"],
          expected: "First click toggles the section open state; second click restores it",
        });
        const details = locate(ctx, d.detailsQid);
        const summary = locate(ctx, d.summaryQid);
        const before = (await details.getAttribute("open").catch(() => null)) !== null;
        const r = await click(summary);
        if (!r.ok) return outcome.warn(s, `Summary could not be clicked: ${r.error}`);
        await settle(ctx, 250);
        const mid = (await details.getAttribute("open").catch(() => null)) !== null;
        await click(summary);
        await settle(ctx, 250);
        const end = (await details.getAttribute("open").catch(() => null)) !== null;
        const ok = mid !== before && end === before;
        return ok
          ? outcome.pass(s, `Open state ${before} → ${mid} → ${end}`, [`details[open] ${before} → ${mid}`, `second click restored ${end}`])
          : outcome.fail(s, `Open state did not toggle as expected (${before} → ${mid} → ${end})`, [evidence.dom("details open state", `${before} → ${mid} → ${end}`), ...(await shot(ctx, "Accordion state"))]);
      })),
    );
    results.push(
      ...(await forEachItem(ctx, MAX_ITEMS_PER_FEATURE, (i) => i.accordions.filter((a) => a.visible && !DANGEROUS_ACTION.test(a.text)), async (acc) => {
        const s = spec("accordion", `aria:${acc.text || acc.qid}`, {
          title: `Accordion section expands and collapses: ${acc.text}`,
          feature: "Accordion",
          element: describe("button", acc.text),
          steps: ["Click the accordion header", "Check aria-expanded and the panel", "Click again"],
          expected: "Panel visibility and aria-expanded toggle on each click",
        });
        const before = await expandedState(ctx, acc);
        const r = await click(locate(ctx, acc.qid));
        if (!r.ok) return outcome.warn(s, `Header could not be clicked: ${r.error}`);
        await settle(ctx);
        const mid = await expandedState(ctx, acc);
        await click(locate(ctx, acc.qid));
        await settle(ctx);
        const end = await expandedState(ctx, acc);
        const toggled = mid.expanded !== before.expanded || mid.targetVisible !== before.targetVisible;
        const restored = end.expanded === before.expanded && end.targetVisible === before.targetVisible;
        const trace = `aria-expanded ${before.expanded} → ${mid.expanded} → ${end.expanded}; panel visible ${before.targetVisible} → ${mid.targetVisible} → ${end.targetVisible}`;
        if (toggled && restored) return outcome.pass(s, trace, [trace]);
        if (toggled) return outcome.warn(s, `Section opened but did not collapse again: ${trace}`, { verifications: [trace] });
        const ev = [evidence.dom("Accordion state", trace), ...(await shot(ctx, "Accordion after click"))];
        return acc.strong ? outcome.fail(s, `No state change after clicking: ${trace}`, ev) : outcome.warn(s, `No state change after clicking: ${trace}`, { evidence: ev });
      })),
    );
    return results.length ? results : [none("accordion", "Accordion", "details / [aria-expanded][aria-controls]", "No accordions or disclosure widgets were found.")];
  },
};

// ---------------------------------------------------------------- modals

export const modalsModule: TestModule = {
  id: "modals",
  scope: "combo",
  async run(ctx) {
    const results = await forEachItem(ctx, 3, (i) => i.modalTriggers.filter((t) => t.visible && !DANGEROUS_ACTION.test(t.text)), async (trigger) => {
      const out: CheckOutcome[] = [];
      const page = ctx.session.page;
      const open = spec("modals", `open:${trigger.text || trigger.qid}`, {
        title: `Modal opens: ${trigger.text || "dialog trigger"}`,
        feature: "Modal",
        element: describe("trigger", trigger.text),
        steps: ["Click the trigger", "Look for a visible dialog"],
        expected: "A dialog becomes visible",
      });
      const before = await pageState(ctx);
      const r = await click(locate(ctx, trigger.qid));
      if (!r.ok) return outcome.warn(open, `Trigger could not be clicked: ${r.error}`);
      await settle(ctx, 600);
      const opened = await pageState(ctx);
      if (opened.openDialogs <= before.openDialogs) {
        const ev = [evidence.dom("Dialogs", `visible dialogs: ${before.openDialogs} → ${opened.openDialogs}`), ...(await shot(ctx, "After clicking modal trigger"))];
        out.push(trigger.strong ? outcome.fail(open, "No dialog became visible after clicking the trigger", ev) : outcome.warn(open, "No dialog detected after clicking; review manually", { evidence: ev }));
        return out;
      }
      out.push(outcome.pass(open, "Dialog is visible", [`visible dialogs ${before.openDialogs} → ${opened.openDialogs}`], { evidence: await shot(ctx, "Modal open") }));

      const close = spec("modals", `close:${trigger.text || trigger.qid}`, {
        title: `Modal can be closed: ${trigger.text || "dialog"}`,
        feature: "Modal",
        element: describe("dialog", trigger.text),
        steps: ["Open the dialog", "Press Escape", "If still open, click its close button"],
        expected: "The dialog closes",
      });
      await page.keyboard.press("Escape");
      await settle(ctx, 500);
      let state = await pageState(ctx);
      if (state.openDialogs <= before.openDialogs) {
        out.push(outcome.pass(close, "Dialog closed with Escape", [`visible dialogs ${opened.openDialogs} → ${state.openDialogs} after Escape`]));
        return out;
      }
      const closeButton = page.locator('[role="dialog"]:visible, dialog[open], [aria-modal="true"]:visible, .modal:visible').locator('[aria-label*="close" i], [data-dismiss], [data-bs-dismiss], .close, .btn-close, button:has-text("Close"), button:has-text("×")').first();
      if (await isVisible(closeButton)) {
        await closeButton.click({ timeout: 3_000 }).catch(() => undefined);
        await settle(ctx, 500);
        state = await pageState(ctx);
        if (state.openDialogs <= before.openDialogs) {
          out.push(outcome.pass(close, "Dialog closed with its close button (Escape did not close it)", [`visible dialogs ${opened.openDialogs} → ${state.openDialogs} after close button`]));
          return out;
        }
      }
      out.push(outcome.fail(close, "Dialog stayed open after Escape and after clicking its close control", [evidence.dom("Dialogs", `visible dialogs still ${state.openDialogs}`), ...(await shot(ctx, "Modal still open"))]));
      return out;
    });
    return results.length ? results : [none("modals", "Modal", "[aria-haspopup=dialog] / modal triggers", "No modal dialog triggers were found.")];
  },
};

// ---------------------------------------------------------------- carousels

export const carouselModule: TestModule = {
  id: "carousel",
  scope: "combo",
  async run(ctx) {
    const results = await forEachItem(ctx, 3, (i) => i.carousels, async (car, index) => {
      const s = spec("carousel", `carousel-${index}`, {
        title: "Carousel advances to another slide",
        feature: "Slider / carousel",
        element: `carousel #${index + 1} (${car.slideCount} slides)`,
        steps: car.nextQid ? ["Record the active slide", "Click the next control", "Compare the active slide"] : ["Record the active slide", "Wait 5 seconds", "Compare"],
        expected: "A different slide becomes active",
      });
      if (!(await isVisible(locate(ctx, car.qid)))) return outcome.notApplicable(s, "Carousel is not visible at this viewport.");
      const before = await stateSignature(ctx, car.qid);
      if (car.nextQid && (await isVisible(locate(ctx, car.nextQid)))) {
        for (let attempt = 0; attempt < 2; attempt++) {
          await click(locate(ctx, car.nextQid));
          await settle(ctx, 900 + attempt * 600);
          const after = await stateSignature(ctx, car.qid);
          if (after !== before) return outcome.pass(s, "Slide state changed after clicking next", ["Active-slide signature changed after clicking the next control"], { evidence: await shot(ctx, "Carousel after next") });
        }
        const ev = [evidence.dom("Carousel", "Active-slide signature identical before and after two clicks on the next control"), ...(await shot(ctx, "Carousel unchanged"))];
        return car.strong ? outcome.fail(s, "Clicking the next control did not change the active slide", ev) : outcome.warn(s, "No slide change detected; review manually", { evidence: ev });
      }
      await settle(ctx, 5_000);
      const after = await stateSignature(ctx, car.qid);
      return after !== before
        ? outcome.pass(s, "Carousel advanced automatically", ["Active-slide signature changed during a 5 s observation"])
        : outcome.warn(s, "Carousel structure found without visible controls and it did not auto-advance in 5 s", { evidence: await shot(ctx, "Static carousel") });
    });
    return results.length ? results : [none("carousel", "Slider / carousel", "carousel containers", "No sliders or carousels were found.")];
  },
};
