import { chromium, firefox, webkit, type Browser } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lighthouseChromeOptions } from "@/lib/performance/lighthouse-provider";
import { browserEnvironment } from "@/lib/playwright/browser-env";
import { launchBrowser } from "@/lib/playwright/browsers";

/**
 * Browser processes render untrusted websites, so they must not inherit the worker's secrets. These tests check the
 * environment allow-list and that every launch path (Playwright's three engines, Lighthouse's Chrome) uses it.
 * tests/integration/browser-env.test.ts checks real browser processes.
 */

const SECRETS = {
  DATABASE_URL: "postgresql://postgres.ref:CANARY_DB_PASSWORD@aws-0-region.pooler.supabase.com:5432/postgres",
  SUPABASE_SECRET_KEY: "sb_secret_CANARY0000000000000000",
  SUPABASE_SERVICE_ROLE_KEY: "CANARY_SERVICE_ROLE",
  ANTHROPIC_API_KEY: "sk-ant-CANARY",
  FIGMA_ACCESS_TOKEN: "CANARY_FIGMA",
  GITHUB_TOKEN: "ghs_CANARY",
  DATABASE_SSL_CA: "-----BEGIN CERTIFICATE-----\nCANARY\n-----END CERTIFICATE-----",
  NODE_OPTIONS: "--require /tmp/canary.js",
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("browser environment allow-list", () => {
  it("drops database credentials, Supabase keys and every other worker setting", () => {
    const env = browserEnvironment({ ...SECRETS, PATH: "/usr/bin", DATABASE_PROVIDER: "supabase", STORAGE_PROVIDER: "supabase", SUPABASE_URL: "https://ref.supabase.co" });
    for (const name of [...Object.keys(SECRETS), "DATABASE_PROVIDER", "STORAGE_PROVIDER", "SUPABASE_URL"]) expect(env, name).not.toHaveProperty(name);
    expect(JSON.stringify(env)).not.toMatch(/CANARY/);
  });

  it("keeps what browsers need: paths, profile and temp folders, locale, display, fonts and proxy", () => {
    const needed = {
      PATH: "/usr/bin", HOME: "/home/runner", TMPDIR: "/tmp", LANG: "en_US.UTF-8", LC_ALL: "C.UTF-8", TZ: "UTC", DISPLAY: ":99",
      XDG_RUNTIME_DIR: "/run/user/1001", FONTCONFIG_PATH: "/etc/fonts", HTTPS_PROXY: "http://proxy:3128", NO_PROXY: "localhost",
      SystemRoot: "C:\\Windows", Path: "C:\\Windows\\system32", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local", USERPROFILE: "C:\\Users\\u", TEMP: "C:\\Temp",
    };
    expect(browserEnvironment({ ...needed, ...SECRETS })).toEqual(needed);
  });

  it("is used by every Playwright launch (Chromium, Firefox, WebKit)", async () => {
    for (const [name, value] of Object.entries(SECRETS)) vi.stubEnv(name, value);
    vi.stubEnv("TZ", "UTC");
    for (const [name, engine] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]] as const) {
      const launch = vi.spyOn(engine, "launch").mockResolvedValue({} as Browser);
      await launchBrowser(name);
      const env = launch.mock.calls[0][0]?.env as Record<string, string>;
      expect(env, name).toBeDefined();
      expect(env.TZ, name).toBe("UTC");
      for (const secret of Object.keys(SECRETS)) expect(env, `${name} ${secret}`).not.toHaveProperty(secret);
    }
  });

  it("is used for the Chrome that Lighthouse starts", () => {
    for (const [name, value] of Object.entries(SECRETS)) vi.stubEnv(name, value);
    vi.stubEnv("TZ", "UTC");
    const options = lighthouseChromeOptions("/path/to/chrome");
    expect(options.envVars.TZ).toBe("UTC");
    for (const secret of Object.keys(SECRETS)) expect(options.envVars, secret).not.toHaveProperty(secret);
    expect(options.chromeFlags).toContain("--headless=new");
  });
});
