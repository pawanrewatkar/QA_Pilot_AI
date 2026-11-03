import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

/**
 * The pull request checks workflow (.github/workflows/ci.yml): runs on pull requests into main only, with read-only
 * permissions, pinned actions, no secrets or environment, and every check the project has.
 */

type Step = { name?: string; uses?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, string> };
type Workflow = {
  on: Record<string, { branches?: string[] }>;
  permissions: Record<string, string>;
  jobs: Record<string, { environment?: string; permissions?: unknown; steps: Step[] }>;
};

const text = fs.readFileSync(path.join(process.cwd(), ".github", "workflows", "ci.yml"), "utf8");
const workflow = yaml.load(text) as Workflow;
const steps = Object.values(workflow.jobs).flatMap((j) => j.steps);

describe("CI workflow", () => {
  it("runs on pull requests into main only (never pull_request_target)", () => {
    expect(workflow.on).toEqual({ pull_request: { branches: ["main"] } });
    expect(text).not.toMatch(/pull_request_target|workflow_run/);
  });

  it("reads the repository only, with no secrets, variables or environment", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    for (const job of Object.values(workflow.jobs)) {
      expect(job.permissions).toBeUndefined();
      expect(job.environment).toBeUndefined();
    }
    expect(text).not.toMatch(/secrets\.|vars\.|DATABASE_URL|SUPABASE_|upload-artifact/);
    for (const s of steps) if (s.run) expect(s.run, s.name).not.toMatch(/\$\{\{/);
  });

  it("pins every action to a full commit hash and keeps no git credentials", () => {
    for (const s of steps.filter((s) => s.uses)) expect(s.uses, s.name).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    expect(steps.find((s) => s.uses?.startsWith("actions/checkout@"))?.with).toMatchObject({ "persist-credentials": false });
  });

  it("installs from the lockfile and runs every check", () => {
    const runs = steps.map((s) => s.run).filter(Boolean);
    expect(runs).toEqual(expect.arrayContaining(["npm ci", "npm run lint", "npm run typecheck", "npm test", "npm run build", "npm run test:e2e"]));
    expect(runs.indexOf("npm run build")).toBeLessThan(runs.indexOf("npm run test:e2e")); // e2e needs the build
  });
});
