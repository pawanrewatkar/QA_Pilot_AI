/** Product token used in robots.txt matching and the User-Agent header. */
export const CRAWLER_TOKEN = "QAPilotAI";
export const USER_AGENT = `Mozilla/5.0 (compatible; ${CRAWLER_TOKEN}/0.2; authorized website QA testing)`;

export type HttpErrorKind =
  | "INVALID_URL"
  | "UNSUPPORTED_PROTOCOL"
  | "TIMEOUT"
  | "DNS"
  | "CONNECTION_REFUSED"
  | "CONNECTION_RESET"
  | "SSL"
  | "TOO_MANY_REDIRECTS"
  | "REDIRECT_LOOP"
  | "NETWORK";

export interface RedirectHop {
  url: string;
  status: number;
}

export interface HttpResult {
  ok: boolean;
  status: number | null;
  finalUrl: string;
  chain: RedirectHop[];
  contentType: string | null;
  contentLength: number | null;
  body?: string;
  error?: { kind: HttpErrorKind; message: string };
  durationMs: number;
}

export interface FetchOptions {
  method?: "GET" | "HEAD";
  timeoutMs?: number;
  maxRedirects?: number;
  readBody?: boolean;
  maxBodyBytes?: number;
  /** Called for every redirect target; returning false stops following (result keeps the 3xx). */
  allowRedirect?: (from: string, to: string) => boolean;
  signal?: AbortSignal;
}

const SSL_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_NOT_YET_VALID",
  "ERR_SSL_WRONG_VERSION_NUMBER",
  "EPROTO",
]);

export function classifyFetchError(error: unknown): { kind: HttpErrorKind; message: string } {
  const err = error as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  const code = err?.cause?.code ?? "";
  const message = err?.cause?.message ?? err?.message ?? String(error);
  if (err?.name === "TimeoutError" || err?.name === "AbortError" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "UND_ERR_HEADERS_TIMEOUT") {
    return { kind: "TIMEOUT", message: "Request timed out" };
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return { kind: "DNS", message: `Domain could not be resolved (${code})` };
  if (code === "ECONNREFUSED") return { kind: "CONNECTION_REFUSED", message: "Connection refused" };
  if (code === "ECONNRESET" || code === "UND_ERR_SOCKET") return { kind: "CONNECTION_RESET", message: "Connection reset by server" };
  if (SSL_CODES.has(code) || /certificate|ssl|tls/i.test(message)) return { kind: "SSL", message: `TLS/SSL error: ${code || message}` };
  return { kind: "NETWORK", message: message.slice(0, 300) };
}

/**
 * Fetches a URL following redirects manually, so every hop is visible and can be vetoed
 * (e.g. a redirect leaving the site). Never throws; failures are returned as `error`.
 */
export async function fetchUrl(input: string, options: FetchOptions = {}): Promise<HttpResult> {
  const started = Date.now();
  const method = options.method ?? "GET";
  const maxRedirects = options.maxRedirects ?? 10;
  const chain: RedirectHop[] = [];
  const visited = new Set<string>();
  let current = input;

  const done = (partial: Omit<HttpResult, "chain" | "durationMs">): HttpResult => ({ ...partial, chain, durationMs: Date.now() - started });

  for (let hop = 0; ; hop++) {
    let url: URL;
    try {
      url = new URL(current);
    } catch {
      return done({ ok: false, status: null, finalUrl: current, contentType: null, contentLength: null, error: { kind: "INVALID_URL", message: "Malformed URL" } });
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return done({ ok: false, status: null, finalUrl: current, contentType: null, contentLength: null, error: { kind: "UNSUPPORTED_PROTOCOL", message: `Unsupported protocol ${url.protocol}` } });
    }
    if (visited.has(url.href)) {
      return done({ ok: false, status: null, finalUrl: url.href, contentType: null, contentLength: null, error: { kind: "REDIRECT_LOOP", message: "Redirect loop detected" } });
    }
    visited.add(url.href);

    const timeout = AbortSignal.timeout(options.timeoutMs ?? 15_000);
    const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        redirect: "manual",
        signal,
        headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
      });
    } catch (error) {
      return done({ ok: false, status: null, finalUrl: url.href, contentType: null, contentLength: null, error: classifyFetchError(error) });
    }

    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      chain.push({ url: url.href, status: response.status });
      await response.body?.cancel().catch(() => undefined);
      if (hop >= maxRedirects) {
        return done({ ok: false, status: response.status, finalUrl: url.href, contentType: null, contentLength: null, error: { kind: "TOO_MANY_REDIRECTS", message: `More than ${maxRedirects} redirects` } });
      }
      const next = new URL(location, url).href;
      if (options.allowRedirect && !options.allowRedirect(url.href, next)) {
        return done({ ok: false, status: response.status, finalUrl: next, contentType: null, contentLength: null });
      }
      current = next;
      continue;
    }

    const contentType = response.headers.get("content-type");
    const lengthHeader = response.headers.get("content-length");
    let body: string | undefined;
    if (options.readBody && method === "GET") {
      body = await readLimited(response, options.maxBodyBytes ?? 5 * 1024 * 1024);
    } else {
      await response.body?.cancel().catch(() => undefined);
    }
    return done({
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      finalUrl: url.href,
      contentType,
      contentLength: lengthHeader ? Number(lengthHeader) : null,
      body,
    });
  }
}

async function readLimited(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
