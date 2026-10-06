import { DOWNLOAD_EXTENSIONS, extensionOfPath } from "@/lib/crawler/normalize";
import { fetchUrl, type HttpResult } from "@/lib/net/http";
import type { TestResultStatus } from "@/types";

export type LinkKind = "internal" | "external" | "mailto" | "tel" | "download" | "social" | "anchor" | "javascript" | "other-scheme" | "empty";

const SOCIAL_HOSTS = [
  "facebook.com", "fb.com", "twitter.com", "x.com", "linkedin.com", "instagram.com", "youtube.com", "youtu.be",
  "tiktok.com", "pinterest.com", "github.com", "threads.net", "reddit.com", "snapchat.com", "whatsapp.com",
  "wa.me", "t.me", "telegram.me", "medium.com", "discord.gg", "discord.com", "vimeo.com", "tumblr.com", "bsky.app",
];

/** Hosts that commonly refuse automated clients (bot protection) even though the link works for people. */
const BOT_PROTECTED_STATUSES = new Set([401, 403, 405, 406, 429, 451, 999]);

export function isSocialHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
  return SOCIAL_HOSTS.some((s) => h === s || h.endsWith(`.${s}`));
}

export function classifyLinkKind(rawHref: string, resolvedHref: string, pageUrl: string, hasDownloadAttr: boolean): LinkKind {
  const raw = rawHref.trim();
  if (!raw) return "empty";
  if (raw.startsWith("#")) return "anchor";
  const lower = raw.toLowerCase();
  if (lower.startsWith("mailto:")) return "mailto";
  if (lower.startsWith("tel:")) return "tel";
  if (lower.startsWith("javascript:")) return "javascript";
  let url: URL;
  try {
    url = new URL(resolvedHref);
  } catch {
    return "other-scheme";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "other-scheme";
  if (hasDownloadAttr || DOWNLOAD_EXTENSIONS.has(extensionOfPath(url.pathname))) return "download";
  if (isSocialHost(url.hostname)) return "social";
  const pageHost = new URL(pageUrl).hostname.replace(/^www\./, "");
  const host = url.hostname.replace(/^www\./, "");
  return host === pageHost || host.endsWith(`.${pageHost}`) ? "internal" : "external";
}

const EMAIL = /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[^\s@<>()[\],;:"]{2,}$/;

export function validateMailto(href: string): { valid: boolean; detail: string } {
  const body = href.slice("mailto:".length);
  const [addresses, query = ""] = body.split("?");
  const list = decodeURIComponent(addresses)
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);
  if (list.length === 0) {
    // mailto:?subject=… is valid only if a `to` parameter supplies the address.
    const to = new URLSearchParams(query).get("to");
    if (to && EMAIL.test(to)) return { valid: true, detail: `Recipient from "to" parameter: ${to}` };
    return { valid: false, detail: "mailto link has no recipient address" };
  }
  const bad = list.filter((a) => !EMAIL.test(a));
  return bad.length ? { valid: false, detail: `Invalid address: ${bad.join(", ")}` } : { valid: true, detail: `Recipient: ${list.join(", ")}` };
}

export function validateTel(href: string): { valid: boolean; detail: string } {
  const number = decodeURIComponent(href.slice("tel:".length)).trim();
  const digits = number.replace(/[\s().\-/]/g, "").replace(/^\+/, "");
  if (!/^\d+([;,pw].*)?$/i.test(digits)) return { valid: false, detail: `"${number}" contains characters that are not part of a phone number` };
  const core = digits.match(/^\d+/)![0];
  if (core.length < 3 || core.length > 15) return { valid: false, detail: `"${number}" has ${core.length} digits (expected 3–15)` };
  return { valid: true, detail: `Dialable number: ${number}` };
}

export interface LinkVerdict {
  status: TestResultStatus;
  actual: string;
  /** True when the verdict is a definite failure backed by an HTTP / network observation. */
  definite: boolean;
}

/**
 * Turns an HTTP observation into a verdict without over-claiming:
 * - 2xx (after any redirects) → PASS
 * - 404 / 410 → FAIL; 5xx confirmed on retry → FAIL; DNS failure → FAIL
 * - Bot-protection / auth responses (401, 403, 429, 999 …), timeouts, TLS problems and other
 *   unusual responses → WARNING (needs manual review; not proof the link is broken)
 */
export function classifyLinkResponse(result: HttpResult, retryResult?: HttpResult): LinkVerdict {
  const hops = result.chain.length ? ` after ${result.chain.length} redirect${result.chain.length > 1 ? "s" : ""}` : "";
  if (result.error) {
    switch (result.error.kind) {
      case "DNS":
        return { status: "FAIL", actual: `Destination domain does not resolve (${result.error.message})`, definite: true };
      case "INVALID_URL":
        return { status: "FAIL", actual: "Link destination is not a valid URL", definite: true };
      case "TOO_MANY_REDIRECTS":
      case "REDIRECT_LOOP":
        return { status: "FAIL", actual: `Redirect problem: ${result.error.message}`, definite: true };
      case "CONNECTION_REFUSED":
        return { status: "WARNING", actual: "Connection refused by the destination server", definite: false };
      case "SSL":
        return { status: "WARNING", actual: result.error.message, definite: false };
      case "TIMEOUT":
        return { status: "WARNING", actual: "Destination did not respond before the timeout", definite: false };
      default:
        return { status: "WARNING", actual: `Network error: ${result.error.message}`, definite: false };
    }
  }
  const status = result.status ?? 0;
  if (status >= 200 && status < 300) return { status: "PASS", actual: `HTTP ${status}${hops}`, definite: false };
  if (status === 404 || status === 410) return { status: "FAIL", actual: `HTTP ${status} (${status === 404 ? "Not Found" : "Gone"})${hops}`, definite: true };
  if (status >= 500) {
    const confirmed = retryResult && retryResult.status !== null && retryResult.status >= 500;
    return confirmed
      ? { status: "FAIL", actual: `HTTP ${status} server error (reproduced on retry: HTTP ${retryResult!.status})${hops}`, definite: true }
      : { status: "WARNING", actual: `HTTP ${status} server error, not reproduced on retry (retry: ${retryResult?.status ?? "n/a"})`, definite: false };
  }
  if (BOT_PROTECTED_STATUSES.has(status)) {
    return { status: "WARNING", actual: `HTTP ${status}: destination refused the automated check (often bot protection or login required)`, definite: false };
  }
  if (status >= 300 && status < 400) return { status: "WARNING", actual: `HTTP ${status} redirect without a usable Location header`, definite: false };
  return { status: "WARNING", actual: `Unusual response HTTP ${status}${hops}; needs manual review`, definite: false };
}

export interface LinkCheckRecord {
  url: string;
  result: HttpResult;
  retry?: HttpResult;
  verdict: LinkVerdict;
}

/** Checks each unique URL once per run (HEAD, falling back to GET), with bounded concurrency. */
export class LinkChecker {
  private readonly cache = new Map<string, Promise<LinkCheckRecord>>();
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    private readonly options: { timeoutMs: number; concurrency?: number; fetcher?: typeof fetchUrl; retryDelayMs?: number } = { timeoutMs: 15_000 },
  ) {}

  check(url: string): Promise<LinkCheckRecord> {
    const key = url.split("#")[0];
    let pending = this.cache.get(key);
    if (!pending) {
      pending = this.limit(() => this.perform(key));
      this.cache.set(key, pending);
    }
    return pending;
  }

  private async limit<T>(fn: () => Promise<T>): Promise<T> {
    const max = this.options.concurrency ?? 6;
    if (this.active >= max) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }

  private async perform(url: string): Promise<LinkCheckRecord> {
    const fetcher = this.options.fetcher ?? fetchUrl;
    const timeoutMs = this.options.timeoutMs;
    let result = await fetcher(url, { method: "HEAD", timeoutMs });
    // Many servers mishandle HEAD; confirm anything that is not a clean 2xx with GET.
    if (!result.ok && result.error?.kind !== "DNS" && result.error?.kind !== "INVALID_URL") {
      result = await fetcher(url, { method: "GET", timeoutMs });
    }
    let retry: HttpResult | undefined;
    if (result.status !== null && result.status >= 500) {
      await new Promise((r) => setTimeout(r, this.options.retryDelayMs ?? 1000));
      retry = await fetcher(url, { method: "GET", timeoutMs });
    }
    return { url, result, retry, verdict: classifyLinkResponse(result, retry) };
  }
}
