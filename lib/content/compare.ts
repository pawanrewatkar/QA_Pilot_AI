import type { ContentComparisonMode } from "@/types";
import type { ComparisonReport, ContentBlock, ContentFinding, PageContent } from "./types";

/**
 * Deterministic content comparison between a reference document and a rendered page.
 * - EXACT: every reference block must appear verbatim (case and punctuation significant,
 *   whitespace and typographic quotes normalised).
 * - SECTION: reference sections (a heading and its body) are matched to page sections by
 *   heading; body text is compared within the matched section, case-insensitively.
 * - SEMANTIC: requires an AI provider and is never approximated here.
 */

const CHANGED_THRESHOLD = 0.6;
const RELEVANCE_THRESHOLD = 0.3;
const MIN_EXTRA_WORDS = 4;

/** Whitespace, quote/dash and Unicode normalisation that never changes meaning. */
export function normalizeText(text: string, caseSensitive: boolean): string {
  const t = text
    .normalize("NFKC")
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, "-")
    .replace(/…/g, "...")
    .replace(/\s+/g, " ")
    .trim();
  return caseSensitive ? t : t.toLowerCase();
}

export function words(text: string): string[] {
  return normalizeText(text, false)
    .replace(/[^\p{L}\p{N}'\s-]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Word-level similarity: 2·LCS / (|a| + |b|), in [0, 1]. */
export function similarity(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (!x.length && !y.length) return 1;
  if (!x.length || !y.length) return 0;
  const prev = new Array(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i++) {
    let diag = 0;
    for (let j = 1; j <= y.length; j++) {
      const tmp = prev[j];
      prev[j] = x[i - 1] === y[j - 1] ? diag + 1 : Math.max(prev[j], prev[j - 1]);
      diag = tmp;
    }
  }
  return Math.round(((2 * prev[y.length]) / (x.length + y.length)) * 1000) / 1000;
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

/** Word differences between two texts (multiset difference, case-insensitive). */
export function wordDiff(expected: string, actual: string): { missingWords: string[]; extraWords: string[] } {
  const count = (list: string[]) => list.reduce((m, w) => m.set(w, (m.get(w) ?? 0) + 1), new Map<string, number>());
  const e = count(words(expected));
  const a = count(words(actual));
  const missingWords: string[] = [];
  const extraWords: string[] = [];
  for (const [w, n] of e) for (let i = 0; i < n - (a.get(w) ?? 0); i++) missingWords.push(w);
  for (const [w, n] of a) for (let i = 0; i < n - (e.get(w) ?? 0); i++) extraWords.push(w);
  return { missingWords, extraWords };
}

/** True when the only differences are small per-word edits (typos), not different wording. */
export function isSpellingOnly(expected: string, actual: string): boolean {
  const { missingWords, extraWords } = wordDiff(expected, actual);
  if (!missingWords.length || missingWords.length !== extraWords.length || missingWords.length > 3) return false;
  const pool = [...extraWords];
  return missingWords.every((m) => {
    const i = pool.findIndex((x) => levenshtein(m, x) <= Math.max(1, Math.floor(m.length / 4)) && Math.min(m.length, x.length) >= 3);
    if (i < 0) return false;
    pool.splice(i, 1);
    return true;
  });
}

const compatible = (a: ContentBlock, b: ContentBlock) => (a.kind === "heading") === (b.kind === "heading");

interface Section {
  heading: ContentBlock | null;
  body: ContentBlock[];
}

/** Splits blocks into sections at every heading. Content before the first heading forms an untitled section. */
export function toSections(blocks: ContentBlock[]): Section[] {
  const sections: Section[] = [{ heading: null, body: [] }];
  for (const b of blocks) {
    if (b.kind === "heading") sections.push({ heading: b, body: [] });
    else sections[sections.length - 1].body.push(b);
  }
  return sections.filter((s) => s.heading || s.body.length);
}

interface Match {
  page: ContentBlock | null;
  pageIndex: number;
  score: number;
}

function bestMatch(ref: ContentBlock, candidates: ContentBlock[], caseSensitive: boolean, pageText: string): Match {
  const target = normalizeText(ref.text, caseSensitive);
  let best: Match = { page: null, pageIndex: -1, score: 0 };
  candidates.forEach((p, i) => {
    if (!compatible(ref, p)) return;
    // Only normalised equality counts as identical; word similarity ignores case, so cap it below 1.
    const score = normalizeText(p.text, caseSensitive) === target ? 1 : Math.min(similarity(ref.text, p.text), 0.999);
    if (score > best.score) best = { page: p, pageIndex: i, score };
  });
  // A paragraph merged into a larger page block still counts as present when it appears verbatim.
  if (best.score < 1 && ref.kind !== "heading" && target.length >= 20 && pageText.includes(target)) {
    const holder = candidates.findIndex((p) => normalizeText(p.text, caseSensitive).includes(target));
    return { page: candidates[holder] ?? null, pageIndex: holder, score: 1 };
  }
  return best;
}

function compareBlocks(
  refs: ContentBlock[],
  pageBlocks: ContentBlock[],
  mode: ContentComparisonMode,
  section: string | null,
  caseSensitive: boolean,
  structuredHeadings: boolean,
): { findings: ContentFinding[]; matchedPageIdx: Set<number>; order: { ref: number; page: number }[]; matched: number } {
  const findings: ContentFinding[] = [];
  const matchedPageIdx = new Set<number>();
  const order: { ref: number; page: number }[] = [];
  const pageText = normalizeText(pageBlocks.map((b) => b.text).join(" \n "), caseSensitive);
  let matched = 0;

  refs.forEach((ref, refIndex) => {
    const m = bestMatch(ref, pageBlocks, caseSensitive, pageText);
    if (m.page && m.score === 1) {
      matched++;
      matchedPageIdx.add(m.pageIndex);
      order.push({ ref: refIndex, page: m.pageIndex });
      if (ref.kind === "heading" && structuredHeadings && ref.level && m.page.level && ref.level !== m.page.level) {
        findings.push({ kind: "HEADING", mode, section, expected: `H${ref.level}: ${ref.text}`, actual: `H${m.page.level}: ${m.page.text}`, similarity: 1, message: `Heading level differs: reference H${ref.level}, page H${m.page.level}` });
      } else {
        findings.push({ kind: "MATCH", mode, section, expected: ref.text, actual: m.page.text, similarity: 1, message: "Present on the page" });
      }
      return;
    }
    if (m.page && m.score >= CHANGED_THRESHOLD) {
      matchedPageIdx.add(m.pageIndex);
      order.push({ ref: refIndex, page: m.pageIndex });
      const diff = wordDiff(ref.text, m.page.text);
      const spelling = isSpellingOnly(ref.text, m.page.text);
      const kind = ref.kind === "heading" ? "HEADING" : spelling ? "SPELLING" : "CHANGED";
      const caseOnly = normalizeText(ref.text, false) === normalizeText(m.page.text, false);
      findings.push({
        kind,
        mode,
        section,
        expected: ref.text,
        actual: m.page.text,
        similarity: m.score,
        diff,
        message: caseOnly
          ? "Text differs only in capitalisation or punctuation"
          : spelling
            ? `Spelling differs: ${diff.missingWords.map((w, i) => `"${w}" → "${diff.extraWords[i]}"`).join(", ")}`
            : ref.kind === "heading"
              ? "Heading text differs from the reference"
              : `Text changed (${Math.round(m.score * 100)}% similar)`,
      });
      return;
    }
    findings.push({ kind: "MISSING", mode, section, expected: ref.text, actual: null, similarity: m.score || null, message: ref.kind === "heading" ? "Reference heading not found on the page" : "Reference content not found on the page" });
  });
  return { findings, matchedPageIdx, order, matched };
}

/** Indices (into `order`) that are not part of the longest in-order run of page positions. */
function outOfOrder(order: { ref: number; page: number }[]): number[] {
  const n = order.length;
  if (n < 3) return [];
  const len = new Array(n).fill(1);
  const prev = new Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < i; j++) {
      if (order[j].page < order[i].page && len[j] + 1 > len[i]) {
        len[i] = len[j] + 1;
        prev[i] = j;
      }
    }
  }
  let end = len.indexOf(Math.max(...len));
  const keep = new Set<number>();
  while (end >= 0) {
    keep.add(end);
    end = prev[end];
  }
  return order.map((_, i) => i).filter((i) => !keep.has(i));
}

export function compareContent(
  reference: { blocks: ContentBlock[]; structuredHeadings: boolean },
  page: PageContent,
  mode: Exclude<ContentComparisonMode, "SEMANTIC">,
): ComparisonReport {

  const refs = reference.blocks.filter((b) => words(b.text).length > 0);
  const findings: ContentFinding[] = [];
  const allMatchedPage = new Set<number>();
  let matched = 0;

  if (mode === "EXACT") {
    const r = compareBlocks(refs, page.blocks, mode, null, true, reference.structuredHeadings);
    findings.push(...r.findings);
    r.matchedPageIdx.forEach((i) => allMatchedPage.add(i));
    matched = r.matched;
    for (const i of outOfOrder(r.order)) {
      const ref = refs[r.order[i].ref];
      findings.push({ kind: "ORDER", mode, section: null, expected: ref.text, actual: page.blocks[r.order[i].page]?.text ?? null, similarity: null, message: "Appears in a different position than in the reference" });
    }
  } else {
    const pageSections = toSections(page.blocks);
    const sectionStart = new Map<Section, number>();
    let idx = 0;
    for (const s of pageSections) {
      sectionStart.set(s, idx);
      idx += (s.heading ? 1 : 0) + s.body.length;
    }
    for (const refSection of toSections(refs)) {
      const title = refSection.heading?.text ?? null;
      // Find the page section whose heading best matches the reference heading.
      let target: Section | null = null;
      let targetScore = 0;
      if (refSection.heading) {
        for (const ps of pageSections) {
          if (!ps.heading) continue;
          const score = similarity(refSection.heading.text, ps.heading.text);
          if (score > targetScore) {
            target = ps;
            targetScore = score;
          }
        }
      }
      if (refSection.heading && (!target || targetScore < CHANGED_THRESHOLD)) {
        // Section heading absent: compare its body against the whole page so content is still credited if it moved.
        findings.push({ kind: "MISSING", mode, section: title, expected: refSection.heading.text, actual: null, similarity: targetScore || null, message: "Reference section heading not found on the page" });
        const r = compareBlocks(refSection.body, page.blocks, mode, title, false, reference.structuredHeadings);
        findings.push(...r.findings);
        r.matchedPageIdx.forEach((i) => allMatchedPage.add(i));
        matched += r.matched;
        continue;
      }
      const scopeBlocks = target ? [...(target.heading ? [target.heading] : []), ...target.body] : page.blocks;
      const offset = target ? sectionStart.get(target)! : 0;
      const r = compareBlocks(refSection.heading ? [refSection.heading, ...refSection.body] : refSection.body, scopeBlocks, mode, title, false, reference.structuredHeadings);
      // Body text that is not in its own section may live elsewhere on the page: report it as moved, not missing.
      for (const f of r.findings) {
        if (f.kind === "MISSING" && target && f.expected) {
          const elsewhere = page.blocks.findIndex((b) => normalizeText(b.text, false) === normalizeText(f.expected!, false));
          if (elsewhere >= 0) {
            allMatchedPage.add(elsewhere);
            findings.push({ ...f, kind: "ORDER", actual: page.blocks[elsewhere].text, similarity: 1, message: `Found on the page, but outside the "${title}" section` });
            continue;
          }
        }
        findings.push(f);
      }
      r.matchedPageIdx.forEach((i) => allMatchedPage.add(i + (target ? offset : 0)));
      matched += r.matched;
    }
  }

  const compared = refs.length;
  const credited = findings.filter((f) => f.kind !== "MISSING").length;
  const relevance = compared ? Math.round((credited / compared) * 100) / 100 : 0;
  const relevant = relevance >= RELEVANCE_THRESHOLD;

  if (relevant) {
    // Extra content: substantial page text that has no counterpart in the reference.
    page.blocks.forEach((b, i) => {
      if (allMatchedPage.has(i) || b.kind === "heading" || words(b.text).length < MIN_EXTRA_WORDS) return;
      findings.push({ kind: "EXTRA", mode, section: null, expected: null, actual: b.text, similarity: null, message: "Page content not present in the reference document" });
    });
    // Repeated content on the page.
    const seen = new Map<string, number>();
    for (const b of page.blocks) {
      if (words(b.text).length < MIN_EXTRA_WORDS) continue;
      const key = normalizeText(b.text, false);
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    for (const [text, count] of seen) {
      if (count > 1) findings.push({ kind: "REPEATED", mode, section: null, expected: null, actual: page.blocks.find((b) => normalizeText(b.text, false) === text)!.text, similarity: null, message: `Repeated ${count} times on the page` });
    }
    // Calls to action on the page whose label does not appear anywhere in the reference.
    const refText = normalizeText(refs.map((r) => r.text).join(" \n "), false);
    for (const cta of new Set(page.ctas.map((c) => c.trim()).filter(Boolean))) {
      if (!refText.includes(normalizeText(cta, false))) {
        findings.push({ kind: "CTA", mode, section: null, expected: null, actual: cta, similarity: null, message: "Call-to-action label not found in the reference document" });
      }
    }
  }

  return { mode, relevant, relevance, findings, matched, compared };
}
