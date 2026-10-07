import { launchBrowser } from "@/lib/playwright/browsers";
import { APP_NAME, COPYRIGHT_NOTICE } from "@/lib/constants/brand";
import { esc } from "./html";

export interface PdfRenderer {
  render(html: string): Promise<Uint8Array>;
}

/**
 * Renders print HTML to PDF with the local headless Chromium (no external service). JavaScript is
 * disabled and every network request is blocked: the document is self-contained (data: images).
 */
export class PlaywrightPdfRenderer implements PdfRenderer {
  async render(html: string): Promise<Uint8Array> {
    const browser = await launchBrowser("chromium");
    try {
      const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: "block" });
      await context.route("**/*", (route) => (route.request().url().startsWith("data:") ? route.continue() : route.abort()));
      const page = await context.newPage();
      await page.setContent(html, { waitUntil: "load", timeout: 120_000 });
      await page.emulateMedia({ media: "print" });
      const footer = `<div style="font:9px system-ui,sans-serif;color:#6b7280;width:100%;padding:0 12mm;display:flex;justify-content:space-between">
        <span>${esc(APP_NAME)} · ${esc(COPYRIGHT_NOTICE)}</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`;
      const pdf = await page.pdf({
        format: "A4",
        printBackground: true,
        displayHeaderFooter: true,
        headerTemplate: "<div></div>",
        footerTemplate: footer,
        margin: { top: "14mm", bottom: "16mm", left: "10mm", right: "10mm" },
      });
      return new Uint8Array(pdf);
    } finally {
      await browser.close().catch(() => undefined);
    }
  }
}
