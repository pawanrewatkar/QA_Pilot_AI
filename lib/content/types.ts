import type { ContentComparisonMode } from "@/types";

export type BlockKind = "heading" | "paragraph" | "list-item";

/** One unit of text from the reference document or the web page, in reading order. */
export interface ContentBlock {
  kind: BlockKind;
  /** Heading level 1–6 when known (DOCX/Markdown/HTML); null when it had to be inferred (PDF/TXT). */
  level: number | null;
  text: string;
}

export interface ReferenceContent {
  documentId: string;
  fileName: string;
  format: "pdf" | "docx" | "md" | "txt";
  blocks: ContentBlock[];
  /** True when heading levels come from the document's own structure rather than heuristics. */
  structuredHeadings: boolean;
}

export type ReferenceLoadResult =
  | { status: "ok"; content: ReferenceContent }
  | { status: "missing" }
  | { status: "unsupported"; fileName: string; reason: string }
  | { status: "error"; fileName: string; reason: string };

export interface PageContent {
  blocks: ContentBlock[];
  ctas: string[];
}

export const FINDING_KINDS = ["MATCH", "MISSING", "CHANGED", "SPELLING", "HEADING", "EXTRA", "REPEATED", "ORDER", "CTA"] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

export interface ContentFinding {
  kind: FindingKind;
  mode: ContentComparisonMode;
  /** Reference section heading the finding belongs to (section mode), if any. */
  section: string | null;
  expected: string | null;
  actual: string | null;
  similarity: number | null;
  message: string;
  diff?: { missingWords: string[]; extraWords: string[] };
}

export interface ComparisonReport {
  mode: ContentComparisonMode;
  /** False when the page does not appear to correspond to the reference document at all. */
  relevant: boolean;
  relevance: number;
  findings: ContentFinding[];
  matched: number;
  compared: number;
}
