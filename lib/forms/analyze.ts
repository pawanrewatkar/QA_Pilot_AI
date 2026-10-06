import type { Page } from "playwright";
import { runScript } from "@/lib/testing/browser-scripts";

export type FormKind = "login" | "signup" | "newsletter" | "contact" | "search" | "payment" | "generic";

export interface FormField {
  qid: string;
  tag: "input" | "textarea" | "select";
  type: string;
  name: string;
  label: string;
  required: boolean;
  minLength: number | null;
  maxLength: number | null;
  min: string | null;
  max: string | null;
  step: string | null;
  pattern: string | null;
  /** False when the pattern attribute is not a valid regular expression (browsers then ignore it). */
  patternValid: boolean;
  autocomplete: string;
  /** True when the field has an accessible label (label element, aria-label, aria-labelledby or title); placeholders do not count. */
  hasLabel: boolean;
  options: string[];
  visible: boolean;
}

export interface AnalyzedForm {
  qid: string;
  kind: FormKind;
  method: string;
  action: string;
  noValidate: boolean;
  visible: boolean;
  hasCaptcha: boolean;
  submitQid: string | null;
  submitText: string;
  fingerprint: string;
  fields: FormField[];
  text: string;
}

export interface FieldValidity {
  valid: boolean;
  valueMissing: boolean;
  typeMismatch: boolean;
  patternMismatch: boolean;
  tooLong: boolean;
  tooShort: boolean;
  rangeUnderflow: boolean;
  rangeOverflow: boolean;
  badInput: boolean;
  message: string;
  value: string;
  ariaInvalid: string | null;
}

export interface FormValidationState {
  formValid: boolean;
  invalidFields: { name: string; message: string }[];
  ariaInvalidCount: number;
  errorTexts: string[];
}

const ANALYZE_SCRIPT = String.raw`() => {
  let counter = 0;
  const tag = (el, p) => { if (!el.getAttribute("data-qap")) el.setAttribute("data-qap", p + "-" + (counter++)); return el.getAttribute("data-qap"); };
  const txt = (el) => (el && el.textContent ? el.textContent.replace(/\s+/g, " ").trim() : "");
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  const labelOf = (el) => {
    const byFor = el.id ? document.querySelector('label[for="' + CSS.escape(el.id) + '"]') : null;
    const wrap = el.closest("label");
    return (txt(byFor) || txt(wrap) || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.name || "").slice(0, 80);
  };
  const num = (v) => (v === null || v === "" || isNaN(Number(v)) || Number(v) < 0 ? null : Number(v));
  const forms = [];
  for (const form of document.querySelectorAll("form")) {
    const fields = [];
    for (const el of form.querySelectorAll("input, textarea, select")) {
      const type = (el.getAttribute("type") || (el.tagName === "INPUT" ? "text" : el.tagName.toLowerCase())).toLowerCase();
      if (["hidden", "submit", "button", "reset", "image"].includes(type)) continue;
      fields.push({
        qid: tag(el, "ff"), tag: el.tagName.toLowerCase(), type, name: el.name || el.id || "", label: labelOf(el), hasLabel: !!((el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]')) || el.closest("label") || (el.getAttribute("aria-label") || "").trim() || el.getAttribute("aria-labelledby") || (el.getAttribute("title") || "").trim()),
        required: el.required || el.getAttribute("aria-required") === "true",
        minLength: num(el.getAttribute("minlength")), maxLength: num(el.getAttribute("maxlength")),
        min: el.getAttribute("min"), max: el.getAttribute("max"), step: el.getAttribute("step"), pattern: el.getAttribute("pattern"),
        patternValid: (() => { const p = el.getAttribute("pattern"); if (p === null) return true; try { new RegExp("^(?:" + p + ")$", "v"); return true; } catch (e) { try { new RegExp("^(?:" + p + ")$", "u"); return false; } catch (e2) { return false; } } })(),
        autocomplete: (el.getAttribute("autocomplete") || "").toLowerCase(),
        options: el.tagName === "SELECT" ? Array.from(el.options).map((o) => o.value) : [],
        visible: visible(el),
      });
    }
    const submit = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
    const text = (txt(form) + " " + (form.getAttribute("class") || "") + " " + (form.id || "") + " " + (form.getAttribute("action") || "")).toLowerCase();
    const pw = fields.filter((f) => f.type === "password").length;
    const emails = fields.filter((f) => f.type === "email" || /e-?mail/i.test(f.name + " " + f.label));
    const visibleText = fields.filter((f) => f.type !== "checkbox" && f.type !== "radio");
    const payment = fields.some((f) => /cc-|card|cvv|cvc|iban|expiry|exp-date/.test(f.autocomplete + " " + f.name.toLowerCase())) || !!form.querySelector('iframe[src*="stripe" i], iframe[src*="braintree" i], iframe[name*="card" i]');
    const searchy = fields.length > 0 && fields.every((f) => f.type === "search" || /^(q|s|search|query|keyword)$/i.test(f.name)) || form.getAttribute("role") === "search";
    let kind = "generic";
    if (payment) kind = "payment";
    else if (pw >= 2 || (pw === 1 && /sign ?up|register|create (an )?account/.test(text))) kind = "signup";
    else if (pw === 1) kind = "login";
    else if (searchy) kind = "search";
    else if (emails.length === 1 && visibleText.length <= 3 && /newsletter|subscribe|mailing list|updates|sign up for/.test(text)) kind = "newsletter";
    else if (fields.some((f) => f.tag === "textarea") && emails.length >= 1) kind = "contact";
    forms.push({
      qid: tag(form, "form"), kind, method: (form.getAttribute("method") || "get").toLowerCase(), action: form.action || location.href,
      noValidate: form.noValidate, visible: visible(form) || fields.some((f) => f.visible),
      hasCaptcha: !!form.querySelector('.g-recaptcha, .h-captcha, .cf-turnstile, iframe[src*="recaptcha"], iframe[src*="hcaptcha"], [data-sitekey]'),
      submitQid: submit ? tag(submit, "fsub") : null, submitText: submit ? (txt(submit) || submit.getAttribute("value") || "") : "",
      fingerprint: (new URL(form.action || location.href, location.href).pathname) + "|" + form.getAttribute("method") + "|" + fields.map((f) => f.name).join(","),
      fields, text: txt(form).slice(0, 200),
    });
  }
  return forms;
}`;

const FIELD_VALIDITY_SCRIPT = String.raw`(qid) => {
  const el = document.querySelector('[data-qap="' + qid + '"]');
  if (!el || !el.validity) return null;
  const v = el.validity;
  return { valid: v.valid, valueMissing: v.valueMissing, typeMismatch: v.typeMismatch, patternMismatch: v.patternMismatch, tooLong: v.tooLong,
    tooShort: v.tooShort, rangeUnderflow: v.rangeUnderflow, rangeOverflow: v.rangeOverflow, badInput: v.badInput,
    message: el.validationMessage || "", value: String(el.value), ariaInvalid: el.getAttribute("aria-invalid") };
}`;

const FORM_STATE_SCRIPT = String.raw`(qid) => {
  const form = document.querySelector('[data-qap="' + qid + '"]');
  if (!form) return null;
  const shown = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  const invalid = Array.from(form.querySelectorAll("input, textarea, select")).filter((el) => el.willValidate && !el.checkValidity());
  const scope = form.parentElement || form;
  const errors = Array.from(scope.querySelectorAll('[role="alert"], .error, .errors, .invalid-feedback, .field-error, .form-error, [class*="error-message" i], [id*="error" i], [aria-live="assertive"], [aria-live="polite"]'))
    .filter((e) => shown(e) && (e.textContent || "").trim().length > 0).map((e) => e.textContent.replace(/\s+/g, " ").trim().slice(0, 160));
  return { formValid: invalid.length === 0, invalidFields: invalid.map((el) => ({ name: el.name || el.id || el.type, message: el.validationMessage || "" })),
    ariaInvalidCount: form.querySelectorAll('[aria-invalid="true"]').length, errorTexts: errors.slice(0, 10) };
}`;

export function analyzeForms(page: Page): Promise<AnalyzedForm[]> {
  return runScript<AnalyzedForm[]>(page, ANALYZE_SCRIPT);
}

export function fieldValidity(page: Page, qid: string): Promise<FieldValidity | null> {
  return runScript<FieldValidity | null>(page, FIELD_VALIDITY_SCRIPT, qid);
}

export function formValidationState(page: Page, qid: string): Promise<FormValidationState | null> {
  return runScript<FormValidationState | null>(page, FORM_STATE_SCRIPT, qid);
}
