import { chromium, firefox, webkit, type Browser, type BrowserContext, type BrowserType } from "playwright";
import type { BrowserName, Viewport } from "@/types";
import { classifyBrowserError, describeBrowserError } from "./errors";

const ENGINES: Record<BrowserName, BrowserType> = { chromium, firefox, webkit };

export class BrowserLaunchError extends Error {
  constructor(
    readonly browser: BrowserName,
    message: string,
  ) {
    super(message);
    this.name = "BrowserLaunchError";
  }
}

/** Launches a headless browser engine. Startup failures are converted into a descriptive error. */
export async function launchBrowser(name: BrowserName, options: { timeoutMs?: number } = {}): Promise<Browser> {
  try {
    return await ENGINES[name].launch({ headless: true, timeout: options.timeoutMs ?? 60_000 });
  } catch (error) {
    throw new BrowserLaunchError(name, describeBrowserError(classifyBrowserError(error)));
  }
}

export interface ContextOptions {
  viewport: Viewport;
  /** Accept self-signed certificates? Off by default so SSL problems are reported, not hidden. */
  ignoreHttpsErrors?: boolean;
}

/** Creates an isolated context (fresh cookies/storage) with the requested viewport. */
export async function createContext(browser: Browser, options: ContextOptions): Promise<BrowserContext> {
  const isMobile = options.viewport.kind === "mobile";
  return browser.newContext({
    viewport: { width: options.viewport.width, height: options.viewport.height },
    // Firefox does not support isMobile; touch + mobile UA hints are enough for responsive layouts.
    isMobile: isMobile && browser.browserType().name() !== "firefox",
    hasTouch: isMobile,
    deviceScaleFactor: 1,
    // The engine's real user agent is kept so sites render exactly as they do for visitors.
    acceptDownloads: true,
    ignoreHTTPSErrors: options.ignoreHttpsErrors ?? false,
    serviceWorkers: "block",
    locale: "en-US",
  });
}
