/**
 * Post-authentication redirect validation. Only same-origin relative paths are accepted, so a crafted
 * `next` parameter can never send a user (or a token in the URL) to another site.
 */
export const DEFAULT_AFTER_LOGIN = "/";
const BASE = "http://qa-pilot.invalid";

/** Returns a safe same-origin path for `raw`, or `fallback`. */
export function safeNextPath(raw: unknown, fallback = DEFAULT_AFTER_LOGIN): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 512) return fallback;
  // Must be a path: one leading slash, no scheme-relative "//", no backslashes, no control characters.
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\") || /[\u0000-\u001f\u007f]/.test(raw)) return fallback;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return fallback;
  }
  if (decoded.startsWith("//") || decoded.includes("\\") || /[\u0000-\u001f\u007f]/.test(decoded)) return fallback;
  let url: URL;
  try {
    url = new URL(raw, BASE);
  } catch {
    return fallback;
  }
  if (url.origin !== BASE) return fallback;
  // Never bounce back into the auth callback (it would try to reuse a one-time token).
  if (url.pathname.startsWith("/auth/confirm")) return fallback;
  return `${url.pathname}${url.search}${url.hash}`;
}
