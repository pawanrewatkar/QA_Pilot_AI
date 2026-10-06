import type { TestModule, PageTestContext } from "../context";
import { classifyLinkKind, validateMailto, validateTel, type LinkKind } from "../link-check";
import { evidence, outcome, type CheckOutcome } from "../outcome";
import type { InspectedLink } from "../browser-scripts";
import { describe, inspect, spec } from "./helpers";

const KIND_LABEL: Record<LinkKind, string> = {
  internal: "Internal link",
  external: "External link",
  mailto: "Mailto link",
  tel: "Tel link",
  download: "Download link",
  social: "Social link",
  anchor: "In-page anchor",
  javascript: "Script link",
  "other-scheme": "Other link",
  empty: "Empty link",
};

const SECTION_LABEL: Record<string, string> = {
  header: "Header",
  navigation: "Navigation",
  footer: "Footer",
  cta: "Call to action",
  breadcrumb: "Breadcrumb",
  pagination: "Pagination",
  content: "Content",
};

interface LinkTarget {
  link: InspectedLink;
  kind: LinkKind;
}

/** Unique links on the page, deduplicated by destination, in DOM order. */
async function collect(ctx: PageTestContext): Promise<LinkTarget[]> {
  const inspection = await inspect(ctx);
  const seen = new Set<string>();
  const out: LinkTarget[] = [];
  for (const link of inspection.links) {
    const kind = classifyLinkKind(link.rawHref, link.href, ctx.url, link.download);
    const key = kind === "mailto" || kind === "tel" ? link.rawHref.trim().toLowerCase() : link.href.split("#")[0];
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ link, kind });
  }
  return out;
}

async function checkHttpLink(ctx: PageTestContext, module: string, { link, kind }: LinkTarget): Promise<CheckOutcome> {
  const s = spec(module, link.href, {
    title: `${KIND_LABEL[kind]} resolves: ${link.text || link.href}`,
    section: SECTION_LABEL[link.source] ?? "Content",
    feature: KIND_LABEL[kind],
    element: describe("a", link.text) + ` → ${link.href}`,
    steps: ["Open the page", `Request ${link.href} (HEAD, falling back to GET)`, "Follow redirects and record the final response"],
    expected: "Destination responds successfully (HTTP 2xx, after redirects if any)",
  });
  const started = Date.now();
  const record = await ctx.linkChecker.check(link.href);
  const chain = record.result.chain.map((h) => `${h.status} ${h.url}`).join("\n");
  const httpEvidence = evidence.http(
    "HTTP check",
    [`URL: ${link.href}`, chain ? `Redirects:\n${chain}` : null, `Final: ${record.result.finalUrl}`, `Status: ${record.result.status ?? record.result.error?.kind}`, record.retry ? `Retry status: ${record.retry.status}` : null, `Found on: ${ctx.url} (${link.source})`]
      .filter(Boolean)
      .join("\n"),
  );
  const { verdict } = record;
  const durationMs = Date.now() - started;
  if (verdict.status === "PASS") return outcome.pass(s, verdict.actual, [`Received ${verdict.actual} from ${record.result.finalUrl}`], { evidence: [httpEvidence], durationMs });
  if (verdict.status === "FAIL") return outcome.fail(s, verdict.actual, [httpEvidence], { durationMs });
  return outcome.warn(s, verdict.actual, { evidence: [httpEvidence], durationMs });
}

function checkSchemeLink(module: string, { link, kind }: LinkTarget): CheckOutcome {
  const s = spec(module, link.rawHref.toLowerCase(), {
    title: `${KIND_LABEL[kind]} is well-formed: ${link.rawHref}`,
    section: SECTION_LABEL[link.source] ?? "Content",
    feature: KIND_LABEL[kind],
    element: describe("a", link.text) + ` → ${link.rawHref}`,
    steps: ["Open the page", `Parse ${link.rawHref}`],
    expected: kind === "mailto" ? "Link contains a valid recipient email address" : "Link contains a dialable phone number",
  });
  const check = kind === "mailto" ? validateMailto(link.rawHref) : validateTel(link.rawHref);
  return check.valid
    ? outcome.pass(s, check.detail, [check.detail])
    : outcome.fail(s, check.detail, [evidence.dom("Link markup", `href="${link.rawHref}" text="${link.text}"`)]);
}

async function runLinkSet(ctx: PageTestContext, module: string, include: (kind: LinkKind) => boolean): Promise<CheckOutcome[]> {
  const all = await collect(ctx);
  const targets = all.filter((t) => include(t.kind));
  const limited = targets.slice(0, ctx.options.maxLinksPerPage);
  const results: CheckOutcome[] = [];
  const httpTargets = limited.filter((t) => t.kind !== "mailto" && t.kind !== "tel");
  for (const t of limited.filter((x) => x.kind === "mailto" || x.kind === "tel")) results.push(checkSchemeLink(module, t));
  results.push(...(await Promise.all(httpTargets.map((t) => checkHttpLink(ctx, module, t)))));
  if (targets.length > limited.length) {
    results.push(
      outcome.notExecuted(
        spec(module, "limit", {
          title: "Links beyond the per-page limit",
          feature: "Link coverage",
          element: `${targets.length - limited.length} additional links`,
          steps: ["Collect links on the page"],
          expected: "All links checked",
        }),
        `${targets.length - limited.length} links were not checked because the run limit is ${ctx.options.maxLinksPerPage} links per page.`,
      ),
    );
  }
  return results;
}

const HTTP_KINDS = new Set<LinkKind>(["internal", "external", "mailto", "tel", "social", "download"]);

export const linksModule: TestModule = {
  id: "links",
  scope: "page",
  async run(ctx) {
    // Social and download links are reported by their dedicated modules when those are selected.
    const results = await runLinkSet(ctx, "links", (kind) => {
      if (!HTTP_KINDS.has(kind)) return false;
      if (kind === "social" && ctx.selectedModules.has("social-links")) return false;
      if (kind === "download" && ctx.selectedModules.has("downloads")) return false;
      return true;
    });
    if (results.length === 0) {
      return [
        outcome.notApplicable(
          spec("links", "none", { title: "Page links", feature: "Links", element: "a[href]", steps: ["Collect links on the page"], expected: "Links resolve" }),
          "No checkable links were found on this page.",
        ),
      ];
    }
    return results;
  },
};

export const socialLinksModule: TestModule = {
  id: "social-links",
  scope: "page",
  async run(ctx) {
    const results = await runLinkSet(ctx, "social-links", (kind) => kind === "social");
    return results.length
      ? results
      : [
          outcome.notApplicable(
            spec("social-links", "none", { title: "Social links", feature: "Social link", element: "a[href] to social platforms", steps: ["Collect links"], expected: "Social links resolve" }),
            "No social media links were found on this page.",
          ),
        ];
  },
};

export { KIND_LABEL as LINK_KIND_LABEL };
