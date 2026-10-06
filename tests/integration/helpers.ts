import fs from "node:fs";
import { chromium, firefox, webkit } from "playwright";
import type { BrowserName } from "@/types";

const ENGINES = { chromium, firefox, webkit };

/** Integration tests run only when the Playwright browser binaries are installed. */
export function browserInstalled(name: BrowserName): boolean {
  try {
    return fs.existsSync(ENGINES[name].executablePath());
  } catch {
    return false;
  }
}

export const INTEGRATION_TIMEOUT = 240_000;
