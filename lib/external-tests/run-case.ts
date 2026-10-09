import type { Locator, Page } from "playwright";
import { safeValueFor } from "@/lib/forms/test-data";
import type { FormField } from "@/lib/forms/analyze";
import { runScript } from "@/lib/testing/browser-scripts";
import type { PageTestContext } from "@/lib/testing/context";
import { evidence } from "@/lib/testing/outcome";
import type { EvidenceItem } from "@/types";
import { judge, type Observation, type PageFacts } from "./evaluate";
import { describeAction, type Action, type Check, type Interpretation } from "./interpret";
import { HUMAN_INTERACTION_TEXT, type ExternalCase, type ExternalStatus } from "./types";

export interface CaseRunResult {
  status: ExternalStatus;
  actual: string;
  /** Concrete observations behind a PASS. */
  verifications: string[];
  evidence: EvidenceItem[];
  durationMs: number;
}

// ---------------------------------------------------------------- in-page scripts (plain JS strings)

const FACTS_SCRIPT = String.raw`function () {
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none"; };
  const txt = (el) => (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
  const text = document.body ? txt(document.body).slice(0, 30000) : "";
  const headings = [...document.querySelectorAll("h1, h2")].filter(vis).map(txt).filter(Boolean).slice(0, 6);
  const userInvalid = (el) => { try { return el.matches(":user-invalid"); } catch (e) { return false; } };
  const fields = [...document.querySelectorAll("input, select, textarea")].filter((el) => el.getAttribute("aria-invalid") === "true" || userInvalid(el));
  const validationMessages = fields.map((el) => el.validationMessage).filter(Boolean).slice(0, 5);
  const alerts = [...document.querySelectorAll('[role=alert], [role=status], [aria-live]:not([aria-live=off]), .error, .errors, .alert, .success, .notice, .message, .toast, .invalid-feedback')]
    .filter(vis).map(txt).filter(Boolean).slice(0, 10);
  const expandedCount = [...document.querySelectorAll('[aria-expanded="true"]')].filter(vis).length + document.querySelectorAll("details[open]").length;
  let cartCount = null;
  for (const el of document.querySelectorAll('[class*=cart i], [id*=cart i], [aria-label*=cart i], [class*=basket i], [class*=bag i], a[href*=cart i]')) {
    if (!vis(el)) continue;
    const m = /(\d+)/.exec((el.getAttribute("aria-label") || "") + " " + txt(el));
    if (m) { cartCount = Number(m[1]); break; }
  }
  const prices = [];
  for (const el of document.querySelectorAll('[class*=price i], [itemprop=price], [data-price]')) {
    if (!vis(el) || el.querySelector('[class*=price i]')) continue;
    const raw = el.getAttribute("data-price") || el.getAttribute("content") || txt(el);
    const m = /(\d[\d,]*(?:\.\d+)?)/.exec(raw.replace(/\s/g, ""));
    if (m) prices.push(Number(m[1].replace(/,/g, "")));
  }
  return { url: location.href, title: document.title || "", headings, text, invalidCount: fields.length, validationMessages, alerts, expandedCount, cartCount, prices: prices.slice(0, 50) };
}`;

/** Looks for visible elements matching each subject of the expected result (e.g. "logo", "search bar"). */
const SUBJECTS_SCRIPT = String.raw`function (subjects) {
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none"; };
  const norm = (s) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();
  const describe = (el) => { const t = norm(el.innerText || el.getAttribute("alt") || el.getAttribute("aria-label") || el.getAttribute("placeholder") || ""); return "<" + el.tagName.toLowerCase() + ">" + (t ? " “" + t.slice(0, 60) + "”" : ""); };
  const special = [
    [/\blogo\b/, 'img[alt*=logo i], [class*=logo i], [id*=logo i], [aria-label*=logo i]'],
    [/\bsearch (bar|box|field|input)\b|^search$/, 'input[type=search], [role=searchbox], input[name=q], input[name*=search i], input[placeholder*=search i]'],
    [/\b(navigation|nav ?bar|main menu|menu bar|top menu)\b/, 'nav, [role=navigation]'],
    [/\bfooter\b/, 'footer, [role=contentinfo]'],
    [/\bheader\b/, 'header, [role=banner]'],
    [/\b(hero|banner|slider|carousel)\b/, '[class*=hero i], [class*=banner i], [class*=slider i], [class*=carousel i], [role=region][aria-roledescription=carousel]'],
    [/\bform\b/, 'form'],
    [/\b(image|images|picture|photo)\b/, 'img'],
    [/\b(cart|basket|bag)( icon)?\b/, '[class*=cart i], [id*=cart i], [aria-label*=cart i], a[href*=cart i]'],
    [/\bbreadcrumbs?\b/, '[aria-label*=breadcrumb i], [class*=breadcrumb i]'],
    [/\b(video|player)\b/, 'video, iframe[src*=youtube], iframe[src*=vimeo]'],
  ];
  const out = {};
  for (const subject of subjects) {
    const s = norm(subject);
    let found = null;
    for (const [re, sel] of special) if (re.test(s)) { found = [...document.querySelectorAll(sel)].find(vis) || null; if (found) break; }
    if (!found) {
      const words = s.split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !["the", "and", "with", "button", "link", "section", "should", "page"].includes(w));
      const candidates = document.querySelectorAll("a, button, h1, h2, h3, h4, label, img, input, [aria-label], [title], [role=button], [role=tab], p, li, span");
      for (const el of candidates) {
        if (!vis(el)) continue;
        const hay = norm((el.innerText || "") + " " + (el.getAttribute("alt") || "") + " " + (el.getAttribute("aria-label") || "") + " " + (el.getAttribute("title") || "") + " " + (el.getAttribute("placeholder") || ""));
        if (hay.length > 300) continue;
        if (hay.includes(s) || (words.length && words.every((w) => hay.includes(w)))) { found = el; break; }
      }
    }
    out[subject] = found ? { found: true, description: describe(found) } : { found: false, description: "" };
  }
  return out;
}`;

// ---------------------------------------------------------------- element resolution

const css = (s: string) => s.replace(/["\\]/g, "\\$&");
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function firstVisible(candidates: Locator[]): Promise<Locator | null> {
  for (const loc of candidates) {
    const n = Math.min(await loc.count().catch(() => 0), 8);
    for (let i = 0; i < n; i++) {
      const el = loc.nth(i);
      if (await el.isVisible().catch(() => false)) return el;
    }
  }
  return null;
}

function clickables(page: Page, text: string): Locator[] {
  const exact = { name: text, exact: true };
  const loose = { name: new RegExp(`\\b${escapeRe(text)}\\b`, "i") };
  const list = [
    page.getByRole("button", exact),
    page.getByRole("link", exact),
    page.getByRole("tab", exact),
    page.getByRole("menuitem", exact),
    page.getByRole("button", loose),
    page.getByRole("link", loose),
    page.getByRole("tab", loose),
    page.getByRole("menuitem", loose),
    page.getByRole("option", loose),
    page.getByText(text, { exact: true }),
    page.locator(`[aria-label*="${css(text)}" i], [title*="${css(text)}" i], input[type=submit][value*="${css(text)}" i], input[type=button][value*="${css(text)}" i]`),
  ];
  if (/\b(menu|hamburger|navigation)\b/i.test(text)) list.push(page.locator('[class*=hamburger i], [class*=menu-toggle i], [class*=nav-toggle i], button[aria-controls][aria-expanded]'));
  return list;
}

function fields(page: Page, name: string): Locator[] {
  const n = name.toLowerCase();
  const list: Locator[] = [];
  if (/e-?mail/.test(n)) list.push(page.locator("input[type=email]"));
  if (/search/.test(n)) list.push(page.locator("input[type=search], [role=searchbox], input[name=q], input[name=s], input[name*=search i], input[placeholder*=search i]"));
  if (/phone|mobile|tel/.test(n)) list.push(page.locator("input[type=tel]"));
  if (/message|comment|enquiry|inquiry/.test(n)) list.push(page.locator("textarea"));
  list.push(
    page.getByLabel(name, { exact: false }),
    page.getByPlaceholder(name, { exact: false }),
    page.getByRole("textbox", { name: new RegExp(escapeRe(name), "i") }),
    page.getByRole("searchbox", { name: new RegExp(escapeRe(name), "i") }),
    page.locator(`input[name*="${css(n)}" i], textarea[name*="${css(n)}" i], input[id*="${css(n)}" i], textarea[id*="${css(n)}" i]`),
  );
  return list;
}

/**
 * Finds a visible element; when the target is hidden (e.g. navigation collapsed behind a menu button on
 * small screens) a collapsed menu toggle is opened once and the search repeated, as a tester would.
 */
async function findWithMenu(r: Run, candidates: () => Locator[]): Promise<Locator | null> {
  const found = await firstVisible(candidates());
  if (found) return found;
  const p = page(r);
  const toggle = await firstVisible([p.locator('button[aria-expanded="false"][aria-controls], [aria-expanded="false"][class*=menu i], [class*=hamburger i], [class*=menu-toggle i], [class*=nav-toggle i]')]);
  if (!toggle) return null;
  await toggle.click({ timeout: 3_000 }).catch(() => undefined);
  await p.waitForTimeout(300);
  const retry = await firstVisible(candidates());
  if (retry) r.performed.push("Opened the collapsed navigation menu.");
  return retry;
}

// ---------------------------------------------------------------- safety

const PAYMENT = /\b(pay( now)?|place (the |an )?order|buy now|purchase|confirm (the )?(order|payment)|complete (the )?(order|purchase|payment))\b/i;
const DESTRUCTIVE = /\b(delete|deactivate|close (my )?account|remove (my )?account|unsubscribe|cancel (my )?(account|subscription|order))\b/i;
const CART_ACTION = /\b(add to (cart|bag|basket)|update (cart|bag|basket|quantity)|remove( from (cart|bag|basket))?|quantity)\b/i;
const SUBMITTING = /\b(submit|send|subscribe|sign ?up|register|log ?in|sign ?in|contact us|request|apply|book)\b/i;

class StepError extends Error {
  constructor(
    message: string,
    readonly status: ExternalStatus = "NOT EXECUTED",
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------- execution

interface Run {
  ctx: PageTestContext;
  website: string;
  log: string[];
  /** Human-readable steps performed, for the Actual Result. */
  performed: string[];
}

const page = (r: Run) => r.ctx.session.page;

async function settle(p: Page) {
  await p.waitForLoadState("domcontentloaded", { timeout: 8_000 }).catch(() => undefined);
  await p.waitForTimeout(400);
}

async function facts(p: Page): Promise<PageFacts> {
  return runScript<PageFacts>(p, FACTS_SCRIPT);
}

/** Clicks with the existing safety rules: cart actions are allowed, real submissions only when the run allows them (once per form). */
async function safeClick(r: Run, el: Locator, label: string) {
  const text = `${label} ${(await el.innerText().catch(() => "")) ?? ""} ${(await el.getAttribute("value").catch(() => "")) ?? ""}`;
  if (PAYMENT.test(text)) throw new StepError(`Clicking “${label}” would start a payment or place an order, which is never done automatically.`, "HUMAN INTERACTION");
  if (DESTRUCTIVE.test(text)) throw new StepError(`“${label}” is a destructive action (delete/cancel/unsubscribe) and was not performed.`);
  const session = r.ctx.session;
  const type = ((await el.getAttribute("type").catch(() => null)) ?? "").toLowerCase();
  let unguarded = false;
  if (CART_ACTION.test(text)) unguarded = true;
  else if ((type === "submit" || SUBMITTING.test(text)) && r.ctx.options.allowFormSubmission) {
    const fingerprint = `external|${page(r).url().replace(/[?#].*$/, "")}|${label.toLowerCase()}`;
    if (!r.ctx.formLedger.hasSubmitted("external", fingerprint)) {
      r.ctx.formLedger.record("external", fingerprint, page(r).url());
      unguarded = true;
    } else {
      r.log.push(`“${label}” was already submitted once on this page in an earlier run, so the submission was intercepted this time.`);
    }
  }
  if (unguarded) session.setGuard(false).forEach((b) => session.blocked.push(b));
  try {
    await el.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => undefined);
    await el.click({ timeout: 5_000 });
  } finally {
    if (unguarded) {
      await settle(page(r));
      session.setGuard("writes").forEach((b) => session.blocked.push(b));
    }
  }
}

async function goTo(r: Run, url: string) {
  const res = await r.ctx.session.navigate(url, r.ctx.options.navigationTimeoutMs);
  if (!res.ok) throw new StepError(`${url} could not be opened${res.status ? ` (HTTP ${res.status})` : res.error ? ` (${res.error.message})` : ""}.`);
  r.performed.push(`Opened ${res.finalUrl}${res.status ? ` (HTTP ${res.status})` : ""}.`);
}

async function perform(r: Run, a: Action) {
  const p = page(r);
  switch (a.kind) {
    case "navigate": {
      if (a.target.type === "home") return goTo(r, r.website);
      if (a.target.type === "url") return goTo(r, a.target.url);
      const name = a.target.name;
      const link = await findWithMenu(r, () => [p.getByRole("link", { name, exact: true }), p.getByRole("link", { name: new RegExp(`\\b${escapeRe(name)}\\b`, "i") })]);
      if (!link) throw new StepError(`No link to the “${a.target.name}” page was found on ${p.url()}.`);
      await safeClick(r, link, a.target.name);
      await settle(p);
      r.performed.push(`Opened the “${a.target.name}” page via its link (${p.url()}).`);
      return;
    }
    case "click": {
      const el = await findWithMenu(r, () => clickables(p, a.text));
      if (!el) throw new StepError(`No visible element named “${a.text}” could be identified on ${p.url()}.`);
      await safeClick(r, el, a.text);
      await settle(p);
      r.performed.push(`Clicked “${a.text}”.`);
      return;
    }
    case "submit": {
      const el = await firstVisible([p.locator("form button[type=submit], form input[type=submit], form button:not([type])"), p.getByRole("button", { name: SUBMITTING })]);
      if (!el) throw new StepError(`No submit button was found on ${p.url()}.`);
      await safeClick(r, el, (await el.innerText().catch(() => "")) || "Submit");
      await settle(p);
      r.performed.push("Submitted the form.");
      return;
    }
    case "addToCart": {
      const el = await firstVisible([p.getByRole("button", { name: /add to (cart|bag|basket)/i }), p.locator("input[type=submit][value*='add to cart' i]")]);
      if (!el) throw new StepError(`No “Add to cart” control was found on ${p.url()}.`);
      await safeClick(r, el, "Add to cart");
      await settle(p);
      r.performed.push("Clicked “Add to cart”.");
      return;
    }
    case "fill": {
      const el = await firstVisible(fields(p, a.field));
      if (!el) throw new StepError(`No input field for “${a.field}” could be identified on ${p.url()}.`);
      if (((await el.getAttribute("type")) ?? "").toLowerCase() === "password") throw new StepError("The step needs a password, which QA Pilot AI never stores or invents.", "HUMAN INTERACTION");
      let value: string;
      switch (a.value.kind) {
        case "text":
          value = a.value.value;
          break;
        case "invalidEmail":
          value = a.value.value;
          break;
        case "empty":
          value = "";
          break;
        case "testEmail":
          if (!r.ctx.project.testEmail) throw new StepError("The step needs an email address, but the project has no Test Email configured. No address is ever invented.");
          value = r.ctx.project.testEmail;
          break;
        case "synthetic": {
          const field = { qid: "", tag: "input", type: ((await el.getAttribute("type")) ?? "text").toLowerCase(), name: a.value.hint, label: a.value.hint, required: false, minLength: null, maxLength: null, min: null, max: null, step: null, pattern: null, patternValid: false, autocomplete: "", hasLabel: true, options: [], visible: true } satisfies FormField;
          const safe = safeValueFor(field, r.ctx.project.testEmail);
          if (safe.kind === "needs-email") throw new StepError("The step needs an email address, but the project has no Test Email configured. No address is ever invented.");
          if (safe.kind !== "fill") throw new StepError(`No safe test value is available for “${a.field}”${safe.kind === "skip" ? ` (${safe.reason})` : ""}.`);
          value = safe.value;
          break;
        }
      }
      await el.fill(value, { timeout: 5_000 });
      // Values are not logged: the field name is enough to describe the step.
      r.performed.push(value ? `Filled “${a.field}”.` : `Left “${a.field}” empty.`);
      return;
    }
    case "search": {
      let el = await firstVisible(fields(p, "search"));
      if (!el) {
        const toggle = await firstVisible([p.getByRole("button", { name: /search/i }), p.locator("[aria-label*=search i]")]);
        if (toggle) {
          await toggle.click({ timeout: 3_000 }).catch(() => undefined);
          el = await firstVisible(fields(p, "search"));
        }
      }
      if (!el) throw new StepError(`No search field was found on ${p.url()}.`);
      await el.fill(a.term, { timeout: 5_000 });
      await el.press("Enter");
      await settle(p);
      r.performed.push(`Searched for “${a.term}” (${p.url()}).`);
      return;
    }
    case "select": {
      const selects = a.field ? [p.getByLabel(a.field, { exact: false }).locator("xpath=self::select"), p.locator(`select[name*="${css(a.field)}" i], select[id*="${css(a.field)}" i]`), p.locator("select")] : [p.locator("select")];
      const want = a.option.toLowerCase();
      const alt = /low to high|ascending/.test(want) ? /low.{0,4}high|ascending|lowest/i : /high to low|descending/.test(want) ? /high.{0,4}low|descending|highest/i : new RegExp(escapeRe(a.option), "i");
      for (const group of selects) {
        const n = Math.min(await group.count().catch(() => 0), 10);
        for (let i = 0; i < n; i++) {
          const sel = group.nth(i);
          if (!(await sel.isVisible().catch(() => false))) continue;
          const options = await sel.locator("option").allTextContents();
          const label = options.find((o) => o.trim().toLowerCase() === want) ?? options.find((o) => alt.test(o));
          if (label) {
            await sel.selectOption({ label }, { timeout: 5_000 });
            await settle(p);
            r.performed.push(`Selected “${label.trim()}”.`);
            return;
          }
        }
      }
      const custom = await firstVisible(clickables(p, a.option));
      if (!custom) throw new StepError(`No ${a.field ? `“${a.field}” ` : ""}dropdown offering “${a.option}” was found on ${p.url()}.`);
      await safeClick(r, custom, a.option);
      await settle(p);
      r.performed.push(`Chose “${a.option}”.`);
      return;
    }
    case "hover": {
      const el = await firstVisible(clickables(p, a.text));
      if (!el) throw new StepError(`No visible element named “${a.text}” could be identified to hover over.`);
      await el.hover({ timeout: 5_000 });
      await p.waitForTimeout(300);
      r.performed.push(`Hovered over “${a.text}”.`);
      return;
    }
    case "scroll": {
      if (a.to === "bottom" || a.to === "top") {
        await p.evaluate(a.to === "bottom" ? "window.scrollTo(0, document.body.scrollHeight)" : "window.scrollTo(0, 0)");
      } else {
        const el = await firstVisible([p.getByText(a.to, { exact: false }), ...clickables(p, a.to)]);
        if (!el) throw new StepError(`“${a.to}” could not be found to scroll to.`);
        await el.scrollIntoViewIfNeeded({ timeout: 3_000 });
      }
      await p.waitForTimeout(300);
      r.performed.push(`Scrolled to ${a.to}.`);
      return;
    }
    case "check":
    case "uncheck": {
      const el = await firstVisible([p.getByRole("checkbox", { name: new RegExp(escapeRe(a.text), "i") }), p.getByLabel(a.text, { exact: false })]);
      if (!el) throw new StepError(`No checkbox “${a.text}” was found.`);
      if (a.kind === "check") await el.check({ timeout: 5_000 });
      else await el.uncheck({ timeout: 5_000 });
      r.performed.push(`${a.kind === "check" ? "Checked" : "Unchecked"} “${a.text}”.`);
      return;
    }
    case "press":
      await p.keyboard.press(a.key);
      await settle(p);
      r.performed.push(`Pressed ${a.key}.`);
      return;
    case "wait":
      await p.waitForTimeout(800);
      return;
    case "verify":
      return; // evaluated by the caller
  }
}

async function observe(r: Run, before: PageFacts, checks: Check[], downloadsBefore: number, networkBefore: number): Promise<Observation> {
  const p = page(r);
  const after = await facts(p);
  const subjects = checks.flatMap((c) => (c.kind === "element" ? [c.subject] : []));
  const elements = subjects.length ? await runScript<Observation["elements"]>(p, SUBJECTS_SCRIPT, subjects) : {};
  const docs = r.ctx.session.network.slice(networkBefore).filter((n) => n.resourceType === "document");
  return {
    before,
    after,
    status: docs.length ? docs[docs.length - 1].status : null,
    downloads: r.ctx.session.downloads.length - downloadsBefore,
    blockedWrites: r.ctx.session.blocked.filter((b) => b.method !== "GET").length,
    dialogs: [...r.ctx.session.dialogs],
    elements,
  };
}

/**
 * Executes one external test case in the current browser and viewport and decides its status from
 * what was observed. Never throws: problems become NOT EXECUTED (or HUMAN INTERACTION) with a reason.
 */
export async function runExternalCase(ctx: PageTestContext, c: ExternalCase, interp: Interpretation, website: string): Promise<CaseRunResult> {
  const started = Date.now();
  const device = `${ctx.viewport.kind} ${ctx.viewport.width}×${ctx.viewport.height}`;
  const done = (status: ExternalStatus, actual: string, extra: Partial<CaseRunResult> = {}): CaseRunResult => ({ status, actual, verifications: [], evidence: [], durationMs: Date.now() - started, ...extra });

  if (interp.devices.length && !interp.devices.includes(ctx.viewport.kind)) {
    return done("NOT APPLICABLE", `This test case targets ${interp.devices.join("/")} devices and does not apply to ${device}.`);
  }
  if (interp.human) return done("HUMAN INTERACTION", `${HUMAN_INTERACTION_TEXT} Automation stopped because ${interp.human}.`);
  if (interp.notExecuted) return done("NOT EXECUTED", interp.notExecuted);

  const r: Run = { ctx, website, log: [], performed: [] };
  const session = ctx.session;
  const p = page(r);
  const shots: EvidenceItem[] = [];
  const allChecks: Check[] = [...interp.checks];
  session.setGuard(false);
  session.blocked.splice(0);
  session.dialogs.splice(0);
  try {
    // Every case starts from a clean session on the website (or the first step's page).
    await p.context().clearCookies().catch(() => undefined);
    const first = interp.actions[0];
    if (!first || first.kind !== "navigate") await goTo(r, website);
    session.setGuard("writes");
    let before = await facts(p);
    const downloadsBefore = session.downloads.length;
    const networkBefore = session.network.length;
    if (interp.inferred) r.log.push(`The sheet has no steps for this case; steps were inferred: ${interp.actions.map(describeAction).join("; ")}.`);

    for (const [i, action] of interp.actions.entries()) {
      if (ctx.isCancelled()) return done("NOT EXECUTED", "The execution was cancelled before this test case finished.");
      if (action.kind === "verify") {
        const obs = await observe(r, before, action.checks, downloadsBefore, networkBefore);
        const j = judge(action.checks, obs);
        if (j.outcome === "FAIL") {
          const shot = await ctx.capture(`${c.caseRef ?? `Row ${c.rowNumber}`} step ${i + 1} failed`);
          return done("FAIL", [...r.performed, `Step “${action.raw}” failed: ${j.details.join(" ")}`].join(" "), {
            evidence: [evidence.note("Observed", `${obs.after.url}\n${j.details.join("\n")}`), ...(shot ? [shot] : [])],
          });
        }
        r.log.push(...j.details);
        continue;
      }
      await perform(r, action);
      // The first navigation defines the starting state for "what changed" comparisons.
      if (i === 0 && action.kind === "navigate") before = await facts(p);
    }

    const obs = await observe(r, before, allChecks, downloadsBefore, networkBefore);
    const verdict = judge(allChecks, obs);
    const shot = await ctx.capture(`${c.caseRef ?? `Row ${c.rowNumber}`} result`);
    if (shot) shots.push(shot);
    const story = [...r.performed, ...r.log, ...verdict.details].join(" ");
    const ev = [evidence.note("Observed", `URL: ${obs.after.url}\nTitle: ${obs.after.title}\n${verdict.details.join("\n")}`), ...shots];
    switch (verdict.outcome) {
      case "PASS":
        return done("PASS", story, { verifications: verdict.details, evidence: ev });
      case "FAIL":
        return done("FAIL", story, { evidence: ev });
      case "BLOCKED":
        return done("NOT EXECUTED", `${story} The expected outcome depends on a real submission, which is disabled for this execution (enable “Allow real form submissions” to test it).`, { evidence: ev });
      case "UNDETERMINED":
        return done("HUMAN INTERACTION", `${HUMAN_INTERACTION_TEXT} ${story}`, { evidence: ev });
    }
  } catch (error) {
    const shot = await ctx.capture(`${c.caseRef ?? `Row ${c.rowNumber}`} stopped`).catch(() => null);
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    const status = error instanceof StepError ? error.status : "NOT EXECUTED";
    const prefix = status === "HUMAN INTERACTION" ? `${HUMAN_INTERACTION_TEXT} ` : "";
    return done(status, `${prefix}${[...r.performed, message].join(" ")}`, { evidence: shot ? [shot] : [] });
  } finally {
    session.setGuard(false);
  }
}
