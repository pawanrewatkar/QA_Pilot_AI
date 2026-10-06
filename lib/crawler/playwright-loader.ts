import type { Browser, BrowserContext } from "playwright";
import { createContext, launchBrowser } from "@/lib/playwright/browsers";
import { classifyBrowserError } from "@/lib/playwright/errors";
import { PageSession } from "@/lib/playwright/page-session";
import { VIEWPORTS } from "@/lib/constants/testing";
import type { PageLoader, PageLoadResult } from "./crawler";
import { extractPage } from "./extract";

/** Loads pages in a headless Chromium tab so client-rendered links are discovered too. */
export class PlaywrightPageLoader implements PageLoader {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private session: PageSession | null = null;

  private async ensure(): Promise<PageSession> {
    if (this.session && !this.session.crashed && !this.session.page.isClosed()) return this.session;
    if (this.session) await this.session.close();
    if (!this.browser || !this.browser.isConnected()) {
      this.browser = await launchBrowser("chromium");
      this.context = await createContext(this.browser, { viewport: VIEWPORTS.find((v) => v.id === "desktop-1440x900")! });
    }
    this.session = await PageSession.open(this.context!);
    return this.session;
  }

  async load(url: string, timeoutMs: number): Promise<PageLoadResult> {
    let session: PageSession;
    try {
      session = await this.ensure();
    } catch (error) {
      return { navigation: { ok: false, status: null, finalUrl: url, error: classifyBrowserError(error), durationMs: 0 }, contentType: null, extracted: null };
    }
    let contentType: string | null = null;
    const onResponse = (r: import("playwright").Response) => {
      if (r.request().isNavigationRequest() && r.request().frame() === session.page.mainFrame()) contentType = r.headers()["content-type"] ?? null;
    };
    session.page.on("response", onResponse);
    const navigation = await session.navigate(url, timeoutMs);
    session.page.off("response", onResponse);
    if (!navigation.ok) return { navigation, contentType, extracted: null };
    try {
      return { navigation, contentType, extracted: await extractPage(session.page) };
    } catch (error) {
      return { navigation: { ...navigation, ok: false, error: classifyBrowserError(error) }, contentType, extracted: null };
    }
  }

  async close(): Promise<void> {
    await this.session?.close();
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.session = null;
    this.context = null;
    this.browser = null;
  }
}
