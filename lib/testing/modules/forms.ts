import { analyzeForms, fieldValidity, formValidationState, type AnalyzedForm, type FormField, type FormValidationState } from "@/lib/forms/analyze";
import { EDGE_TEXT, INVALID_LOGIN_IDENTITY, isEmailField, safeValueFor } from "@/lib/forms/test-data";
import type { BlockedRequest } from "@/lib/playwright/page-session";
import type { ScenarioType } from "@/types";
import type { PageTestContext, TestModule } from "../context";
import { evidence, outcome, type CaseSpec, type CheckOutcome } from "../outcome";
import { locate, settle, spec } from "./helpers";

const MAX_FORMS = 3;
const SUCCESS_TEXT = /thank you|thanks|success|subscribed|received|we('| wi)ll be in touch|confirm(ation)? (email|link)|check your (inbox|email)|message (has been )?sent/i;

const KIND_LABEL: Record<AnalyzedForm["kind"], string> = {
  login: "Login form",
  signup: "Sign-up form",
  newsletter: "Newsletter form",
  contact: "Contact form",
  search: "Search form",
  payment: "Payment form",
  generic: "Form",
};

const fieldLabel = (f: FormField) => f.label || f.name || f.type;

// ------------------------------------------------------------------ interaction primitives

async function findForm(ctx: PageTestContext, fingerprint: string, index: number): Promise<AnalyzedForm | null> {
  const forms = await analyzeForms(ctx.session.page);
  return forms.filter((f) => f.fingerprint === fingerprint)[0] ?? forms[index] ?? null;
}

interface FillResult {
  missingEmail: boolean;
  unfillableRequired: string[];
}

/** Fills every field with safe data, except those overridden (value, or null = leave empty). */
async function fillForm(ctx: PageTestContext, form: AnalyzedForm, overrides: Map<string, string | null> = new Map()): Promise<FillResult> {
  const result: FillResult = { missingEmail: false, unfillableRequired: [] };
  for (const field of form.fields) {
    if (!field.visible) continue;
    const loc = locate(ctx, field.qid);
    if (overrides.has(field.qid)) {
      const v = overrides.get(field.qid);
      await loc.fill(v ?? "", { timeout: 3_000 }).catch(() => undefined);
      continue;
    }
    const safe = safeValueFor(field, ctx.project.testEmail);
    try {
      if (safe.kind === "fill") await loc.fill(safe.value, { timeout: 3_000 });
      else if (safe.kind === "select") await loc.selectOption(safe.value, { timeout: 3_000 });
      else if (safe.kind === "check") await loc.check({ timeout: 3_000 });
      else if (safe.kind === "needs-email") {
        if (field.required || isEmailField(field)) result.missingEmail = true;
      } else if (field.required) result.unfillableRequired.push(`${fieldLabel(field)} (${safe.reason})`);
    } catch {
      if (field.required) result.unfillableRequired.push(fieldLabel(field));
    }
  }
  return result;
}

interface GuardedAttempt {
  attempted: boolean;
  blocked: BlockedRequest[];
  before: FormValidationState | null;
  after: FormValidationState | null;
  pageErrors: string[];
}

/** Triggers submission with every outgoing write/navigation intercepted and aborted. */
async function submitGuarded(ctx: PageTestContext, form: AnalyzedForm): Promise<GuardedAttempt> {
  const page = ctx.session.page;
  const before = await formValidationState(page, form.qid);
  const mark = ctx.session.mark();
  ctx.session.setGuard(true);
  try {
    if (form.submitQid) await locate(ctx, form.submitQid).click({ timeout: 4_000 });
    else {
      const firstField = form.fields.find((f) => f.visible);
      if (firstField) await locate(ctx, firstField.qid).press("Enter", { timeout: 3_000 });
    }
  } catch {
    /* an unclickable submit is reported through the resulting state */
  }
  await settle(ctx, 900);
  const blocked = ctx.session.setGuard(false);
  const after = await formValidationState(page, form.qid).catch(() => null);
  return { attempted: blocked.length > 0, blocked, before, after, pageErrors: ctx.session.since(mark).pageErrors };
}

function validationShown(a: GuardedAttempt): string[] {
  const signs: string[] = [];
  if (a.after && !a.after.formValid) signs.push(`browser constraint validation blocked submission (${a.after.invalidFields.map((f) => `${f.name}: ${f.message || "invalid"}`).join("; ")})`);
  if (a.after && a.after.ariaInvalidCount > (a.before?.ariaInvalidCount ?? 0)) signs.push(`${a.after.ariaInvalidCount} field(s) marked aria-invalid`);
  const newErrors = (a.after?.errorTexts ?? []).filter((t) => !(a.before?.errorTexts ?? []).includes(t));
  if (newErrors.length) signs.push(`error message shown: "${newErrors[0]}"`);
  return signs;
}

function blockedEvidence(a: GuardedAttempt) {
  return evidence.note("Intercepted submission", a.blocked.map((b) => `${b.method} ${b.url} (${b.resourceType}) — aborted, nothing sent`).join("\n") || "No request attempted");
}

/** Interprets a guarded submission that is expected to be rejected. */
function expectRejected(s: CaseSpec, a: GuardedAttempt, what: string, declaredConstraint: boolean): CheckOutcome {
  const signs = validationShown(a);
  if (!a.attempted && signs.length) return outcome.pass(s, `${what} was rejected before submission`, signs);
  if (a.attempted && signs.length) return outcome.warn(s, `Validation feedback appeared but the form still tried to submit (${a.blocked[0].method} ${a.blocked[0].url}, intercepted)`, { evidence: [blockedEvidence(a)], verifications: signs });
  if (a.attempted) {
    return outcome.warn(s, `${what} was not rejected client-side; the form tried to submit (request intercepted, nothing sent). Server-side validation was not verified.`, { evidence: [blockedEvidence(a)] });
  }
  if (!declaredConstraint) return outcome.notApplicable(s, `No validation rule is declared for this input and the form showed no reaction; there is no requirement to verify.`);
  return outcome.warn(s, "The form neither submitted nor showed validation feedback; manual review needed.");
}

// ------------------------------------------------------------------ case builders

interface FormCaseContext {
  ctx: PageTestContext;
  module: string;
  form: AnalyzedForm;
  index: number;
}

function formSpec(fc: FormCaseContext, key: string, scenarioType: ScenarioType, title: string, f: { element?: string; testData?: string; steps: string[]; expected: string; preconditions?: string }): CaseSpec {
  return spec(fc.module, `form${fc.index}:${key}`, {
    title: `${KIND_LABEL[fc.form.kind]}: ${title}`,
    section: KIND_LABEL[fc.form.kind],
    scenarioType,
    feature: KIND_LABEL[fc.form.kind],
    element: f.element ?? `form ${fc.form.fingerprint.split("|")[0]}${fc.form.submitText ? ` [${fc.form.submitText}]` : ""}`,
    testData: f.testData,
    preconditions: f.preconditions ?? "Submissions are intercepted in the browser; no data is sent to the website.",
    steps: f.steps,
    expected: f.expected,
  });
}

async function fresh(fc: FormCaseContext): Promise<AnalyzedForm | null> {
  if (!(await fc.ctx.reload())) return null;
  return findForm(fc.ctx, fc.form.fingerprint, fc.index);
}

async function caseEmptyRequired(fc: FormCaseContext): Promise<CheckOutcome> {
  const required = fc.form.fields.filter((f) => f.required && f.visible);
  const s = formSpec(fc, "empty-required", "NEGATIVE", "empty required fields are rejected", {
    testData: "all fields left empty",
    steps: ["Leave every field empty", "Submit the form (intercepted)", "Observe validation"],
    expected: "Submission is blocked and the required fields are flagged",
  });
  const form = await fresh(fc);
  if (!form) return outcome.notExecuted(s, "Page could not be reloaded.");
  const attempt = await submitGuarded(fc.ctx, form);
  return expectRejected(s, attempt, `Empty form (${required.length} required field${required.length === 1 ? "" : "s"})`, required.length > 0);
}

async function caseInvalidValue(fc: FormCaseContext, field: FormField, value: string, what: string, declared: boolean): Promise<CheckOutcome> {
  const s = formSpec(fc, `invalid:${field.name || field.qid}:${what}`, "NEGATIVE", `invalid ${what} is rejected (${fieldLabel(field)})`, {
    element: `${field.tag}[name="${field.name}"]`,
    testData: JSON.stringify(value),
    steps: ["Fill other fields with valid test data", `Enter ${JSON.stringify(value)} in "${fieldLabel(field)}"`, "Submit (intercepted)"],
    expected: `The ${what} is rejected and the field is flagged`,
  });
  const form = await fresh(fc);
  if (!form) return outcome.notExecuted(s, "Page could not be reloaded.");
  const target = form.fields.find((f) => f.name === field.name) ?? field;
  const fill = await fillForm(fc.ctx, form, new Map([[target.qid, value]]));
  if (fill.missingEmail && !isEmailField(target)) return outcome.notExecuted(s, "The form requires an email address and the project has no Test Email configured.");
  const validity = await fieldValidity(fc.ctx.session.page, target.qid);
  const attempt = await submitGuarded(fc.ctx, form);
  if (target.pattern && !target.patternValid && attempt.attempted && validationShown(attempt).length === 0) {
    return outcome.fail(s, `The field declares pattern="${target.pattern}", which is not a valid regular expression, so browsers ignore it and ${JSON.stringify(value)} was accepted`, [
      evidence.dom("Field markup", `<${target.tag} name="${target.name}" pattern="${target.pattern}">: pattern fails to compile with the "v" flag used by browsers`),
      blockedEvidence(attempt),
    ]);
  }
  const r = expectRejected(s, attempt, `Invalid ${what}`, declared);
  if (validity && !validity.valid && r.status === "PASS") r.verifications.push(`field validity: ${validity.message || "invalid"}`);
  return r;
}

async function caseValidAccepted(fc: FormCaseContext): Promise<CheckOutcome> {
  const s = formSpec(fc, "valid-client", "POSITIVE", "valid data passes client-side validation", {
    testData: "synthetic values; project Test Email for email fields",
    steps: ["Fill every field with valid test data", "Submit (intercepted)", "Check that no validation error appears and submission is attempted"],
    expected: "The form accepts the data and attempts to submit",
  });
  const form = await fresh(fc);
  if (!form) return outcome.notExecuted(s, "Page could not be reloaded.");
  const fill = await fillForm(fc.ctx, form);
  if (fill.missingEmail) return outcome.notExecuted(s, "The form needs an email address and the project has no Test Email configured.");
  if (fill.unfillableRequired.length) return outcome.notExecuted(s, `Required fields cannot be filled safely: ${fill.unfillableRequired.join(", ")}`);
  const attempt = await submitGuarded(fc.ctx, form);
  const signs = validationShown(attempt);
  if (attempt.attempted && signs.length === 0) return outcome.pass(s, "Valid data accepted; the form attempted to submit (intercepted)", [`Submission attempt: ${attempt.blocked[0].method} ${attempt.blocked[0].url}`, "No validation errors shown"], { evidence: [blockedEvidence(attempt)] });
  if (signs.length) {
    const shot = await fc.ctx.capture("Form rejected valid test data");
    return outcome.warn(s, `Validation rejected the synthetic test data: ${signs.join("; ")}. The data may not meet an undocumented rule.`, { evidence: shot ? [shot] : [] });
  }
  return outcome.warn(s, "No validation errors, but no submission attempt was detected either (the form may need additional interaction).");
}

async function caseRealSubmit(fc: FormCaseContext, kind: string): Promise<CheckOutcome> {
  const s = formSpec(fc, "real-submit", "POSITIVE", "valid submission succeeds", {
    testData: "synthetic values; project Test Email",
    preconditions: "Real submission explicitly enabled for this run. Sent at most once per form.",
    steps: ["Fill every field with valid test data", "Submit the form for real", "Look for a confirmation"],
    expected: "The site confirms the submission (success message or confirmation page)",
  });
  const { ctx, form } = fc;
  if (!ctx.options.allowFormSubmission) return outcome.notExecuted(s, "Real form submission is disabled for this run (enable “Allow real form submissions” to test it).");
  if (!ctx.project.testEmail && form.fields.some(isEmailField)) return outcome.notExecuted(s, "No Test Email is configured for the project; real submissions require one.");
  if (form.hasCaptcha) return outcome.notExecuted(s, "The form is protected by a CAPTCHA; automated submission is not attempted.");
  if (ctx.formLedger.hasSubmitted(kind, form.fingerprint)) return outcome.notExecuted(s, "This form was already submitted by an earlier run; repeat submissions are not sent.");
  if (!ctx.isPrimaryCombo) return outcome.notExecuted(s, "Real submissions are sent only once per run (first browser and viewport).");
  const current = await fresh(fc);
  if (!current) return outcome.notExecuted(s, "Page could not be reloaded.");
  const fill = await fillForm(ctx, current);
  if (fill.unfillableRequired.length) return outcome.notExecuted(s, `Required fields cannot be filled safely: ${fill.unfillableRequired.join(", ")}`);
  const page = ctx.session.page;
  const beforeUrl = page.url();
  const nav = page.waitForNavigation({ timeout: 10_000 }).catch(() => null);
  ctx.formLedger.record(kind, form.fingerprint, ctx.url);
  if (current.submitQid) await locate(ctx, current.submitQid).click({ timeout: 4_000 }).catch(() => undefined);
  const response = await nav;
  await settle(ctx, 1500);
  const body = await page.locator("body").innerText({ timeout: 3_000 }).catch(() => "");
  const shot = await ctx.capture("After real submission");
  const ev = shot ? [shot] : [];
  if (response && response.status() >= 400) return outcome.fail(s, `Submission returned HTTP ${response.status()}`, [evidence.http("Submission response", `URL: ${page.url()}\nStatus: ${response.status()}`), ...ev]);
  const match = SUCCESS_TEXT.exec(body);
  if (match) return outcome.pass(s, `Confirmation shown: "${match[0]}"`, [`Confirmation text "${match[0]}" present after submission`, ...(page.url() !== beforeUrl ? [`URL ${beforeUrl} → ${page.url()}`] : [])], { evidence: ev });
  return outcome.warn(s, "Submitted, but no confirmation message could be identified", { evidence: ev });
}

async function caseEdgeValues(fc: FormCaseContext): Promise<CheckOutcome[]> {
  const textFields = fc.form.fields.filter((f) => f.visible && (f.tag === "textarea" || ["text", "search"].includes(f.type)) && !isEmailField(f));
  const out: CheckOutcome[] = [];
  const target = textFields[0];
  const textarea = textFields.find((f) => f.tag === "textarea");
  const base = (key: string, title: string, data: string, expected: string, field: FormField) =>
    formSpec(fc, `edge:${key}:${field.name}`, "EDGE", `${title} (${fieldLabel(field)})`, {
      element: `${field.tag}[name="${field.name}"]`,
      testData: data,
      steps: [`Enter ${data} in "${fieldLabel(field)}"`, "Read the field value back"],
      expected,
    });
  if (!target) {
    out.push(outcome.notApplicable(formSpec(fc, "edge:none", "EDGE", "edge-case text input", { steps: ["Inspect form fields"], expected: "Text fields handle edge values" }), "The form has no free-text fields."));
    return out;
  }
  {
    const s = base("special", "special characters and Unicode are preserved", JSON.stringify(EDGE_TEXT.special), "The value is kept exactly as typed", target);
    const form = await fresh(fc);
    if (form) {
      const field = form.fields.find((f) => f.name === target.name) ?? target;
      await locate(fc.ctx, field.qid).fill(EDGE_TEXT.special, { timeout: 3_000 }).catch(() => undefined);
      const v = await fieldValidity(fc.ctx.session.page, field.qid);
      if (!v) out.push(outcome.warn(s, "Field value could not be read"));
      else if (v.value === EDGE_TEXT.special) out.push(outcome.pass(s, "Value preserved exactly", [`read back ${JSON.stringify(v.value)}`]));
      else if (field.maxLength && v.value.length === field.maxLength) out.push(outcome.pass(s, `Value truncated to the declared maxlength (${field.maxLength})`, [`read back ${JSON.stringify(v.value)}`]));
      else out.push(outcome.warn(s, `Value changed to ${JSON.stringify(v.value)}`, { evidence: [evidence.dom("Field value", `typed: ${EDGE_TEXT.special}\nread back: ${v.value}`)] }));
    }
  }
  const requiredText = textFields.find((f) => f.required);
  if (requiredText) {
    const s = base("whitespace", "whitespace-only value in a required field", "three spaces", "A whitespace-only value is not accepted as a valid entry", requiredText);
    const form = await fresh(fc);
    if (form) {
      const field = form.fields.find((f) => f.name === requiredText.name) ?? requiredText;
      const fill = await fillForm(fc.ctx, form, new Map([[field.qid, EDGE_TEXT.whitespace]]));
      if (fill.missingEmail) out.push(outcome.notExecuted(s, "The form requires an email address and the project has no Test Email configured."));
      else {
        const attempt = await submitGuarded(fc.ctx, form);
        const signs = validationShown(attempt);
        if (signs.length && !attempt.attempted) out.push(outcome.pass(s, "Whitespace-only value was rejected", signs));
        else if (attempt.attempted) out.push(outcome.warn(s, "A whitespace-only value passed client-side validation (submission intercepted). Confirm the server trims and rejects it.", { evidence: [blockedEvidence(attempt)] }));
        else out.push(outcome.warn(s, "No submission and no validation feedback; manual review needed."));
      }
    }
  }
  if (textarea && !textarea.maxLength) {
    const s = base("long", "long text is accepted in full", `${EDGE_TEXT.long.length} characters`, "The full text is kept (no maxlength is declared)", textarea);
    const form = await fresh(fc);
    if (form) {
      const field = form.fields.find((f) => f.name === textarea.name) ?? textarea;
      await locate(fc.ctx, field.qid).fill(EDGE_TEXT.long, { timeout: 5_000 }).catch(() => undefined);
      const v = await fieldValidity(fc.ctx.session.page, field.qid);
      if (v && v.value.length === EDGE_TEXT.long.length) out.push(outcome.pass(s, `All ${v.value.length} characters kept`, [`value length ${v.value.length}`]));
      else out.push(outcome.warn(s, `Only ${v?.value.length ?? 0} of ${EDGE_TEXT.long.length} characters kept without a declared limit`, { evidence: [evidence.dom("Field", `value length ${v?.value.length ?? "unknown"}`)] }));
    }
  }
  out.push(await caseDuplicateSubmit(fc));
  return out;
}

async function caseBoundaries(fc: FormCaseContext): Promise<CheckOutcome[]> {
  const out: CheckOutcome[] = [];
  const page = fc.ctx.session.page;
  const fields = fc.form.fields.filter((f) => f.visible);
  const withLimits = fields.filter((f) => f.maxLength || f.minLength || ((f.type === "number" || f.type === "range") && (f.min !== null || f.max !== null)));
  if (!withLimits.length) {
    out.push(outcome.notApplicable(formSpec(fc, "boundary:none", "BOUNDARY", "field length / range limits", { steps: ["Inspect field constraints"], expected: "Declared limits are enforced" }), "No field declares a length or range limit; boundary values are not invented."));
    return out;
  }
  for (const f of withLimits.slice(0, 4)) {
    const el = `${f.tag}[name="${f.name}"]`;
    const mk = (key: string, title: string, data: string, expected: string) =>
      formSpec(fc, `boundary:${f.name}:${key}`, "BOUNDARY", `${title} (${fieldLabel(f)})`, { element: el, testData: data, steps: [`Type ${data}`, "Read the field value and validity"], expected });
    const typeInto = async (value: string) => {
      const form = await fresh(fc);
      if (!form) return null;
      const field = form.fields.find((x) => x.name === f.name) ?? f;
      const loc = locate(fc.ctx, field.qid);
      await loc.fill("", { timeout: 3_000 }).catch(() => undefined);
      // Typed key by key so the browser applies length validation as for a real user.
      await loc.pressSequentially(value, { timeout: 20_000 }).catch(() => undefined);
      return fieldValidity(page, field.qid);
    };
    if (f.maxLength) {
      const s = mk("max-plus-1", `maximum length ${f.maxLength} is enforced`, `${f.maxLength + 1} characters`, `At most ${f.maxLength} characters are kept`);
      const v = await typeInto("x".repeat(f.maxLength + 1));
      if (!v) out.push(outcome.notExecuted(s, "Field could not be read"));
      else if (v.value.length <= f.maxLength) out.push(outcome.pass(s, `Kept ${v.value.length} characters`, [`value length ${v.value.length} ≤ ${f.maxLength}`]));
      else out.push(outcome.fail(s, `Accepted ${v.value.length} characters (maxlength ${f.maxLength})`, [evidence.dom("Field", `maxlength=${f.maxLength}; value length ${v.value.length}`)]));
      const sAt = mk("max", `exactly ${f.maxLength} characters is accepted`, `${f.maxLength} characters`, "The value is kept in full and is valid");
      const vAt = await typeInto("x".repeat(f.maxLength));
      if (vAt && vAt.value.length === f.maxLength && !vAt.tooLong) out.push(outcome.pass(sAt, "Accepted at the limit", [`value length ${vAt.value.length}, tooLong=false`]));
      else if (vAt) out.push(outcome.fail(sAt, `Value length ${vAt.value.length}, tooLong=${vAt.tooLong}`, [evidence.dom("Field", JSON.stringify(vAt))]));
    }
    if (f.minLength && f.minLength > 1) {
      const s = mk("min-minus-1", `minimum length ${f.minLength} is enforced`, `${f.minLength - 1} characters`, "The field reports the value as too short");
      const v = await typeInto("x".repeat(f.minLength - 1));
      if (!v) out.push(outcome.notExecuted(s, "Field could not be read"));
      else if (v.tooShort) out.push(outcome.pass(s, "Value flagged as too short", [`validity.tooShort=true (${v.message})`]));
      else out.push(outcome.warn(s, `A ${v.value.length}-character value was not flagged as too short`, { evidence: [evidence.dom("Field", JSON.stringify(v))] }));
      const sAt = mk("min", `exactly ${f.minLength} characters is accepted`, `${f.minLength} characters`, "The value is not flagged as too short");
      const vAt = await typeInto("x".repeat(f.minLength));
      if (vAt && !vAt.tooShort) out.push(outcome.pass(sAt, "Accepted at the minimum", ["validity.tooShort=false"]));
      else if (vAt) out.push(outcome.fail(sAt, "Value at the minimum length was flagged as too short", [evidence.dom("Field", JSON.stringify(vAt))]));
    }
    if ((f.type === "number" || f.type === "range") && (f.min !== null || f.max !== null)) {
      const step = Number(f.step) > 0 ? Number(f.step) : 1;
      const checks: [string, number, "under" | "over" | "valid"][] = [];
      if (f.min !== null && !isNaN(Number(f.min))) checks.push(["below-min", Number(f.min) - step, "under"], ["min", Number(f.min), "valid"]);
      if (f.max !== null && !isNaN(Number(f.max))) checks.push(["max", Number(f.max), "valid"], ["above-max", Number(f.max) + step, "over"]);
      for (const [key, value, expect] of checks) {
        const s = mk(key, expect === "valid" ? `value ${value} at the limit is valid` : `value ${value} outside the range is rejected`, String(value), expect === "valid" ? "The value is valid" : `The field reports a range ${expect === "under" ? "underflow" : "overflow"}`);
        const form = await fresh(fc);
        if (!form) break;
        const field = form.fields.find((x) => x.name === f.name) ?? f;
        await locate(fc.ctx, field.qid).fill(String(value), { timeout: 3_000 }).catch(() => undefined);
        const v = await fieldValidity(page, field.qid);
        if (!v) {
          out.push(outcome.notExecuted(s, "Field could not be read"));
          continue;
        }
        const ok = expect === "valid" ? !v.rangeUnderflow && !v.rangeOverflow : expect === "under" ? v.rangeUnderflow : v.rangeOverflow;
        out.push(ok ? outcome.pass(s, `validity as expected (${v.message || "valid"})`, [`rangeUnderflow=${v.rangeUnderflow}, rangeOverflow=${v.rangeOverflow}`]) : outcome.fail(s, `Unexpected validity for ${value}: rangeUnderflow=${v.rangeUnderflow}, rangeOverflow=${v.rangeOverflow}`, [evidence.dom("Field", JSON.stringify(v))]));
      }
    }
  }
  return out;
}

/** Every visible field needs an accessible label; placeholders alone do not count. */
function caseLabels(fc: FormCaseContext): CheckOutcome {
  const fields = fc.form.fields.filter((f) => f.visible && f.type !== "submit");
  const s = formSpec(fc, "labels", "FUNCTIONAL", "every field has a label", {
    steps: ["Inspect each visible field for a <label>, aria-label, aria-labelledby or title"],
    expected: "Each field has an accessible label (placeholder text alone is not a label)",
    preconditions: "No interaction with the website is needed.",
  });
  if (!fields.length) return outcome.notApplicable(s, "The form has no visible fields.");
  const unlabelled = fields.filter((f) => !f.hasLabel);
  return unlabelled.length
    ? outcome.fail(s, `${unlabelled.length} of ${fields.length} field(s) have no accessible label: ${unlabelled.map((f) => f.name || f.type).join(", ")}`, [
        evidence.dom("Unlabelled fields", unlabelled.map((f) => `<${f.tag} type="${f.type}" name="${f.name}">${f.label ? ` (placeholder/name: "${f.label}")` : ""}`).join("\n")),
      ], { details: [] })
    : outcome.pass(s, `All ${fields.length} field(s) have an accessible label`, fields.map((f) => `${f.name || f.type}: "${f.label}"`));
}

/** Submits twice in quick succession with every request intercepted, and counts the attempts. */
async function caseDuplicateSubmit(fc: FormCaseContext): Promise<CheckOutcome> {
  const s = formSpec(fc, "edge:duplicate", "EDGE", "duplicate submission is prevented", {
    testData: "valid synthetic data, submit clicked twice",
    steps: ["Fill the form with valid test data", "Click submit twice in quick succession (both intercepted)", "Count the submission attempts"],
    expected: "The second click does not trigger a second submission (button disabled or request deduplicated)",
  });
  const form = await fresh(fc);
  if (!form) return outcome.notExecuted(s, "Page could not be reloaded.");
  if (!form.submitQid) return outcome.notApplicable(s, "The form has no submit button to double-click.");
  const fill = await fillForm(fc.ctx, form);
  if (fill.missingEmail) return outcome.notExecuted(s, "The form requires an email address and the project has no Test Email configured.");
  if (fill.unfillableRequired.length) return outcome.notExecuted(s, `Required fields cannot be filled safely: ${fill.unfillableRequired.join(", ")}`);
  const ctx = fc.ctx;
  ctx.session.setGuard(true);
  const button = locate(ctx, form.submitQid);
  await button.click({ timeout: 3_000 }).catch(() => undefined);
  await button.click({ timeout: 1_000, force: true }).catch(() => undefined);
  await settle(ctx, 900);
  const blocked = ctx.session.setGuard(false).filter((b) => b.method !== "GET" || b.resourceType === "document");
  const ev = [evidence.note("Intercepted submissions", blocked.map((b) => `${b.method} ${b.url} — aborted, nothing sent`).join("\n") || "none")];
  if (blocked.length === 0) return outcome.warn(s, "Neither click produced a submission request, so duplicate protection could not be assessed.", { evidence: ev });
  if (blocked.length === 1) return outcome.pass(s, "Only one submission was attempted for two clicks", ["1 intercepted submission after 2 clicks"], { evidence: ev });
  return outcome.warn(s, `${blocked.length} submissions were attempted for two clicks (all intercepted). The server may still deduplicate; review client-side protection.`, { evidence: ev });
}

async function standardFormCases(fc: FormCaseContext, realSubmitKind: string | null): Promise<CheckOutcome[]> {
  const out: CheckOutcome[] = [];
  out.push(caseLabels(fc));
  out.push(await caseEmptyRequired(fc));
  const email = fc.form.fields.find((f) => f.visible && isEmailField(f));
  if (email) out.push(await caseInvalidValue(fc, email, "invalid-email@", "email address", email.type === "email" || !!email.pattern));
  const tel = fc.form.fields.find((f) => f.visible && f.type === "tel");
  if (tel) out.push(await caseInvalidValue(fc, tel, "abc-not-a-phone", "phone number", !!tel.pattern));
  out.push(await caseValidAccepted(fc));
  if (realSubmitKind) out.push(await caseRealSubmit(fc, realSubmitKind));
  out.push(...(await caseEdgeValues(fc)));
  out.push(...(await caseBoundaries(fc)));
  return out;
}

async function formsOfKinds(ctx: PageTestContext, kinds: AnalyzedForm["kind"][]): Promise<AnalyzedForm[]> {
  return (await analyzeForms(ctx.session.page)).filter((f) => f.visible && kinds.includes(f.kind)).slice(0, MAX_FORMS);
}

// ------------------------------------------------------------------ modules

export const formsModule: TestModule = {
  id: "forms",
  scope: "combo",
  async run(ctx) {
    const handledElsewhere: AnalyzedForm["kind"][] = ["search"];
    if (ctx.selectedModules.has("newsletter")) handledElsewhere.push("newsletter");
    if (ctx.selectedModules.has("login")) handledElsewhere.push("login");
    const all = (await analyzeForms(ctx.session.page)).filter((f) => f.visible);
    const forms = all.filter((f) => !handledElsewhere.includes(f.kind)).slice(0, MAX_FORMS);
    if (!forms.length) {
      return [outcome.notApplicable(spec("forms", "none", { title: "Forms", feature: "Form", element: "form", steps: ["Inspect the page"], expected: "Forms validate input" }), "No testable forms were found on this page.")];
    }
    const out: CheckOutcome[] = [];
    for (const [index, form] of forms.entries()) {
      if (ctx.isCancelled()) break;
      ctx.setCurrentTest(`${KIND_LABEL[form.kind]} ${index + 1}`);
      const fc: FormCaseContext = { ctx, module: "forms", form, index };
      if (form.kind === "payment") {
        out.push(outcome.notExecuted(formSpec(fc, "payment", "FUNCTIONAL", "payment form", { steps: [], expected: "" }), "Payment forms are never tested automatically (no purchases or payment submissions)."));
        continue;
      }
      if (form.kind === "signup" || form.kind === "login") {
        out.push(await caseEmptyRequired(fc));
        out.push(outcome.notExecuted(formSpec(fc, "account-submit", "POSITIVE", "account creation / sign-in with valid data", { steps: [], expected: "" }), "Creating accounts or signing in requires explicit test credentials, which are not configured."));
        continue;
      }
      out.push(...(await standardFormCases(fc, form.kind === "contact" || form.kind === "generic" ? `form:${form.kind}` : null)));
    }
    await ctx.reload();
    return out;
  },
};

export const newsletterModule: TestModule = {
  id: "newsletter",
  scope: "combo",
  async run(ctx) {
    const forms = await formsOfKinds(ctx, ["newsletter"]);
    if (!forms.length) {
      return [outcome.notApplicable(spec("newsletter", "none", { title: "Newsletter sign-up", feature: "Newsletter form", element: "form", steps: ["Inspect the page"], expected: "Newsletter sign-up works" }), "No newsletter sign-up form was found on this page.")];
    }
    const out: CheckOutcome[] = [];
    for (const [index, form] of forms.entries()) {
      const fc: FormCaseContext = { ctx, module: "newsletter", form, index };
      out.push(await caseEmptyRequired(fc));
      const email = form.fields.find(isEmailField);
      if (email) out.push(await caseInvalidValue(fc, email, "not-an-email", "email address", email.type === "email" || !!email.pattern));
      out.push(await caseRealSubmit(fc, "newsletter"));
    }
    await ctx.reload();
    return out;
  },
};

export const loginModule: TestModule = {
  id: "login",
  scope: "combo",
  async run(ctx) {
    const forms = await formsOfKinds(ctx, ["login"]);
    if (!forms.length) {
      return [outcome.notApplicable(spec("login", "none", { title: "Login", feature: "Login form", element: "form with password field", steps: ["Inspect the page"], expected: "Login works" }), "No login form was found on this page.")];
    }
    const out: CheckOutcome[] = [];
    const form = forms[0];
    const fc: FormCaseContext = { ctx, module: "login", form, index: 0 };
    out.push(await caseEmptyRequired(fc));

    const s = formSpec(fc, "invalid-credentials", "NEGATIVE", "invalid credentials are refused", {
      testData: `${INVALID_LOGIN_IDENTITY} / random password`,
      preconditions: "Real submission enabled for this run. One attempt only (never repeated, no brute force).",
      steps: ["Enter a reserved, non-existent identity and a random password", "Submit once", "Check that access is refused"],
      expected: "The login is refused with an error and no signed-in area is shown",
    });
    if (!ctx.options.allowFormSubmission) out.push(outcome.notExecuted(s, "Real form submission is disabled for this run, so invalid credentials were not sent."));
    else if (form.hasCaptcha) out.push(outcome.notExecuted(s, "The login form is protected by a CAPTCHA; automated attempts are not made."));
    else if (!ctx.isPrimaryCombo || ctx.formLedger.hasSubmitted("login-invalid", form.fingerprint)) out.push(outcome.notExecuted(s, "An invalid-login attempt was already made for this form; it is not repeated."));
    else {
      const current = await fresh(fc);
      if (!current) out.push(outcome.notExecuted(s, "Page could not be reloaded."));
      else {
        const user = current.fields.find((f) => f.visible && f.type !== "password" && f.type !== "checkbox");
        const pass = current.fields.find((f) => f.type === "password");
        if (!user || !pass) out.push(outcome.notExecuted(s, "Could not identify the username and password fields."));
        else {
          ctx.formLedger.record("login-invalid", form.fingerprint, ctx.url);
          const page = ctx.session.page;
          const beforeUrl = page.url();
          await locate(ctx, user.qid).fill(INVALID_LOGIN_IDENTITY, { timeout: 3_000 }).catch(() => undefined);
          await locate(ctx, pass.qid).fill(`Invalid-${Math.random().toString(36).slice(2, 10)}!`, { timeout: 3_000 }).catch(() => undefined);
          const nav = page.waitForNavigation({ timeout: 10_000 }).catch(() => null);
          if (current.submitQid) await locate(ctx, current.submitQid).click({ timeout: 4_000 }).catch(() => undefined);
          else await locate(ctx, pass.qid).press("Enter").catch(() => undefined);
          const response = await nav;
          await settle(ctx, 1500);
          const shot = await ctx.capture("After invalid login attempt");
          const ev = shot ? [shot] : [];
          const stillHasPassword = (await page.locator('input[type="password"]').count().catch(() => 0)) > 0;
          const errors = (await formValidationState(page, current.qid).catch(() => null))?.errorTexts ?? [];
          const loggedIn = (await page.locator("a, button").filter({ hasText: /log ?out|sign ?out/i }).count().catch(() => 0)) > 0;
          if (response && response.status() >= 500) out.push(outcome.fail(s, `Login request returned HTTP ${response.status()}`, [evidence.http("Login response", `Status ${response.status()} at ${page.url()}`), ...ev]));
          else if (loggedIn && !stillHasPassword) out.push(outcome.fail(s, "A signed-in area (logout control) appeared after submitting invalid credentials", ev));
          else if (stillHasPassword && errors.length) out.push(outcome.pass(s, `Login refused: "${errors[0]}"`, [`Error message: ${errors[0]}`, "Password field still present (not signed in)"], { evidence: ev }));
          else if (stillHasPassword) out.push(outcome.pass(s, "Login refused: still on the login form", ["Password field still present after submission", `URL ${beforeUrl} → ${page.url()}`], { evidence: ev }));
          else out.push(outcome.warn(s, `Left the login form (now at ${page.url()}); outcome unclear`, { evidence: ev }));
        }
      }
    }
    out.push(outcome.notExecuted(formSpec(fc, "valid-credentials", "POSITIVE", "valid credentials sign in", { steps: [], expected: "User is signed in" }), "No test credentials are configured for this project."));
    await ctx.reload();
    return out;
  },
};

export const logoutModule: TestModule = {
  id: "logout",
  scope: "page",
  async run() {
    return [
      outcome.notExecuted(
        spec("logout", "requires-login", { title: "Logout ends the session", feature: "Logout", element: "logout control", steps: ["Sign in", "Log out", "Open a protected page"], expected: "Session ends; protected pages require sign-in again" }),
        "Logout testing needs a signed-in session, which requires test credentials that are not configured.",
      ),
    ];
  },
};
