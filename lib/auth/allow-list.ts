/**
 * Email allow-list for registration (preparation only).
 *
 * Status: NOT enforced anywhere yet. There is no registration endpoint in this version. When Supabase Auth
 * is added, the server-side sign-up action must call `isEmailAllowed()` before calling Supabase, and must
 * show the same generic message whether or not the address is allowed (no account enumeration). An
 * allow-listed address is never proof of identity: only a verified Supabase session is.
 *
 * Configuration (future): AUTH_ALLOWED_EMAILS, a comma- or newline-separated list of exact addresses
 * and/or domain entries starting with "@" (e.g. "@example.com"). No addresses are hard-coded.
 */

/**
 * Canonical form for comparisons: trimmed, Unicode NFKC, lower-cased. Provider-specific rewriting
 * (Gmail dots or "+tags") is deliberately not applied: the address must match as configured.
 * Returns null for anything that is not a single plausible address.
 */
export function normalizeEmail(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const email = input.normalize("NFKC").trim().toLowerCase();
  if (email.length === 0 || email.length > 254) return null;
  // One "@", a non-empty local part, a dotted domain, no whitespace, control characters, commas or quotes.
  if (!/^[^\s@,;"'<>\u0000-\u001f]+@[^\s@,;"'<>\u0000-\u001f]+\.[^\s@,;"'<>\u0000-\u001f]+$/.test(email)) return null;
  return email;
}

export interface AllowList {
  emails: ReadonlySet<string>;
  /** Domains without the leading "@", lower-case. */
  domains: ReadonlySet<string>;
}

/** Parses the configured list. Invalid entries are ignored (never widen access); an empty list allows no one. */
export function parseAllowList(raw: string | undefined | null): AllowList {
  const emails = new Set<string>();
  const domains = new Set<string>();
  for (const part of (raw ?? "").split(/[,\n]/)) {
    const entry = part.normalize("NFKC").trim().toLowerCase();
    if (!entry) continue;
    if (entry.startsWith("@")) {
      const domain = entry.slice(1);
      if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) domains.add(domain);
      continue;
    }
    const email = normalizeEmail(entry);
    if (email) emails.add(email);
  }
  return { emails, domains };
}

/** True only for a valid address that is listed exactly or whose domain is listed. Fails closed. */
export function isEmailAllowed(email: unknown, list: AllowList): boolean {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  if (list.emails.has(normalized)) return true;
  const domain = normalized.slice(normalized.lastIndexOf("@") + 1);
  return list.domains.has(domain);
}
