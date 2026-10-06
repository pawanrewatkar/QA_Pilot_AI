import type { BrowserContext, Download, Page, Request } from "playwright";
import { classifyBrowserError, type ClassifiedError } from "./errors";

export interface ConsoleEntry {
  level: "error" | "warning" | "info" | "log" | "debug";
  message: string;
  sourceUrl: string | null;
  line: number | null;
  column: number | null;
  at: string;
}

export interface NetworkEntry {
  url: string;
  method: string;
  resourceType: string;
  status: number | null;
  failure: string | null;
  durationMs: number | null;
  at: string;
}

export interface BlockedRequest {
  method: string;
  url: string;
  resourceType: string;
}

export interface NavigationOutcome {
  ok: boolean;
  status: number | null;
  finalUrl: string;
  error?: ClassifiedError;
  durationMs: number;
}

const CONSOLE_LEVELS: Record<string, ConsoleEntry["level"]> = {
  error: "error",
  warning: "warning",
  warn: "warning",
  info: "info",
  log: "log",
  debug: "debug",
};

/**
 * One browser tab with everything the test engine needs to observe: console output,
 * uncaught page errors, network traffic, downloads and dialogs.
 *
 * "Guarded" mode aborts every non-GET request and every new document navigation, so form
 * validation can be exercised without any data ever reaching the website's server.
 */
export class PageSession {
  readonly console: ConsoleEntry[] = [];
  readonly pageErrors: string[] = [];
  readonly network: NetworkEntry[] = [];
  readonly downloads: Download[] = [];
  readonly dialogs: string[] = [];
  readonly blocked: BlockedRequest[] = [];
  crashed = false;

  /** "all": block writes and navigations; "writes": block only non-GET requests (GET navigation allowed). */
  private guard: false | "all" | "writes" = false;
  private readonly started = new Map<Request, number>();
  /** Response status per request, captured synchronously so failures after a response (e.g. ORB aborts of a 404) keep their status. */
  private readonly statuses = new Map<Request, number>();

  private constructor(readonly page: Page) {}

  static async open(context: BrowserContext): Promise<PageSession> {
    const page = await context.newPage();
    const session = new PageSession(page);
    session.attach();
    await page.route("**/*", (route) => {
      const req = route.request();
      const isNavigation = req.isNavigationRequest() && req.frame() === page.mainFrame();
      if (session.guard && (req.method() !== "GET" || (session.guard === "all" && isNavigation))) {
        session.blocked.push({ method: req.method(), url: req.url(), resourceType: req.resourceType() });
        return route.abort("blockedbyclient");
      }
      return route.continue();
    });
    return session;
  }

  private attach() {
    const page = this.page;
    page.on("console", (msg) => {
      const loc = msg.location();
      this.console.push({
        level: CONSOLE_LEVELS[msg.type()] ?? "log",
        message: msg.text().slice(0, 2000),
        sourceUrl: loc.url || null,
        line: loc.lineNumber ?? null,
        column: loc.columnNumber ?? null,
        at: new Date().toISOString(),
      });
    });
    page.on("pageerror", (err) => this.pageErrors.push(`${err.name}: ${err.message}`.slice(0, 2000)));
    page.on("crash", () => {
      this.crashed = true;
    });
    page.on("dialog", (dialog) => {
      this.dialogs.push(`${dialog.type()}: ${dialog.message()}`.slice(0, 500));
      dialog.dismiss().catch(() => undefined);
    });
    page.on("download", (download) => this.downloads.push(download));
    page.on("request", (req) => this.started.set(req, Date.now()));
    page.on("response", (res) => this.statuses.set(res.request(), res.status()));
    page.on("requestfinished", (req) => this.record(req, null));
    page.on("requestfailed", (req) => this.record(req, req.failure()?.errorText ?? "failed"));
  }

  private record(req: Request, failure: string | null) {
    const start = this.started.get(req);
    const status = this.statuses.get(req) ?? null;
    this.started.delete(req);
    this.statuses.delete(req);
    this.network.push({
      url: req.url(),
      method: req.method(),
      resourceType: req.resourceType(),
      status,
      failure,
      durationMs: start ? Date.now() - start : null,
      at: new Date().toISOString(),
    });
  }

  /** Enables/disables request blocking; returns requests blocked since the last call. */
  setGuard(on: boolean | "writes"): BlockedRequest[] {
    this.guard = on === true ? "all" : on;
    return this.blocked.splice(0);
  }

  async navigate(url: string, timeoutMs: number): Promise<NavigationOutcome> {
    const started = Date.now();
    try {
      const response = await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      // Give client-side rendering a moment; never fail the navigation on a busy network.
      await this.page.waitForLoadState("load", { timeout: Math.min(timeoutMs, 10_000) }).catch(() => undefined);
      await this.page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => undefined);
      const status = response?.status() ?? null;
      return { ok: status === null || status < 400, status, finalUrl: this.page.url(), durationMs: Date.now() - started };
    } catch (error) {
      return { ok: false, status: null, finalUrl: this.page.url(), error: classifyBrowserError(error), durationMs: Date.now() - started };
    }
  }

  /** Marks the current position in every log so a test can read only what happened afterwards. */
  mark() {
    return {
      console: this.console.length,
      pageErrors: this.pageErrors.length,
      network: this.network.length,
      downloads: this.downloads.length,
      dialogs: this.dialogs.length,
    };
  }

  since(m: ReturnType<PageSession["mark"]>) {
    return {
      console: this.console.slice(m.console),
      pageErrors: this.pageErrors.slice(m.pageErrors),
      network: this.network.slice(m.network),
      downloads: this.downloads.slice(m.downloads),
      dialogs: this.dialogs.slice(m.dialogs),
    };
  }

  async close() {
    await this.page.close().catch(() => undefined);
  }
}
