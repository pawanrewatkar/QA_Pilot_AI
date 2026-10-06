import type { QueryParamMode } from "@/types";

/** Query parameters that only track marketing attribution and never change page content. */
const TRACKING_PARAMS = new Set([
  "gclid",
  "gbraid",
  "wbraid",
  "fbclid",
  "msclkid",
  "dclid",
  "yclid",
  "mc_cid",
  "mc_eid",
  "_ga",
  "_gl",
  "_hsenc",
  "_hsmi",
  "igshid",
  "ref_src",
  "si",
]);

/** File extensions that are not HTML pages: they are checked as links/downloads, never crawled. */
export const NON_HTML_EXTENSIONS = new Set([
  "pdf", "zip", "rar", "7z", "gz", "tar", "tgz", "dmg", "exe", "msi", "apk",
  "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "csv", "txt", "rtf", "xml", "json",
  "jpg", "jpeg", "png", "gif", "webp", "svg", "ico", "bmp", "tif", "tiff", "avif",
  "mp3", "wav", "ogg", "mp4", "webm", "mov", "avi", "mkv",
  "css", "js", "mjs", "map", "woff", "woff2", "ttf", "otf", "eot",
]);

export const DOWNLOAD_EXTENSIONS = new Set([
  "pdf", "zip", "rar", "7z", "gz", "tar", "tgz", "dmg", "exe", "msi", "apk",
  "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "csv", "rtf", "mp3", "mp4",
]);

/** Path segments that change state when visited and must never be crawled automatically. */
const UNSAFE_SEGMENTS = new Set([
  "logout", "log-out", "signout", "sign-out", "logoff", "log-off", "unsubscribe", "delete", "remove", "destroy",
  "empty-cart", "clear-cart", "cancel-subscription", "deactivate",
]);

export interface NormalizeOptions {
  queryParams?: QueryParamMode;
}

export function isTrackingParam(name: string): boolean {
  const n = name.toLowerCase();
  return n.startsWith("utm_") || TRACKING_PARAMS.has(n);
}

export function extensionOfPath(pathname: string): string {
  const last = pathname.split("/").pop() ?? "";
  const dot = last.lastIndexOf(".");
  return dot > 0 ? last.slice(dot + 1).toLowerCase() : "";
}

/**
 * Canonical form used for deduplication:
 * - http/https only, lower-case host, default ports removed
 * - fragment removed
 * - duplicate slashes collapsed; trailing slash removed except on the root path
 * - `index.html` / `index.php` collapsed to the directory
 * - query parameters filtered per `queryParams` and sorted for stable comparison
 * Returns null for anything that is not a crawlable http(s) URL.
 */
export function normalizeCrawlUrl(input: string, base?: string, options: NormalizeOptions = {}): string | null {
  let url: URL;
  try {
    url = base ? new URL(input, base) : new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;

  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443")) url.port = "";

  let pathname = url.pathname.replace(/\/{2,}/g, "/");
  pathname = pathname.replace(/\/index\.(html?|php|aspx?)$/i, "/");
  if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);
  url.pathname = pathname || "/";

  const mode = options.queryParams ?? "strip-tracking";
  if (mode === "strip-all") {
    url.search = "";
  } else {
    const entries = [...url.searchParams.entries()].filter(([k]) => mode === "keep" || !isTrackingParam(k));
    entries.sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv));
    url.search = entries.length ? `?${new URLSearchParams(entries).toString()}` : "";
  }
  return url.href;
}

function siteHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "");
}

/**
 * Same-domain rule. `www.` is ignored; subdomains are allowed only when requested.
 * Lookalikes (`example.com.evil.io`, `notexample.com`) never match.
 */
export function isInScope(rootUrl: string, candidate: string, includeSubdomains: boolean): boolean {
  try {
    const root = new URL(rootUrl);
    const target = new URL(candidate);
    const a = siteHost(root.hostname);
    const b = siteHost(target.hostname);
    if (a === b) return true;
    return includeSubdomains && b.endsWith(`.${a}`);
  } catch {
    return false;
  }
}

/** Converts a user exclusion (substring, or glob with `*`) into a matcher over path + query. */
export function compileExclusion(pattern: string): (pathAndQuery: string) => boolean {
  const p = pattern.trim();
  if (!p) return () => false;
  if (!p.includes("*")) return (s) => s.toLowerCase().includes(p.toLowerCase());
  const re = new RegExp(`^${p.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i");
  return (s) => re.test(s);
}

export function isUnsafeToVisit(url: string): boolean {
  try {
    const u = new URL(url);
    const segments = u.pathname.toLowerCase().split("/").filter(Boolean).map((s) => s.replace(/\.(php|aspx?|html?|jsp)$/, ""));
    return segments.some((s) => UNSAFE_SEGMENTS.has(s)) || /[?&](action|do|mode)=(logout|signout|delete|remove|unsubscribe)\b/i.test(u.search);
  } catch {
    return true;
  }
}

/**
 * Detects URL shapes that typically generate infinite page spaces (calendars, recursive paths,
 * session ids): very deep paths, a segment repeated 3+ times, or extremely long query strings.
 */
export function looksLikeCrawlTrap(url: string): boolean {
  try {
    const u = new URL(url);
    const segments = u.pathname.split("/").filter(Boolean);
    if (segments.length > 12) return true;
    const counts = new Map<string, number>();
    for (const s of segments) counts.set(s, (counts.get(s) ?? 0) + 1);
    if ([...counts.values()].some((c) => c >= 3)) return true;
    if (u.search.length > 300) return true;
    if (/[?&](jsessionid|phpsessid|sid|sessionid)=/i.test(u.search) || /;jsessionid=/i.test(u.pathname)) return true;
    return false;
  } catch {
    return true;
  }
}

/** Ordered, de-duplicating URL set keyed by normalized URL. */
export class UrlFrontier<T> {
  private readonly seen = new Set<string>();
  private readonly queue: { url: string; data: T }[] = [];

  /** Returns false if the URL was already known. */
  add(normalizedUrl: string, data: T): boolean {
    if (this.seen.has(normalizedUrl)) return false;
    this.seen.add(normalizedUrl);
    this.queue.push({ url: normalizedUrl, data });
    return true;
  }

  has(normalizedUrl: string): boolean {
    return this.seen.has(normalizedUrl);
  }

  /** Marks a URL as known without queueing it (e.g. a redirect target already handled). */
  markSeen(normalizedUrl: string): void {
    this.seen.add(normalizedUrl);
  }

  next(): { url: string; data: T } | undefined {
    return this.queue.shift();
  }

  get size(): number {
    return this.seen.size;
  }

  get pending(): number {
    return this.queue.length;
  }
}
