import type { ViewportKind } from "@/types";
import type { ExternalCase } from "./types";

/**
 * Deterministic interpretation of natural-language test cases. Excel content is treated as data:
 * it is matched against a fixed set of phrasings and never executed. Anything that does not match
 * clearly is reported, not guessed. An AI provider may later improve interpretation through the
 * same output types, but it can never add observations.
 */

export type FillValue = { kind: "text"; value: string } | { kind: "testEmail" } | { kind: "invalidEmail"; value: string } | { kind: "empty" } | { kind: "synthetic"; hint: string };

export type NavigateTarget = { type: "home" } | { type: "url"; url: string } | { type: "page"; name: string };

export type Action =
  | { kind: "navigate"; target: NavigateTarget; raw: string }
  | { kind: "click"; text: string; raw: string }
  | { kind: "fill"; field: string; value: FillValue; raw: string }
  | { kind: "search"; term: string; raw: string }
  | { kind: "select"; option: string; field: string | null; raw: string }
  | { kind: "hover"; text: string; raw: string }
  | { kind: "scroll"; to: "bottom" | "top" | string; raw: string }
  | { kind: "check" | "uncheck"; text: string; raw: string }
  | { kind: "press"; key: string; raw: string }
  | { kind: "submit"; raw: string }
  | { kind: "addToCart"; raw: string }
  | { kind: "wait"; raw: string }
  | { kind: "verify"; checks: Check[]; raw: string };

export type Check =
  | { kind: "navigation"; target: string; negate?: boolean }
  | { kind: "text"; text: string; negate?: boolean }
  | { kind: "validationError" }
  | { kind: "success" }
  | { kind: "element"; subject: string; negate?: boolean }
  | { kind: "pageLoads" }
  | { kind: "sorted"; order: "asc" | "desc" }
  | { kind: "cartAdded" }
  | { kind: "results"; term: string | null }
  | { kind: "noNavigation" }
  | { kind: "expanded" }
  | { kind: "download" }
  | { kind: "url"; fragment: string };

export interface Interpretation {
  actions: Action[];
  checks: Check[];
  /** Set when the case needs a person (OTP, CAPTCHA, payment, real inbox, …). */
  human: string | null;
  /** Set when a step cannot be performed reliably or safely. */
  notExecuted: string | null;
  /** Steps were derived from the test case because the sheet had none. */
  inferred: boolean;
  /** Device kinds the case explicitly targets (empty = any). */
  devices: ViewportKind[];
}

const lower = (s: string) => s.toLowerCase();
const clean = (s: string) => s.replace(/\s+/g, " ").trim();

/** Quoted values: "x", “x”, and 'x' when the quotes delimit a value rather than an apostrophe. */
export function quoted(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/["“]([^"”]{1,150})["”]/g)) out.push(m[1].trim());
  for (const m of text.matchAll(/(?:^|[\s(:=])['‘]([^'’]{1,120})['’](?=$|[\s).,:;!?])/g)) out.push(m[1].trim());
  return out.filter(Boolean);
}

// ---------------------------------------------------------------- human interaction & devices

const HUMAN_RULES: [RegExp, string][] = [
  [/\b(otp|one[- ]time (pass(word|code)|code)|verification code|security code)\b/, "it needs a one-time code"],
  [/\bsms\b|text message/, "it needs an SMS"],
  [/captcha|i'?m not a robot/, "it needs a CAPTCHA to be solved"],
  [/\b(2fa|two[- ]factor|multi[- ]factor|mfa|authenticator app)\b/, "it needs two-factor authentication"],
  [/\b(make (a |the )?payment|pay(ment)?\b|credit card|debit card|card (number|details)|cvv|place (the |an )?order|complete (the )?(purchase|order|checkout|payment)|confirm (the )?(order|purchase|payment)|buy now|purchase)\b/, "it involves a payment or a real order, which is never performed automatically"],
  [/\b(inbox|receive[sd]? (an? |the )?(confirmation )?e-?mail|check (your |the )?(e-?mail|mailbox)|e-?mail (is |should be )?(received|delivered|sent to))\b/, "it needs a real email inbox to be checked"],
  [/\b(biometric|fingerprint|face id|touch id|physical device|scan (the |a )?qr|printer|phone call)\b/, "it needs a physical device"],
  [/\b(sign|log) ?in with (google|facebook|apple|microsoft|github|linkedin)|\b(google|facebook|apple|microsoft) (log ?in|sign ?in)\b|\boauth\b|\bsso\b/, "it needs third-party authentication"],
  [/\b(valid|correct|registered|existing) (user ?name|credentials|password|account)\b|\blog ?in with valid\b|\bsuccessful(ly)? log(ged)? ?in\b/, "it needs real account credentials, which QA Pilot AI does not store"],
  [/\b(looks? (good|nice|professional|appealing|correct)|visually appealing|aesthetic|on[- ]brand|brand guidelines?|business approval|approved by|user[- ]friendly|intuitive|easy to (use|read))\b/, "it needs a visual or business judgement"],
];

export function detectHumanInteraction(c: Pick<ExternalCase, "title" | "steps" | "expected" | "preconditions">): string | null {
  const text = lower([c.title, c.steps, c.expected, c.preconditions].filter(Boolean).join(" \n "));
  for (const [re, reason] of HUMAN_RULES) if (re.test(text)) return reason;
  return null;
}

export function targetDevices(c: Pick<ExternalCase, "title" | "steps" | "expected">): ViewportKind[] {
  const text = lower([c.title, c.steps, c.expected].filter(Boolean).join(" "));
  const kinds: ViewportKind[] = [];
  if (/\b(on|in|using|for) (a |the )?(mobile|smartphone|phone)\b|\bmobile (view|device|viewport|screen|layout)\b/.test(text)) kinds.push("mobile");
  if (/\b(on|in|using|for) (a |the |an )?(tablet|ipad)\b|\btablet (view|device|viewport|screen|layout)\b/.test(text)) kinds.push("tablet");
  if (/\b(on|in|using|for) (a |the )?desktop\b|\bdesktop (view|device|viewport|screen|layout)\b/.test(text)) kinds.push("desktop");
  return kinds;
}

// ---------------------------------------------------------------- steps

export function splitSteps(steps: string): string[] {
  return steps
    .replace(/\r/g, "")
    .split(/\n|(?:^|\s)(?=\d{1,2}[.)]\s)|;|\s(?:→|->|=>)\s|\.\s+(?=[A-Z])/)
    .map((s) => clean(s.replace(/^(step\s*)?\d{1,2}\s*[.):-]\s*/i, "").replace(/^[-•*]\s*/, "")))
    .filter((s) => s.length > 1);
}

const TRAILING_NOISE = /\s+(button|link|icon|tab|option|cta|text|label|checkbox|radio button|field|on the (page|screen|website|site)|in the (header|footer|navigation|nav|menu|top bar|sidebar)|at the (top|bottom)( of the page)?)$/;
const target = (s: string) => {
  let t = clean(s.replace(/^(on|onto)\s+/i, "").replace(/^(the|a|an)\s+/i, "")).replace(/[.!]+$/, "");
  for (let i = 0; i < 3; i++) t = t.replace(TRAILING_NOISE, "").trim();
  return t;
};
const KEYS: Record<string, string> = { enter: "Enter", return: "Enter", tab: "Tab", escape: "Escape", esc: "Escape", space: "Space", "arrow down": "ArrowDown", "arrow up": "ArrowUp", backspace: "Backspace" };

function fieldValue(text: string, field: string): FillValue | null {
  const q = quoted(text);
  const t = lower(text);
  if (/\binvalid (e-?mail|email address)\b/.test(t)) return { kind: "invalidEmail", value: q[0] ?? "invalid-email-format" };
  if (q.length) return { kind: "text", value: q[0] };
  if (/\b(valid|test|your|an?) (e-?mail|email address)\b|\be-?mail( address)?\b/.test(t) && /mail/.test(lower(field))) return { kind: "testEmail" };
  if (/\b(empty|blank|nothing)\b/.test(t)) return { kind: "empty" };
  return { kind: "synthetic", hint: field };
}

/** Parses one natural-language step. Returns null when the step does not describe a supported action. */
export function parseStep(step: string, website: string): Action | { unsupported: string } | null {
  const raw = clean(step);
  const s = lower(raw).replace(/[.!]+$/, "");
  const q = quoted(raw);

  if (/\bupload\b/.test(s)) return { unsupported: "file uploads are not performed automatically" };
  if (/\b(password|passcode|pin)\b/.test(s) && /\b(enter|type|input|fill|provide)\b/.test(s) && !/\b(invalid|wrong|incorrect)\b/.test(s)) return { unsupported: "it needs a password, and QA Pilot AI never stores or invents passwords" };

  const verify = /^(verify|check|ensure|confirm|validate|assert|observe|see|make sure|expect|the user should|user should|it should)\b(\s+(that|if|whether))?\s*(.*)$/.exec(s);
  if (verify && !/\b(checkbox|check ?box|tick ?box)\b/.test(s)) {
    const checks = planChecks(raw.slice(raw.length - verify[4].length) || raw);
    return checks.length ? { kind: "verify", checks, raw } : { unsupported: "the verification could not be turned into a measurable check" };
  }

  const nav = /^(open|go to|navigate to|visit|launch|browse to|load|access|land on)\b\s*(.*)$/.exec(s);
  if (nav) {
    const rest = raw.slice(raw.length - nav[2].length);
    const url = /(https?:\/\/[^\s"'”)]+)/.exec(rest)?.[1] ?? /(?:^|\s)(\/[\w\-./?=&%]*)/.exec(rest)?.[1];
    if (url) return { kind: "navigate", target: { type: "url", url: new URL(url, website).href }, raw };
    if (/^(the\s+)?(home ?page|home|website|web ?site|site|application|app|landing page|main page|url|base url|browser|application url|website url)\b/.test(nav[2]) || !nav[2]) return { kind: "navigate", target: { type: "home" }, raw };
    const page = /^(the\s+)?(.+?)\s+(page|screen|section)\b/.exec(nav[2]);
    if (page) return { kind: "navigate", target: { type: "page", name: q[0] ?? target(page[2]) }, raw };
    return { unsupported: `the page to open could not be identified ("${raw}")` };
  }

  if (/\badd(ed)? (the |a |an |any )?(product|item|it)?\s*to (the )?(cart|bag|basket)\b/.test(s)) return { kind: "addToCart", raw };

  const search = /^search\s+(for\s+|with\s+)?(.+)$/.exec(s) ?? /^(enter|type|input)\s+(.+?)\s+(in|into)\s+(the\s+)?search\b/.exec(s);
  if (search) {
    const term = q[0] ?? clean(search[2].replace(/\b(keyword|term|text|query)\b/g, "").replace(/\s+(in|into|using)\s+(the\s+)?search.*$/, ""));
    return term ? { kind: "search", term, raw } : { unsupported: "the search term could not be identified" };
  }

  if (/^(press|hit)\s+/.test(s)) {
    const key = Object.keys(KEYS).find((k) => new RegExp(`\\b${k}\\b`).test(s));
    if (key) return { kind: "press", key: KEYS[key], raw };
  }

  const select = /^(select|choose|pick)\s+(.+?)\s+(from|in|on)\s+(the\s+)?(.+)$/.exec(s);
  if (select && !/\b(checkbox|radio)\b/.test(s)) return { kind: "select", option: q[0] ?? target(select[2]), field: target(select[5]).replace(/\s*(dropdown|drop-down|list|select|menu)$/, "") || null, raw };

  if (/\b(leave|keep)\b.*\b(empty|blank)\b|\bwithout (entering|filling|typing)\b/.test(s)) {
    const field = /\b(leave|keep)\s+(the\s+)?(.+?)\s+(field\s+)?(empty|blank)\b/.exec(s)?.[3];
    return field ? { kind: "fill", field: target(field), value: { kind: "empty" }, raw } : { kind: "wait", raw };
  }

  const fillWith = /^(fill|fill in|fill out|complete)\s+(the\s+)?(.+?)\s+(field\s+)?with\s+(.+)$/.exec(s);
  if (fillWith) return { kind: "fill", field: target(fillWith[3]), value: fieldValue(fillWith[5], fillWith[3]) ?? { kind: "synthetic", hint: fillWith[3] }, raw };
  const fillIn = /^(enter|type|input|key in|write|provide|fill( in)?)\s+(.+?)\s+(in|into|on)\s+(the\s+)?(.+?)(\s+(field|box|input|textbox|text box))?$/.exec(s);
  if (fillIn) {
    const field = target(fillIn[6]);
    const value = q[0] !== undefined ? { kind: "text" as const, value: q[0] } : fieldValue(fillIn[3], `${fillIn[3]} ${field}`);
    return { kind: "fill", field, value: value ?? { kind: "synthetic", hint: field }, raw };
  }
  const fillField = /^(enter|type|input|key in|provide|fill( in)?)\s+(an?\s+|the\s+|your\s+)?(valid\s+|invalid\s+|correct\s+|incorrect\s+)?(.+?)(\s+(field|address|details))?$/.exec(s);
  if (fillField) {
    const field = target(fillField[5]);
    return { kind: "fill", field, value: fieldValue(s, field) ?? { kind: "synthetic", hint: field }, raw };
  }

  if (/^(submit|send)\b/.test(s) && !q.length) return { kind: "submit", raw };
  const hover = /^(hover|mouse over|move (the )?mouse (over|to|on))\s*(over|on|to)?\s*(.+)$/.exec(s);
  if (hover) return { kind: "hover", text: q[0] ?? target(raw.slice(raw.length - hover[5].length)), raw };
  const scroll = /^scroll\b\s*(down|up)?\s*(to\s+(the\s+)?(.+))?$/.exec(s);
  if (scroll) {
    const to = scroll[4] ? target(scroll[4]) : scroll[1] === "up" ? "top" : "bottom";
    return { kind: "scroll", to: /^(bottom|end|footer)$/.test(to) ? "bottom" : /^(top|header)$/.test(to) ? "top" : to, raw };
  }
  const tick = /^(check|tick|uncheck|untick|enable|disable)\s+(the\s+)?(.+?)(\s+(checkbox|check ?box|box|toggle))?$/.exec(s);
  if (tick && /\b(checkbox|check ?box|box|toggle|agree|terms|consent|remember)\b/.test(s)) {
    return { kind: /^(uncheck|untick|disable)/.test(tick[1]) ? "uncheck" : "check", text: q[0] ?? target(raw.slice(raw.length - (tick[3] + (tick[4] ?? "")).length)), raw };
  }
  const click = /^(click|tap|press|hit|select|choose|double[- ]click)\s+(on\s+)?(.+)$/.exec(s);
  if (click) {
    const text = q[0] ?? target(raw.slice(raw.length - click[3].length));
    if (!text) return { unsupported: "the element to click could not be identified" };
    if (/^(submit|send)$/i.test(text)) return { kind: "submit", raw };
    return { kind: "click", text, raw };
  }
  if (/^wait\b/.test(s)) return { kind: "wait", raw };

  // A statement of an expected state used as a step (e.g. "Dashboard is displayed").
  const checks = planChecks(raw);
  if (checks.length) return { kind: "verify", checks, raw };
  return null;
}

// ---------------------------------------------------------------- expectations

const SUBJECT_STOP = /^(it|this|that|the user|user|users|page|the page|everything|all)$/;

/**
 * Turns an expected result into measurable checks. Only phrasings with a clear observable meaning
 * produce checks; everything else yields none, and the result is then left to a person.
 */
export function planChecks(expected: string): Check[] {
  const checks: Check[] = [];
  const add = (c: Check) => {
    if (!checks.some((x) => JSON.stringify(x) === JSON.stringify(c))) checks.push(c);
  };
  const sentences = expected.replace(/\r/g, "").split(/\n|(?<=[.!?;])\s+/).map((x) => x.trim()).filter(Boolean);
  for (const sentence of sentences) {
    const s = lower(sentence).replace(/[.!;]+$/, "");
    const q = quoted(sentence);
    const negative = /\b(should not|shouldn't|must not|is not|isn't|not be|no longer|cannot|can't|does not|doesn't|never)\b/.test(s);

    if (/\b(sort(ed|ing)?|order(ed)?|arrange(d)?)\b/.test(s) && /\b(low to high|ascending|lowest first|cheapest first|a to z|a-z)\b/.test(s)) add({ kind: "sorted", order: "asc" });
    if (/\b(sort(ed|ing)?|order(ed)?|arrange(d)?)\b/.test(s) && /\b(high to low|descending|highest first|z to a|z-a)\b/.test(s)) add({ kind: "sorted", order: "desc" });
    if (/\b(added to (the )?(cart|bag|basket)|cart (count|quantity|total|badge|icon) (should )?(increase|update|show)|item (appears|is shown) in (the )?cart)\b/.test(s)) add({ kind: "cartAdded" });
    if (/\b(error|validation|warning) (message|text|alert)?|\b(invalid|required field|field is required|is required|please enter|not valid)\b/.test(s) && !/\bno (error|validation)\b/.test(s)) {
      add({ kind: "validationError" });
    } else if (/\b(success|successful(ly)?|thank you|thanks|confirmation|confirmed|submitted|subscribed|message (is |was )?sent)\b/.test(s) && !negative) {
      add({ kind: "success" });
    }
    if (/\b(search )?results?\b.*\b(display|shown|appear|listed|returned)|\b(matching|relevant) (products|items|results)\b/.test(s)) add({ kind: "results", term: q[0] ?? null });
    if (/\b(download(ed|s)?|file (is |should be )?saved)\b/.test(s) && !negative) add({ kind: "download" });
    if (/\b(expand(s|ed)?|collapse[sd]?|drop ?down (opens|is shown|appears)|menu (opens|expands|is displayed|appears)|submenu|options? (are|is) (shown|displayed|listed))\b/.test(s)) add({ kind: "expanded" });
    if (/\b(remain|stay|stays|remains)s? on (the )?(same|current) page\b|\bshould not (navigate|redirect|submit|proceed)\b|\b(not|no) (be )?(navigat|redirect)/.test(s)) add({ kind: "noNavigation" });
    if (
      /^(the )?(home ?page|website|web ?site|site|page|application|app)( should| must| will)?( be)? (load(s|ed)?|open(s|ed)?|display(s|ed)?|available|accessible)\b/.test(s) ||
      /\b(load(s|ed)?|open(s|ed)?) (successfully|properly|correctly|without (any )?errors?)\b/.test(s)
    ) {
      add({ kind: "pageLoads" });
    }

    const url = /\burl\b.*?(?:contain|include|be|change to|end with)s?\s+["“']?(\/[\w\-./?=&%]*|https?:\/\/\S+)/.exec(s);
    if (url) add({ kind: "url", fragment: url[1].replace(/["”']$/, "") });

    const nav = /\b(redirect(ed|s)?|navigate[sd]?|taken|directed|lands?|landed|brought|go(es)?|moved?) (the user )?(to|on|onto) (the )?(?<to>.+?)( page| screen| section)?$/.exec(s) ?? /^(the )?(?<name>.+?) (page|screen) (should |is |will )?(open|opens|load|loads|be displayed|is displayed|displays|appear|appears|be shown|is shown)/.exec(s);
    if (nav) {
      const name = clean((nav.groups?.to ?? nav.groups?.name ?? "").replace(/^(the|a)\s+/, "").replace(/\s+(page|screen|section)$/, ""));
      if (name && !SUBJECT_STOP.test(name) && !/^(same|current|previous|home ?page|new tab)$/.test(name)) add({ kind: "navigation", target: q[0] ?? name, negate: negative && !/\bnot (be )?(navigat|redirect)/.test(s) ? true : undefined });
      else if (/^(home ?page)$/.test(name)) add({ kind: "url", fragment: "/" });
    }

    for (const text of q) {
      if (!checks.some((c) => (c.kind === "navigation" && c.target === text) || (c.kind === "results" && c.term === text))) add({ kind: "text", text, negate: negative || undefined });
    }

    const present = /^(the |a |an )?(.+?) (should |must |will )?(be |is |are )?(not )?(displayed|visible|shown|present|appear(s)?|available|rendered|exists?)\b/.exec(s);
    if (present && !q.length) {
      const subject = clean(present[2].replace(/\b(should|must|will)$/, ""));
      const covered = checks.some((c) => c.kind === "validationError" || c.kind === "success" || c.kind === "results" || c.kind === "navigation" || c.kind === "cartAdded");
      if (subject && !SUBJECT_STOP.test(subject) && !covered && subject.split(" ").length <= 6) add({ kind: "element", subject, negate: !!present[5] || negative || undefined });
    }
  }
  return checks;
}

// ---------------------------------------------------------------- whole case

/** Checks that need an action first; with no steps and nothing inferred they cannot be verified. */
const NEEDS_ACTION = new Set<Check["kind"]>(["navigation", "success", "validationError", "cartAdded", "sorted", "results", "expanded", "download", "noNavigation"]);

function infer(c: ExternalCase, checks: Check[]): Action[] {
  const text = lower(`${c.title} ${c.expected ?? ""}`);
  const q = quoted(`${c.title} ${c.expected ?? ""}`);
  const raw = `(inferred from "${c.title}")`;
  if (/\bsearch/.test(text)) {
    const term = q[0] ?? /\bsearch(?:ing)? (?:for|by) (?:an? |the )?([\w-]+(?: [\w-]+)?)/.exec(text)?.[1];
    return term ? [{ kind: "search", term, raw }] : [];
  }
  if (checks.some((x) => x.kind === "sorted")) {
    const desc = checks.some((x) => x.kind === "sorted" && x.order === "desc");
    return [{ kind: "select", option: desc ? "high to low" : "low to high", field: "sort", raw }];
  }
  if (checks.some((x) => x.kind === "cartAdded")) return [{ kind: "addToCart", raw }];
  const link = /\b(click(ing)?( on)?|open(ing)?|navigat(e|ing) to|go(ing)? to)\s+(the\s+)?["“]?([\w &'-]{2,40}?)["”]?\s+(link|button|menu|tab|page)\b/.exec(text);
  if (link) return [{ kind: "click", text: q[0] ?? link[8], raw }];
  const nav = checks.find((x) => x.kind === "navigation");
  if (nav && nav.kind === "navigation" && !nav.negate) return [{ kind: "click", text: nav.target, raw }];
  return [];
}

export function interpretCase(c: ExternalCase, website: string): Interpretation {
  const devices = targetDevices(c);
  const human = detectHumanInteraction(c);
  const checks = c.expected ? planChecks(c.expected) : [];
  const base = { checks, human, devices };
  if (human) return { ...base, actions: [], notExecuted: null, inferred: false };

  const steps = c.steps ? splitSteps(c.steps) : [];
  const actions: Action[] = [];
  if (c.url) actions.push({ kind: "navigate", target: { type: "url", url: new URL(c.url, website).href }, raw: `Open ${c.url}` });
  for (const step of steps) {
    const parsed = parseStep(step, website);
    if (!parsed) return { ...base, actions, notExecuted: `Step "${step}" could not be interpreted as a browser action, so the test case was not executed.`, inferred: false };
    if ("unsupported" in parsed) return { ...base, actions, notExecuted: `Step "${step}" was not performed: ${parsed.unsupported}.`, inferred: false };
    actions.push(parsed);
  }
  const allChecks = [...checks, ...actions.flatMap((a) => (a.kind === "verify" ? a.checks : []))];
  if (!allChecks.length) {
    return { ...base, actions, notExecuted: null, inferred: false };
  }
  let inferred = false;
  if (!steps.length) {
    const derived = infer(c, checks);
    if (derived.length) {
      actions.push(...derived);
      inferred = true;
    } else if (checks.some((x) => NEEDS_ACTION.has(x.kind))) {
      return { ...base, actions, notExecuted: "The sheet has no test steps for this case, and the required actions could not be identified from the test case and expected result.", inferred: false };
    }
  }
  return { ...base, actions, notExecuted: null, inferred };
}

export function describeAction(a: Action): string {
  switch (a.kind) {
    case "navigate":
      return a.target.type === "home" ? "Open the website" : a.target.type === "url" ? `Open ${a.target.url}` : `Open the “${a.target.name}” page`;
    case "click":
      return `Click “${a.text}”`;
    case "fill":
      return `Fill “${a.field}”`;
    case "search":
      return `Search for “${a.term}”`;
    case "select":
      return `Select “${a.option}”${a.field ? ` in “${a.field}”` : ""}`;
    case "hover":
      return `Hover over “${a.text}”`;
    case "scroll":
      return `Scroll to ${a.to}`;
    case "check":
    case "uncheck":
      return `${a.kind === "check" ? "Check" : "Uncheck"} “${a.text}”`;
    case "press":
      return `Press ${a.key}`;
    case "submit":
      return "Submit the form";
    case "addToCart":
      return "Add the product to the cart";
    case "wait":
      return "Wait";
    case "verify":
      return `Verify: ${a.raw}`;
  }
}
