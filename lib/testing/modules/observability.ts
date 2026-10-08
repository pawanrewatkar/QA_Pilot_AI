import type { TestModule } from "../context";
import type { CheckOutcome } from "../outcome";
import { evidence, outcome } from "../outcome";
import { spec } from "./helpers";

/** Console and network observations collected while the page loaded (before any interaction). */
export interface LoadObservations {
  console: { level: string; message: string; sourceUrl: string | null }[];
  pageErrors: string[];
  network: { url: string; method: string; resourceType: string; status: number | null; failure: string | null }[];
}

export const consoleModule: TestModule = {
  id: "console",
  scope: "combo",
  async run(ctx) {
    const obs = ctx.loadObservations;
    const uncaught = spec("console", "uncaught", {
      title: "No uncaught JavaScript errors while loading",
      section: "Browser console",
      feature: "JavaScript errors",
      element: "window (pageerror)",
      steps: ["Load the page", "Collect uncaught exceptions"],
      expected: "No uncaught JavaScript exceptions",
    });
    const errors = spec("console", "errors", {
      title: "No console errors while loading",
      section: "Browser console",
      feature: "Console errors",
      element: "console.error",
      steps: ["Load the page", "Collect console messages"],
      expected: "No console.error messages",
    });
    const consoleErrors = obs.console.filter((c) => c.level === "error");
    const warnings = obs.console.filter((c) => c.level === "warning");
    return [
      obs.pageErrors.length
        ? outcome.fail(uncaught, `${obs.pageErrors.length} uncaught error(s): ${obs.pageErrors[0]}`, [evidence.note("Uncaught errors", obs.pageErrors.join("\n"))])
        : outcome.pass(uncaught, "No uncaught exceptions", ["pageerror listener recorded 0 events during load"]),
      consoleErrors.length
        ? outcome.warn(errors, `${consoleErrors.length} console error(s): ${consoleErrors[0].message.slice(0, 200)}`, {
            evidence: [{ type: "console", label: "Console errors", content: consoleErrors.map((c) => `${c.message}${c.sourceUrl ? ` (${c.sourceUrl})` : ""}`).join("\n").slice(0, 4000) }],
          })
        : outcome.pass(errors, `No console errors${warnings.length ? ` (${warnings.length} console warning(s) recorded for review; warnings are not treated as failures)` : ""}`, ["0 console.error messages during load"]),
    ];
  },
};

const RESOURCE_GROUPS: { key: string; label: string; types: string[] }[] = [
  { key: "scripts", label: "JavaScript files", types: ["script"] },
  { key: "stylesheets", label: "CSS stylesheets", types: ["stylesheet"] },
  { key: "images", label: "Images", types: ["image"] },
  { key: "fonts", label: "Fonts", types: ["font"] },
  { key: "other", label: "Other requests (documents, XHR/fetch, media)", types: [] },
];

type NetEntry = LoadObservations["network"][number];

/** Splits observed requests into failures per resource group, first- vs third-party. Pure; used by tests. */
export function analyzeNetwork(pageUrl: string, network: NetEntry[], consoleEntries: LoadObservations["console"]) {
  const pageHost = new URL(pageUrl).hostname.replace(/^www./, "");
  const firstParty = (u: string) => {
    try {
      const h = new URL(u).hostname.replace(/^www./, "");
      return h === pageHost || h.endsWith(`.${pageHost}`);
    } catch {
      return false;
    }
  };
  // A bare abort is navigation noise; an abort after an error status (e.g. a 404 script blocked by the browser) is a real failure.
  const relevant = network.filter((n) => !/ERR_ABORTED|NS_BINDING_ABORTED|blockedbyclient/i.test(n.failure ?? "") || (n.status !== null && n.status >= 400));
  const failed = (n: NetEntry) => !!n.failure || (n.status !== null && n.status >= 400);
  const groups = RESOURCE_GROUPS.map((g) => {
    const inGroup = relevant.filter((n) => (g.types.length ? g.types.includes(n.resourceType) : !RESOURCE_GROUPS.some((x) => x.types.includes(n.resourceType))));
    const bad = inGroup.filter(failed);
    return { ...g, total: inGroup.length, firstParty: bad.filter((n) => firstParty(n.url)), thirdParty: bad.filter((n) => !firstParty(n.url)) };
  });
  const cors = consoleEntries.filter((c) => /CORS|Cross-Origin Request Blocked|Access-Control-Allow-Origin/i.test(c.message));
  const mixed = pageUrl.startsWith("https:") ? relevant.filter((n) => n.url.startsWith("http:")) : [];
  return { groups, cors, mixed, total: relevant.length };
}

const describeFailure = (n: NetEntry) => {
  const kind = n.status === 404 || n.status === 410 ? "404 Not Found" : n.status !== null && n.status >= 500 ? `${n.status} server error` : n.status !== null ? `HTTP ${n.status}` : n.failure ?? "failed";
  return `${n.method} ${n.url} → ${kind} (${n.resourceType})`;
};

export const networkModule: TestModule = {
  id: "network",
  scope: "combo",
  async run(ctx) {
    const obs = ctx.loadObservations;
    const { groups, cors, mixed, total } = analyzeNetwork(ctx.url, obs.network, obs.console);
    const results: CheckOutcome[] = [];
    for (const g of groups) {
      const s = spec("network", g.key, {
        title: `${g.label} load successfully`,
        section: "Network",
        feature: "Failed requests",
        element: g.label,
        steps: ["Load the page", "Record every request with its status and failure reason"],
        expected: "No request fails or returns 404/410/5xx",
        expectationSource: "BROWSER_STANDARD",
      });
      if (g.total === 0) {
        results.push(outcome.notApplicable(s, `No ${g.label.toLowerCase()} were requested.`));
        continue;
      }
      if (g.firstParty.length) {
        results.push(outcome.fail(s, `${g.firstParty.length} site request(s) failed, e.g. ${describeFailure(g.firstParty[0])}`, [
          { type: "network", label: `Failed ${g.label.toLowerCase()} (site)`, content: g.firstParty.map(describeFailure).join("\n").slice(0, 4000) },
          ...(g.thirdParty.length ? [{ type: "network" as const, label: "Third-party failures", content: g.thirdParty.map(describeFailure).join("\n").slice(0, 4000) }] : []),
        ]));
      } else if (g.thirdParty.length) {
        results.push(outcome.warn(s, `${g.thirdParty.length} third-party request(s) failed or were refused, e.g. ${describeFailure(g.thirdParty[0])}`, {
          evidence: [{ type: "network", label: "Third-party failures", content: g.thirdParty.map(describeFailure).join("\n").slice(0, 4000) }],
        }));
      } else {
        results.push(outcome.pass(s, `${g.total} request(s), none failed`, [`${g.total} ${g.label.toLowerCase()} returned successful responses`]));
      }
    }
    const corsSpec = spec("network", "cors", { title: "No CORS errors reported by the browser", section: "Network", feature: "CORS", element: "cross-origin requests", steps: ["Load the page", "Read browser console messages about cross-origin requests"], expected: "No request is blocked by CORS policy", expectationSource: "BROWSER_STANDARD" });
    results.push(
      cors.length
        ? outcome.warn(corsSpec, `${cors.length} CORS message(s): ${cors[0].message.slice(0, 200)}`, { evidence: [{ type: "console", label: "CORS messages", content: cors.map((c) => c.message).join("\n").slice(0, 4000) }] })
        : outcome.pass(corsSpec, "No CORS errors in the console", [`${total} requests observed; 0 CORS console messages`]),
    );
    const mix = spec("network", "mixed-content", { title: "No insecure (HTTP) resources on an HTTPS page", section: "Network", feature: "Mixed content", element: "http:// requests", steps: ["Load the HTTPS page", "Look for http:// requests"], expected: "All resources load over HTTPS", expectationSource: "BROWSER_STANDARD" });
    results.push(
      ctx.url.startsWith("https:")
        ? mixed.length
          ? outcome.warn(mix, `${mixed.length} resource(s) requested over plain HTTP`, { evidence: [{ type: "network", label: "Insecure requests", content: mixed.map(describeFailure).join("\n").slice(0, 4000) }] })
          : outcome.pass(mix, "All requests used HTTPS", ["0 http:// requests recorded"])
        : outcome.notApplicable(mix, "The page itself is served over HTTP."),
    );
    return results;
  },
};

export function unimplementedModule(id: string, label: string): TestModule {
  return {
    id,
    scope: "page",
    async run() {
      return [
        outcome.notExecuted(
          spec(id, "not-implemented", { title: label, feature: label, element: "—", steps: [], expected: `${label} checks` }),
          `${label} is not available in this version of QA Pilot AI and was not executed in this run.`,
        ),
      ];
    },
  };
}
