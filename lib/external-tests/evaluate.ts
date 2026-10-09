import type { Check } from "./interpret";

/** What the page looked like at one moment (collected in the browser). */
export interface PageFacts {
  url: string;
  title: string;
  headings: string[];
  /** Visible text, whitespace-collapsed and bounded. */
  text: string;
  /** Form fields failing validation (:invalid or aria-invalid). */
  invalidCount: number;
  validationMessages: string[];
  /** Text of role=alert / role=status / aria-live regions. */
  alerts: string[];
  /** Elements with aria-expanded="true" plus open <details>. */
  expandedCount: number;
  /** Number shown on a cart/bag/basket indicator, if one exists. */
  cartCount: number | null;
  /** Prices of listed products in display order. */
  prices: number[];
}

export interface Observation {
  before: PageFacts;
  after: PageFacts;
  /** HTTP status of the last document load. */
  status: number | null;
  downloads: number;
  /** Non-GET requests stopped by the safety guard during the case. */
  blockedWrites: number;
  dialogs: string[];
  /** Presence of each element subject named in the expected result. */
  elements: Record<string, { found: boolean; description: string }>;
}

export type CheckVerdict = "pass" | "fail" | "unknown" | "blocked";

export interface Judgement {
  /** PASS / FAIL when every check could be decided; UNDETERMINED → needs a person; BLOCKED → a submission was intercepted. */
  outcome: "PASS" | "FAIL" | "UNDETERMINED" | "BLOCKED";
  /** One sentence per check describing what was observed. */
  details: string[];
}

const norm = (s: string) => s.toLowerCase().replace(/[“”"']/g, "").replace(/\s+/g, " ").trim();
const STOP = new Set(["the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "page", "screen", "section", "user", "should", "be"]);
const words = (s: string) => norm(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w));
const pathOf = (u: string) => {
  try {
    const x = new URL(u);
    return decodeURIComponent(x.pathname + x.search).toLowerCase().replace(/[-_/+=?&.]+/g, " ");
  } catch {
    return u.toLowerCase();
  }
};
const sameUrl = (a: string, b: string) => a.replace(/#.*$/, "").replace(/\/$/, "") === b.replace(/#.*$/, "").replace(/\/$/, "");
const newText = (o: Observation) => {
  const before = norm(o.before.text);
  // Sentences present now that were not on the page before the action.
  return o.after.text.split(/(?<=[.!?])\s+|\n/).filter((line) => line.trim() && !before.includes(norm(line))).join(" ");
};
const short = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function judgeOne(c: Check, o: Observation): { verdict: CheckVerdict; detail: string } {
  const a = o.after;
  switch (c.kind) {
    case "navigation": {
      const ws = words(c.target);
      const where = `${pathOf(a.url)} ${norm(a.title)} ${a.headings.map(norm).join(" ")}`;
      const matched = ws.length > 0 && ws.some((w) => where.includes(w));
      const moved = !sameUrl(a.url, o.before.url);
      const seen = `The page is ${a.url}${a.headings[0] ? ` with the heading “${short(a.headings[0], 80)}”` : a.title ? ` titled “${short(a.title, 80)}”` : ""}.`;
      if (c.negate) return matched && moved ? { verdict: "fail", detail: `The user was taken to “${c.target}”. ${seen}` } : { verdict: "pass", detail: `The user was not taken to “${c.target}”. ${seen}` };
      if (matched) return { verdict: "pass", detail: `${moved ? `Navigated from ${o.before.url} to ${a.url}.` : "The expected page is shown."} ${seen}` };
      return { verdict: "fail", detail: `Expected the “${c.target}” page, but ${moved ? `the browser went to ${a.url}` : `the page did not change (${a.url})`}${a.headings[0] ? ` and its heading is “${short(a.headings[0], 80)}”` : ""}.` };
    }
    case "text": {
      const hay = norm(`${a.text} ${a.alerts.join(" ")} ${o.dialogs.join(" ")}`);
      const found = hay.includes(norm(c.text));
      if (c.negate) return found ? { verdict: "fail", detail: `The text “${short(c.text)}” is displayed.` } : { verdict: "pass", detail: `The text “${short(c.text)}” is not displayed.` };
      return found ? { verdict: "pass", detail: `The text “${short(c.text)}” is displayed.` } : { verdict: "fail", detail: `The text “${short(c.text)}” was not found on the page.` };
    }
    case "validationError": {
      const messages = [...a.validationMessages, ...a.alerts.filter((t) => /error|invalid|required|please|must|incorrect/i.test(t))];
      const added = newText(o);
      const textual = /\b(error|invalid|required|please (enter|provide|fill)|must be|is not valid|incorrect)\b/i.exec(added);
      if (a.invalidCount > 0 || messages.length || textual) {
        const sample = messages[0] ?? (textual ? short(added.slice(Math.max(0, textual.index - 40), textual.index + 80)) : null);
        return { verdict: "pass", detail: `A validation error is shown${a.invalidCount ? ` (${a.invalidCount} field(s) flagged invalid)` : ""}${sample ? `: “${short(sample)}”` : ""}.` };
      }
      return { verdict: "fail", detail: "No validation error message or invalid-field state was shown." };
    }
    case "success": {
      const added = `${newText(o)} ${a.alerts.join(" ")} ${o.dialogs.join(" ")}`;
      const m = /\b(thank you|thanks|success(fully)?|submitted|received|subscribed|confirmed|has been sent|message sent|we will (get back|contact))\b[^.!?]*/i.exec(added);
      if (m) return { verdict: "pass", detail: `A confirmation is shown: “${short(m[0])}”.` };
      if (o.blockedWrites > 0) return { verdict: "blocked", detail: "The submission was intercepted because real form submissions are disabled for this execution, so the success response could not be observed." };
      return { verdict: "fail", detail: "No success or confirmation message appeared after the action." };
    }
    case "element": {
      const e = o.elements[c.subject];
      if (!e) return { verdict: "unknown", detail: `The presence of “${c.subject}” could not be checked.` };
      if (c.negate) return e.found ? { verdict: "fail", detail: `“${c.subject}” is displayed (${e.description}).` } : { verdict: "pass", detail: `“${c.subject}” is not displayed.` };
      return e.found ? { verdict: "pass", detail: `“${c.subject}” is displayed (${e.description}).` } : { verdict: "fail", detail: `No visible element matching “${c.subject}” was found.` };
    }
    case "pageLoads":
      if (o.status !== null && o.status >= 400) return { verdict: "fail", detail: `The page responded with HTTP ${o.status}.` };
      return a.title || a.headings.length || a.text.length > 20
        ? { verdict: "pass", detail: `The page loaded${o.status ? ` (HTTP ${o.status})` : ""}${a.title ? ` with the title “${short(a.title, 80)}”` : ""}.` }
        : { verdict: "fail", detail: "The page loaded without any visible content." };
    case "sorted": {
      if (a.prices.length < 2) return { verdict: "unknown", detail: "Fewer than two product prices were found, so the order could not be verified." };
      const ok = a.prices.every((p, i) => i === 0 || (c.order === "asc" ? p >= a.prices[i - 1] : p <= a.prices[i - 1]));
      const list = a.prices.slice(0, 8).join(", ");
      return ok ? { verdict: "pass", detail: `Displayed prices are in ${c.order === "asc" ? "ascending" : "descending"} order: ${list}.` } : { verdict: "fail", detail: `Displayed prices are not in ${c.order === "asc" ? "ascending" : "descending"} order: ${list}.` };
    }
    case "cartAdded": {
      const before = o.before.cartCount ?? 0;
      if (a.cartCount !== null && a.cartCount > before) return { verdict: "pass", detail: `The cart count increased from ${before} to ${a.cartCount}.` };
      const m = /\b(added to (your |the )?(cart|bag|basket))\b[^.!?]*/i.exec(`${newText(o)} ${a.alerts.join(" ")}`);
      if (m) return { verdict: "pass", detail: `The site confirmed: “${short(m[0])}”.` };
      if (o.blockedWrites > 0) return { verdict: "blocked", detail: "The add-to-cart request was intercepted by the safety guard." };
      return { verdict: "fail", detail: `The cart did not change (count ${a.cartCount ?? "not shown"}) and no confirmation appeared.` };
    }
    case "results": {
      const text = norm(a.text);
      if (/\b(no (results|products|items|matches)( were)? found|0 results|nothing (was )?found)\b/.test(text)) return { verdict: "fail", detail: "The page reports that no results were found." };
      const term = c.term ? norm(c.term) : null;
      if (term && text.includes(term)) return { verdict: "pass", detail: `Results for “${c.term}” are displayed (${a.url}).` };
      if (!sameUrl(a.url, o.before.url) && /[?&](q|s|search|query|keyword)=/.test(a.url)) return { verdict: "pass", detail: `A results page was displayed (${a.url}).` };
      if (/\b\d+ (results?|products?|items?)\b|\bresults? for\b/.test(text)) return { verdict: "pass", detail: "A list of results is displayed." };
      return { verdict: "unknown", detail: "No results list could be recognised on the page." };
    }
    case "noNavigation":
      return sameUrl(a.url, o.before.url) ? { verdict: "pass", detail: `The user stayed on ${a.url}.` } : { verdict: "fail", detail: `The browser navigated to ${a.url}.` };
    case "expanded":
      return a.expandedCount > o.before.expandedCount || a.text.length > o.before.text.length + 20
        ? { verdict: "pass", detail: "New content was expanded/revealed after the action." }
        : { verdict: "fail", detail: "Nothing expanded and no new content appeared after the action." };
    case "download":
      return o.downloads > 0 ? { verdict: "pass", detail: `${o.downloads} file download(s) started.` } : { verdict: "fail", detail: "No file download started." };
    case "url":
      return a.url.toLowerCase().includes(c.fragment.toLowerCase()) ? { verdict: "pass", detail: `The URL is ${a.url}.` } : { verdict: "fail", detail: `The URL is ${a.url}, which does not contain “${c.fragment}”.` };
  }
}

/**
 * Decides a case from measured observations only. PASS needs every check to pass; FAIL needs at least one
 * check that clearly failed. Anything that could not be measured leaves the decision to a person.
 */
export function judge(checks: Check[], o: Observation): Judgement {
  if (!checks.length) return { outcome: "UNDETERMINED", details: ["The expected result does not describe anything that can be measured automatically."] };
  const results = checks.map((c) => judgeOne(c, o));
  const details = results.map((r) => r.detail);
  if (results.some((r) => r.verdict === "fail")) return { outcome: "FAIL", details };
  if (results.some((r) => r.verdict === "blocked")) return { outcome: "BLOCKED", details };
  if (results.some((r) => r.verdict === "unknown")) return { outcome: "UNDETERMINED", details };
  return { outcome: "PASS", details };
}
