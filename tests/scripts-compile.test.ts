import fs from "node:fs";
import path from "node:path";
import { transformSync } from "esbuild";
import { describe, expect, it } from "vitest";

/**
 * `npx tsx scripts/<name>.ts` compiles each script as CommonJS (package.json has no "type": "module"), where top-level
 * await is a syntax error. Every TypeScript script must therefore compile in that format.
 */
describe("scripts", () => {
  const scripts = fs.readdirSync("scripts").filter((f) => f.endsWith(".ts"));

  it.each(scripts)("%s compiles as CommonJS (as tsx runs it)", (name) => {
    const source = fs.readFileSync(path.join("scripts", name), "utf8");
    expect(() => transformSync(source, { loader: "ts", format: "cjs" })).not.toThrow();
  });
});
