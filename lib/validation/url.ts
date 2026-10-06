export const MAX_URL_LENGTH = 2048;

export type UrlValidationResult = { ok: true; url: string } | { ok: false; error: string };

const IPV4 = /^(\d{1,3})(\.\d{1,3}){3}$/;

function isPlausibleHost(hostname: string): boolean {
  if (hostname === "localhost") return true;
  if (IPV4.test(hostname)) return hostname.split(".").every((part) => Number(part) <= 255);
  if (hostname.startsWith("[") && hostname.endsWith("]")) return true; // IPv6 literal
  const labels = hostname.split(".");
  return (
    labels.length >= 2 &&
    labels.every((l) => /^[a-z0-9-]{1,63}$/i.test(l) && !l.startsWith("-") && !l.endsWith("-")) &&
    /[a-z]/i.test(labels[labels.length - 1])
  );
}

/**
 * Validates and normalizes a website URL entered by a user.
 * - Adds https:// when no scheme is given.
 * - Allows only http and https.
 * - Rejects embedded credentials and malformed hosts.
 * - Drops the fragment, which never affects what a server returns.
 */
export function normalizeWebsiteUrl(input: string): UrlValidationResult {
  const raw = input.trim();
  if (!raw) return { ok: false, error: "Enter a website URL." };
  if (raw.length > MAX_URL_LENGTH) return { ok: false, error: `URL must be at most ${MAX_URL_LENGTH} characters.` };
  if (/\s/.test(raw)) return { ok: false, error: "URL must not contain spaces." };

  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw);
  if (hasScheme && !/^https?:\/\//i.test(raw)) {
    return { ok: false, error: "Only http:// and https:// URLs are supported." };
  }

  let url: URL;
  try {
    url = new URL(hasScheme ? raw : `https://${raw}`);
  } catch {
    return { ok: false, error: "Enter a valid URL, e.g. https://example.com." };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "Only http:// and https:// URLs are supported." };
  }
  if (url.username || url.password) {
    return { ok: false, error: "URLs must not contain usernames or passwords. Store test credentials separately." };
  }
  if (!isPlausibleHost(url.hostname)) {
    return { ok: false, error: "Enter a valid domain name, e.g. example.com." };
  }

  url.hash = "";
  return { ok: true, url: url.href };
}

function siteHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "");
}

/** True when `candidate` is on the same site as `base` (same host, ignoring www., or a subdomain of it). */
export function isSameSite(base: string, candidate: string): boolean {
  try {
    const a = siteHost(new URL(base).hostname);
    const b = siteHost(new URL(candidate).hostname);
    return a === b || b.endsWith(`.${a}`);
  } catch {
    return false;
  }
}

export function displayHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
