import fs from "node:fs";
import { chromium } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lighthouseChromeOptions } from "@/lib/performance/lighthouse-provider";
import { launchBrowser } from "@/lib/playwright/browsers";
import type { BrowserName } from "@/types";
import { browserInstalled, INTEGRATION_TIMEOUT } from "./helpers";

/**
 * Real browser processes must not hold the worker's secrets. Every platform: each browser starts, renders and takes a
 * screenshot with the restricted environment. Linux (CI): the environment of every browser process is read from
 * /proc/<pid>/environ and must not contain the database URL or the Supabase secret key.
 */

const DATABASE_URL = "postgresql://postgres.ref:CANARY_DB_PASSWORD@aws-0-region.pooler.supabase.com:5432/postgres";
const SUPABASE_SECRET_KEY = "sb_secret_CANARY0000000000000000";
const linux = process.platform === "linux";

/** All processes below `root` (Linux), with their environment. */
function descendantEnvironments(root: number): Map<number, string[]> {
  const parentOf = new Map<number, number>();
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
      parentOf.set(Number(entry), Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]));
    } catch {
      // the process exited meanwhile
    }
  }
  const found = new Map<number, string[]>();
  const walk = (pid: number) => {
    for (const [child, parent] of parentOf) {
      if (parent !== pid || found.has(child)) continue;
      try {
        found.set(child, fs.readFileSync(`/proc/${child}/environ`, "utf8").split("\0").filter(Boolean));
      } catch {
        found.set(child, []);
      }
      walk(child);
    }
  };
  walk(root);
  return found;
}

function expectNoSecrets(envs: Map<number, string[]>) {
  expect(envs.size).toBeGreaterThan(0);
  for (const [pid, env] of envs) {
    const text = env.join("\n");
    expect(text, `process ${pid}`).not.toContain("CANARY");
    expect(env.some((e) => e.startsWith("DATABASE_URL=") || e.startsWith("SUPABASE_SECRET_KEY=")), `process ${pid}`).toBe(false);
  }
  // Required non-secret settings still reach the browser.
  expect([...envs.values()].some((env) => env.includes("TZ=UTC") && env.some((e) => e.startsWith("PATH=")))).toBe(true);
}

afterEach(() => vi.unstubAllEnvs());

describe("browser processes get no worker secrets", () => {
  for (const name of ["chromium", "firefox", "webkit"] as BrowserName[]) {
    it.skipIf(!browserInstalled(name))(`${name}: starts, renders and screenshots without the secrets`, async () => {
      vi.stubEnv("DATABASE_URL", DATABASE_URL);
      vi.stubEnv("SUPABASE_SECRET_KEY", SUPABASE_SECRET_KEY);
      vi.stubEnv("TZ", "UTC");
      const browser = await launchBrowser(name);
      try {
        const page = await browser.newPage();
        await page.setContent("<h1>Environment check</h1>");
        expect(await page.textContent("h1")).toBe("Environment check");
        // TZ reached the browser (Windows browsers take the zone from the system instead, so only checked on Linux).
        if (linux) expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe("UTC");
        const png = await page.screenshot();
        expect(png.subarray(1, 4).toString()).toBe("PNG");
        if (linux) expectNoSecrets(descendantEnvironments(process.pid));
      } finally {
        await browser.close();
      }
    }, INTEGRATION_TIMEOUT);
  }

  it.skipIf(!browserInstalled("chromium"))("Lighthouse's Chrome starts without the secrets", async () => {
    vi.stubEnv("DATABASE_URL", DATABASE_URL);
    vi.stubEnv("SUPABASE_SECRET_KEY", SUPABASE_SECRET_KEY);
    vi.stubEnv("TZ", "UTC");
    const chromeLauncher = await import("chrome-launcher");
    const chrome = await chromeLauncher.launch(lighthouseChromeOptions(chromium.executablePath()));
    try {
      expect(chrome.port).toBeGreaterThan(0);
      const version = (await (await fetch(`http://127.0.0.1:${chrome.port}/json/version`)).json()) as { Browser?: string };
      expect(version.Browser).toBeTruthy(); // DevTools endpoint answers: Lighthouse can drive it
      if (linux) {
        const own = fs.readFileSync(`/proc/${chrome.pid}/environ`, "utf8").split("\0").filter(Boolean);
        expectNoSecrets(new Map([[chrome.pid, own], ...descendantEnvironments(chrome.pid)]));
      }
    } finally {
      chrome.kill();
    }
  }, INTEGRATION_TIMEOUT);
});
