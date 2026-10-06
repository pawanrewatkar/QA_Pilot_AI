import { compareContent } from "@/lib/content/compare";
import { exclusionSelectors, extractPageContent } from "@/lib/content/page-content";
import type { ContentFinding, FindingKind } from "@/lib/content/types";
import { resolveRunOptions } from "@/types";
import type { TestModule } from "../context";
import { detail } from "../details";
import { evidence, outcome, type CheckOutcome } from "../outcome";
import { spec } from "./helpers";

const MODE_LABEL = { EXACT: "Exact comparison", SECTION: "Section comparison", SEMANTIC: "Semantic comparison" } as const;

/** How each finding kind is judged. The reference document is the expectation (hierarchy level 4). */
const KIND_RULES: Record<Exclude<FindingKind, "MATCH">, { title: string; status: "FAIL" | "WARNING"; expected: string }> = {
  MISSING: { title: "Reference content is present on the page", status: "FAIL", expected: "Every heading and paragraph of the reference document appears on the page" },
  CHANGED: { title: "Page text matches the reference wording", status: "FAIL", expected: "Paragraphs use the reference wording" },
  SPELLING: { title: "Page spelling matches the reference", status: "FAIL", expected: "Words are spelled as in the reference document" },
  HEADING: { title: "Headings match the reference", status: "FAIL", expected: "Headings use the reference text and level" },
  ORDER: { title: "Content order follows the reference", status: "WARNING", expected: "Content appears in the reference order and section" },
  EXTRA: { title: "No content beyond the reference", status: "WARNING", expected: "Page content is covered by the reference document" },
  REPEATED: { title: "No unintentionally repeated content", status: "WARNING", expected: "Each paragraph appears once" },
  CTA: { title: "Call-to-action labels match the reference", status: "WARNING", expected: "CTA labels appear in the reference document" },
};

const describe = (f: ContentFinding) =>
  [f.section ? `[${f.section}] ` : "", f.message, f.expected ? `\n  Reference: "${f.expected.slice(0, 300)}"` : "", f.actual ? `\n  Page: "${f.actual.slice(0, 300)}"` : ""].join("");

export const contentModule: TestModule = {
  id: "content",
  scope: "page",
  async run(ctx) {
    const { content } = resolveRunOptions(ctx.options);
    const modeLabel = MODE_LABEL[content.mode];
    const base = (key: string, title: string, expected: string) =>
      spec("content", key, {
        title: `${title} (${modeLabel})`,
        section: "Content",
        feature: `Content comparison — ${modeLabel}`,
        element: "main page content",
        steps: ["Extract text from the reference document", `Extract visible page text (excluding: ${content.exclusions.join(", ") || "nothing"}${content.customSelectors.length ? `, ${content.customSelectors.join(", ")}` : ""})`, `Compare using ${modeLabel.toLowerCase()}`],
        expected,
        expectationSource: "REFERENCE_DOCUMENT",
      });

    const ref = await ctx.referenceDocument();
    const overview = base("overview", "Page content matches the reference document", "Page content corresponds to the uploaded reference document");
    if (ref.status === "missing") return [outcome.notExecuted(overview, "No reference document is uploaded for this project. Upload a PDF or DOCX on the project to enable content comparison.")];
    if (ref.status !== "ok") return [outcome.notExecuted(overview, `The reference document "${ref.fileName}" could not be used: ${ref.reason}`)];
    if (content.mode === "SEMANTIC") {
      return [outcome.notExecuted(overview, "Semantic comparison needs an AI provider, and none is configured. Exact or section comparison can be selected instead; neither uses AI.")];
    }

    const pageContent = await extractPageContent(ctx.session.page, exclusionSelectors(content.exclusions, content.customSelectors));
    const report = compareContent(ref.content, pageContent, content.mode);
    const docLabel = `${ref.content.fileName} (${ref.content.format.toUpperCase()}, ${ref.content.blocks.length} blocks)`;
    const row = (f: ContentFinding, status: string) =>
      detail("content_comparisons", {
        document_id: ref.content.documentId,
        status,
        expected_text: f.expected,
        actual_text: f.actual,
        similarity_score: f.similarity,
        diff: f.diff ? JSON.stringify(f.diff) : null,
        mode: content.mode,
        kind: f.kind,
        section: f.section,
        message: f.message,
      });

    if (!report.relevant) {
      return [
        outcome.notApplicable(
          overview,
          `This page does not appear to correspond to ${docLabel}: only ${Math.round(report.relevance * 100)}% of the reference content was found, below the 30% needed to compare it meaningfully.`,
        ),
      ];
    }

    const results: CheckOutcome[] = [];
    const matches = report.findings.filter((f) => f.kind === "MATCH");
    const problems = report.findings.filter((f) => f.kind !== "MATCH");
    results.push(
      outcome.pass(
        base("coverage", "Reference content coverage measured", `Report how much of ${ref.content.fileName} is on the page`),
        `${report.matched} of ${report.compared} reference blocks found verbatim; ${Math.round(report.relevance * 100)}% of the reference is represented on the page (document: ${docLabel}).`,
        [`${report.matched}/${report.compared} blocks matched exactly`, `Comparison mode: ${modeLabel}`],
        { details: matches.slice(0, 200).map((f) => row(f, "PASS")) },
      ),
    );

    for (const [kind, rule] of Object.entries(KIND_RULES) as [Exclude<FindingKind, "MATCH">, (typeof KIND_RULES)[keyof typeof KIND_RULES]][]) {
      const found = problems.filter((f) => f.kind === kind);
      const s = base(kind.toLowerCase(), rule.title, rule.expected);
      if (!found.length) {
        results.push(outcome.pass(s, `No ${kind.toLowerCase()} differences found`, [`Checked ${report.compared} reference blocks against ${pageContent.blocks.length} page blocks`]));
        continue;
      }
      const list = found.slice(0, 25).map(describe).join("\n");
      const ev = [evidence.note(`${found.length} ${kind.toLowerCase()} finding(s)`, list)];
      const actual = `${found.length} finding(s). First: ${describe(found[0]).replace(/\n\s*/g, " ")}`.slice(0, 600);
      const details = found.slice(0, 200).map((f) => row(f, rule.status));
      results.push(rule.status === "FAIL" ? outcome.fail(s, actual, ev, { details }) : outcome.warn(s, actual, { evidence: ev, details }));
    }
    return results;
  },
};
