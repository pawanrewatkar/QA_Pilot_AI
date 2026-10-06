export type BrowserErrorKind =
  | "TIMEOUT"
  | "DNS"
  | "SSL"
  | "CONNECTION"
  | "BLOCKED"
  | "CRASH"
  | "INVALID_URL"
  | "BROWSER_LAUNCH"
  | "UNKNOWN";

export interface ClassifiedError {
  kind: BrowserErrorKind;
  message: string;
}

const RULES: [BrowserErrorKind, RegExp][] = [
  ["TIMEOUT", /timeout|timed out/i],
  ["DNS", /ERR_NAME_NOT_RESOLVED|NS_ERROR_UNKNOWN_HOST|hostname could not be found|getaddrinfo|ENOTFOUND/i],
  ["SSL", /ERR_CERT|ERR_SSL|SSL_ERROR|SEC_ERROR|certificate|NS_ERROR_NET_INADEQUATE_SECURITY/i],
  ["CONNECTION", /ERR_CONNECTION|ECONNREFUSED|NS_ERROR_CONNECTION_REFUSED|NS_ERROR_NET_RESET|ERR_EMPTY_RESPONSE|Could not connect|network connection was lost/i],
  ["BLOCKED", /ERR_BLOCKED_BY|blocked by|NS_ERROR_CONTENT_BLOCKED/i],
  ["CRASH", /crash|Target closed|has been closed|Target page, context or browser/i],
  ["INVALID_URL", /invalid url|Cannot navigate to invalid URL|ERR_INVALID_URL|malformed/i],
  ["BROWSER_LAUNCH", /Executable doesn't exist|Failed to launch|browserType\.launch/i],
];

/** Maps Chromium / Firefox / WebKit error messages onto a small, engine-independent set of kinds. */
export function classifyBrowserError(error: unknown): ClassifiedError {
  const raw = error instanceof Error ? error.message : String(error);
  const firstLine = raw.split("\n").find((l) => l.trim()) ?? raw;
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError") return { kind: "TIMEOUT", message: firstLine.slice(0, 300) };
  for (const [kind, re] of RULES) if (re.test(raw)) return { kind, message: firstLine.slice(0, 300) };
  return { kind: "UNKNOWN", message: firstLine.slice(0, 300) };
}

export function describeBrowserError(e: ClassifiedError): string {
  switch (e.kind) {
    case "TIMEOUT":
      return `Navigation timed out: ${e.message}`;
    case "DNS":
      return `Domain could not be resolved: ${e.message}`;
    case "SSL":
      return `TLS/SSL certificate error: ${e.message}`;
    case "CONNECTION":
      return `Connection failed: ${e.message}`;
    case "BLOCKED":
      return `Request was blocked: ${e.message}`;
    case "CRASH":
      return `Browser page crashed or closed: ${e.message}`;
    case "INVALID_URL":
      return `Invalid URL: ${e.message}`;
    case "BROWSER_LAUNCH":
      return `Browser could not be launched: ${e.message}. Run "npm run browsers:install".`;
    default:
      return e.message;
  }
}
