/**
 * End-to-end test of the complete QA Pilot AI workflow, driven through the real UI.
 *
 *   npm run build && npm run test:e2e
 *
 * Starts the production web app and the worker against a temporary database and storage
 * directory, and uses the local fixture website (no third-party sites). Covers:
 * create project → crawl → select pages → configure and start a run → browser tests → results
 * and evidence → bugs → automatically generated reports → history → regression comparison,
 * plus an axe-core accessibility scan and a phone-width overflow check of every main page.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFixtureSite, type FixtureSite } from "../fixtures/site-server";
import { makeTempDir } from "../helpers";
import { browserInstalled } from "../integration/helpers";

const ROOT = path.resolve(import.meta.dirname, "../..");
const built = fs.existsSync(path.join(ROOT, ".next", "BUILD_ID"));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs: number, label: string): Promise<T> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

describe.skipIf(!built || !browserInstalled("chromium"))("complete workflow through the UI", () => {
  let site: FixtureSite;
  let dataDir: string;
  let base: string;
  let web: ChildProcess;
  let worker: ChildProcess;
  let browser: Browser;
  let page: Page;
  const logs: string[] = [];
  let projectId = "";
  const runIds: string[] = [];

  beforeAll(async () => {
    site = await startFixtureSite();
    dataDir = makeTempDir("qa-pilot-e2e-");
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    const env = { ...process.env, DATABASE_PROVIDER: "local", DATABASE_PATH: path.join(dataDir, "qa.db"), STORAGE_PATH: path.join(dataDir, "storage"), NODE_ENV: "production" as const };
    const capture = (name: string) => (chunk: Buffer) => logs.push(`[${name}] ${chunk.toString()}`);
    web = spawn(process.execPath, [path.join(ROOT, "node_modules/next/dist/bin/next"), "start", "-p", String(port), "-H", "127.0.0.1"], { cwd: ROOT, env });
    web.stdout?.on("data", capture("web"));
    web.stderr?.on("data", capture("web"));
    await waitFor(async () => (await fetch(base)).ok, 60_000, "web app");
    worker = spawn(process.execPath, [path.join(ROOT, "node_modules/tsx/dist/cli.mjs"), "worker/index.ts"], { cwd: ROOT, env });
    worker.stdout?.on("data", capture("worker"));
    worker.stderr?.on("data", capture("worker"));
    browser = await chromium.launch();
    // axe-core needs pages created from an explicit context.
    page = await (await browser.newContext({ viewport: { width: 1366, height: 900 } })).newPage();
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    worker?.kill();
    web?.kill();
    await site?.close();
    await new Promise((r) => setTimeout(r, 500));
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  });

  const runStatus = async (id: string) => (await (await fetch(`${base}/api/test-runs/${id}`)).json()) as { status: string; counts: Record<string, number> };

  /** Starts a run from the project's selected pages with the given modules (reports: all formats, the default). */
  async function startRun(name: string, modules: RegExp[]): Promise<string> {
    await page.goto(`${base}/test-runs/new?project=${projectId}`);
    await page.getByLabel("Run name").fill(name);
    for (const m of modules) {
      const box = page.getByRole("checkbox", { name: m });
      if ((await box.getAttribute("aria-checked")) !== "true") await box.click();
    }
    await page.getByRole("button", { name: "Start test run" }).click();
    await page.waitForURL(/\/test-runs\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    const id = page.url().split("/").pop()!;
    await waitFor(async () => ["COMPLETED", "FAILED", "CANCELLED"].includes((await runStatus(id)).status), 300_000, `run ${name}`);
    return id;
  }

  it("creates a project with the fixture website", async () => {
    await page.goto(`${base}/projects/new`);
    await page.getByLabel("Project name").fill("E2E Fixture Co");
    await page.getByLabel("Website URL").fill(`${site.origin}/`);
    await page.getByRole("button", { name: /Create project/i }).click();
    await page.waitForURL(/\/projects\/[0-9a-f-]{36}(\?|$)/);
    projectId = new URL(page.url()).pathname.split("/").pop()!;
    await expect(page.getByRole("heading", { level: 1, name: "E2E Fixture Co" }).count()).resolves.toBe(1);
  }, 60_000);

  it("discovers pages with the crawler and selects pages to test", async () => {
    await page.goto(`${base}/projects/${projectId}/pages`);
    await page.getByLabel("Maximum pages").fill("25");
    await page.getByRole("button", { name: "Start crawl" }).click();
    await waitFor(async () => {
      await page.reload();
      return (await page.getByRole("checkbox", { name: `Select ${site.origin}/contact` }).count()) > 0 && (await page.getByText("Last crawl").count()) > 0;
    }, 120_000, "crawl");
    // Test three pages: clear the default selection, then pick them.
    const all = page.getByRole("checkbox", { name: "Select all shown pages" });
    if ((await all.getAttribute("aria-checked")) !== "false") {
      await all.click();
      if ((await all.getAttribute("aria-checked")) !== "false") await all.click();
    }
    for (const p of ["/", "/contact", "/login"]) {
      const box = page.getByRole("checkbox", { name: `Select ${site.origin}${p}`, exact: true });
      await box.click();
      await expect.poll(() => box.getAttribute("aria-checked")).toBe("true");
    }
  }, 180_000);

  it("runs browser tests, records results and evidence, and creates bugs", async () => {
    const id = await startRun("E2E baseline", [/^UI Testing/, /^Accessibility Testing/, /^SEO Testing/, /^Form Testing/, /^Negative Testing/]);
    runIds.push(id);
    const run = await runStatus(id);
    expect(run.status).toBe("COMPLETED");
    expect(run.counts.PASS).toBeGreaterThan(10);
    expect(run.counts.FAIL).toBeGreaterThan(0);
    expect(site.writes).toEqual([]);
    const engineLog = logs.filter((l) => l.includes(id) && /bug/i.test(l)).join("");
    expect(engineLog, "worker bug-engine log").toMatch(/[1-9]\d* new bug/);

    await page.goto(`${base}/test-runs/${id}`);
    await page.getByRole("link", { name: /^Bugs \(\d+\)/ }).click();
    await page.waitForURL(/\/bugs\?run=/);
    const bugLinks = page.locator("tbody tr td:first-child a");
    await bugLinks.first().waitFor({ timeout: 15_000 }); // client-side navigation: wait for the rendered rows
    expect(await bugLinks.count()).toBeGreaterThan(0);
    await bugLinks.first().click();
    await page.waitForURL(/\/bugs\/[0-9a-f-]{36}$/);
    await page.getByRole("heading", { name: "Evidence" }).waitFor({ timeout: 15_000 });
    const img = page.locator("main img").first();
    if (await img.count()) {
      await img.scrollIntoViewIfNeeded();
      await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0), { timeout: 15_000 }).toBe(true);
    }
  }, 360_000);

  it("generates the selected reports automatically and offers every download", async () => {
    await page.goto(`${base}/reports`);
    await waitFor(async () => {
      await page.reload();
      return (await page.getByText("READY", { exact: true }).count()) > 0;
    }, 180_000, "report bundle");
    for (const label of ["Download PDF", "Download HTML", "Download Testing Excel", "Download Bug Excel"]) {
      const href = await page.getByRole("link", { name: label }).first().getAttribute("href");
      const res = await page.request.get(`${base}${href}`);
      expect(res.status(), label).toBe(200);
      expect(res.headers()["content-disposition"]).toContain("attachment");
    }
    const pdf = await page.request.get(`${base}${await page.getByRole("link", { name: "Download PDF" }).first().getAttribute("href")}`);
    expect((await pdf.body()).subarray(0, 5).toString()).toBe("%PDF-");
  }, 240_000);

  it("records history and compares a second run with the first", async () => {
    const id = await startRun("E2E second run", []);
    runIds.push(id);
    await page.goto(`${base}/history`);
    await expect(page.getByRole("link", { name: "E2E second run" }).count()).resolves.toBeGreaterThan(0);
    await page.goto(`${base}/test-runs/${id}/compare`);
    await expect(page.getByRole("heading", { name: "Regression comparison" }).count()).resolves.toBe(1);
    const stillFailing = Number(await page.getByRole("link", { name: /Still Failing/ }).locator("p").last().innerText());
    expect(stillFailing).toBeGreaterThan(0);
  }, 360_000);

  it("has no serious accessibility violations or phone-width overflow on the main pages", async () => {
    const bug = await (await fetch(`${base}/bugs`)).text();
    const bugId = /href="\/bugs\/([0-9a-f-]{36})"/.exec(bug)?.[1];
    const paths = ["/", "/projects", `/projects/${projectId}`, `/projects/${projectId}/pages`, "/test-runs", `/test-runs/${runIds[0]}`, `/test-runs/${runIds[1]}/compare`, "/test-runs/new", "/pages", "/test-cases", "/bugs", `/bugs/${bugId}`, "/reports", "/history", "/settings", "/copyright", "/projects/new"];
    const problems: string[] = [];
    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
    for (const p of paths) {
      await page.goto(`${base}${p}`);
      const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      for (const v of result.violations.filter((x) => x.impact === "serious" || x.impact === "critical")) {
        problems.push(`${p}: ${v.id} (${v.impact}) ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
      }
      await mobile.goto(`${base}${p}`);
      const overflow = await mobile.evaluate(() => {
        const extra = document.documentElement.scrollWidth - window.innerWidth;
        if (extra <= 1) return null;
        const wide = [...document.querySelectorAll("body *")].find((el) => el.getBoundingClientRect().right > window.innerWidth + 1);
        return `${extra}px (${wide ? wide.tagName.toLowerCase() + "." + String(wide.className).slice(0, 80) : "?"})`;
      });
      if (overflow) problems.push(`${p}: horizontal overflow ${overflow} at 390px`);
      expect(await page.getByText("© Pawan Rewatkar. All Rights Reserved.").count(), `${p} footer`).toBeGreaterThan(0);
    }
    await mobile.close();
    expect(problems).toEqual([]);
  }, 300_000);

  it("left no server errors in the logs", () => {
    const errors = logs.filter((l) => /\[web\].*(Error|⨯)/.test(l) && !/ECONNRESET/.test(l));
    expect(errors).toEqual([]);
  });
});
