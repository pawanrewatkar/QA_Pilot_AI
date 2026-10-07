/**
 * Removes secrets and unnecessary personal data from text before it is stored in a bug or written
 * to a report. Screenshots are masked separately at capture time (lib/playwright/masking.ts).
 */

const SENSITIVE_PARAM = /^(password|passwd|pwd|pass|token|access_token|refresh_token|id_token|auth|authorization|api[_-]?key|apikey|secret|client_secret|session|sessionid|session_id|sid|signature|sig|otp|code|key|jwt)$/i;

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return email;
  return `${local.slice(0, 1)}***@${domain}`;
}

/** Redacts query-string values whose parameter name suggests a secret. */
function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    let changed = false;
    if (u.username || u.password) {
      u.username = "redacted";
      u.password = "";
      changed = true;
    }
    for (const key of [...u.searchParams.keys()]) {
      if (SENSITIVE_PARAM.test(key)) {
        u.searchParams.set(key, "[redacted]");
        changed = true;
      }
    }
    return changed ? u.href.replace(/%5Bredacted%5D/gi, "[redacted]") : url;
  } catch {
    return url;
  }
}

export function redactText(input: string | null | undefined): string {
  if (!input) return input ?? "";
  let s = input;
  s = s.replace(/https?:\/\/[^\s"'<>)\]]+/g, (m) => redactUrl(m));
  s = s.replace(/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/g, "$1 [redacted]");
  s = s.replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, "[redacted-jwt]");
  s = s.replace(/(["']?(?:password|passwd|pwd|secret|api[_-]?key|token|access_token|client_secret)["']?\s*[:=]\s*)(["']?)[^\s"',;&]+\2/gi, "$1$2[redacted]$2");
  s = s.replace(/\b(?:\d[ -]?){13,19}\b/g, (m) => {
    const digits = m.replace(/\D/g, "");
    return digits.length >= 13 && digits.length <= 19 && luhn(digits) ? "[redacted-card]" : m;
  });
  s = s.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, (m) => maskEmail(m));
  return s;
}

/** Applies redactText to every string value of a plain object (shallow). */
export function redactRecord<T extends Record<string, unknown>>(row: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = typeof v === "string" ? redactText(v) : v;
  return out as T;
}
