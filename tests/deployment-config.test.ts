import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { assertDeployable, deploymentProblems } from "@/lib/config/deployment";
import { readEnv } from "@/lib/config/env";

/** The web app's deployment guard (lib/config/deployment.ts) and the files that keep local data out of a Vercel upload. */

describe("Vercel deployment guard", () => {
  it("allows the local defaults outside Vercel (local development unchanged)", () => {
    expect(deploymentProblems(readEnv({}), { vercel: false })).toEqual([]);
    expect(() => assertDeployable(readEnv({}), {})).not.toThrow();
  });

  it("refuses SQLite or local files on Vercel, naming settings only", () => {
    const problems = deploymentProblems(readEnv({}), { vercel: true });
    expect(problems).toHaveLength(2);
    expect(problems.join(" ")).toMatch(/DATABASE_PROVIDER=supabase.*STORAGE_PROVIDER=supabase/);
    expect(deploymentProblems(readEnv({ DATABASE_PROVIDER: "supabase" }), { vercel: true })).toHaveLength(1);
    expect(() => assertDeployable(readEnv({}), { VERCEL: "1" })).toThrow(/Invalid deployment configuration/);
  });

  it("accepts the hosted database and storage on Vercel", () => {
    expect(() => assertDeployable(readEnv({ DATABASE_PROVIDER: "supabase", STORAGE_PROVIDER: "supabase" }), { VERCEL: "1" })).not.toThrow();
  });

  it("keeps local data, env files and private deployment notes out of a Vercel CLI upload", () => {
    const ignored = fs.readFileSync(".vercelignore", "utf8").split(/\r?\n/);
    for (const entry of ["data", ".env*", "!.env.example", "**/Deployment.md"]) expect(ignored).toContain(entry);
  });
});
