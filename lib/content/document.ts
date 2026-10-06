import { extensionOf } from "@/lib/documents/validate";
import type { ContentBlock, ReferenceContent } from "./types";

/** Reference formats whose text can be extracted for content comparison. */
export const COMPARABLE_EXTENSIONS = ["pdf", "docx", "md", "txt"] as const;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const clean = (s: string) => decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

/** Parses headings, paragraphs and list items out of simple HTML (as produced by mammoth). */
export function blocksFromHtml(html: string): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const m of html.matchAll(/<(h[1-6]|p|li)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const text = clean(m[2]);
    if (!text) continue;
    const tag = m[1].toLowerCase();
    if (tag.startsWith("h")) blocks.push({ kind: "heading", level: Number(tag[1]), text });
    else blocks.push({ kind: tag === "li" ? "list-item" : "paragraph", level: null, text });
  }
  return blocks;
}

export function blocksFromMarkdown(md: string): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: "paragraph", level: null, text: para.join(" ").replace(/\s+/g, " ").trim() });
    para = [];
  };
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const item = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2].replace(/[*_`]/g, "").trim() });
    } else if (item) {
      flush();
      blocks.push({ kind: "list-item", level: null, text: item[1].replace(/[*_`]/g, "").trim() });
    } else if (!line) flush();
    else para.push(line.replace(/[*_`]/g, ""));
  }
  flush();
  return blocks.filter((b) => b.text);
}

/** Heuristic heading detection for unstructured text (PDF/TXT): short line, no closing punctuation. */
function looksLikeHeading(line: string): boolean {
  const words = line.split(/\s+/).length;
  if (words > 12 || line.length > 90 || /[.,;:!?]$/.test(line)) return false;
  const capitalised = line.split(/\s+/).filter((w) => /^[A-Z0-9]/.test(w)).length;
  return line === line.toUpperCase() ? /[A-Z]/.test(line) : capitalised / words >= 0.6;
}

/**
 * Turns plain text (from a PDF or .txt) into blocks. Lines wrapped by the PDF layout are
 * re-joined into paragraphs; short title-like lines become headings with an unknown level.
 */
export function blocksFromPlainText(text: string): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: "paragraph", level: null, text: para.join(" ").replace(/\s+/g, " ").trim() });
    para = [];
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (!line) {
      flush();
      continue;
    }
    const bullet = /^(?:[•▪◦‣\-*]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      flush();
      blocks.push({ kind: "list-item", level: null, text: bullet[1] });
    } else if (para.length === 0 && looksLikeHeading(line)) {
      blocks.push({ kind: "heading", level: null, text: line });
    } else {
      para.push(line);
      if (/[.!?]["')\]]?$/.test(line)) flush();
    }
  }
  flush();
  return blocks.filter((b) => b.text);
}

/** Extracts structured text from an uploaded reference document. Throws for unreadable files. */
export async function extractReferenceContent(input: { documentId: string; fileName: string; bytes: Uint8Array }): Promise<ReferenceContent> {
  const ext = extensionOf(input.fileName);
  if (ext === "docx") {
    const mammoth = await import("mammoth");
    const { value } = await mammoth.convertToHtml({ buffer: Buffer.from(input.bytes) });
    return { documentId: input.documentId, fileName: input.fileName, format: "docx", blocks: blocksFromHtml(value), structuredHeadings: true };
  }
  if (ext === "pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(input.bytes));
    const { text } = await extractText(pdf, { mergePages: false });
    const pages = Array.isArray(text) ? text : [text];
    return { documentId: input.documentId, fileName: input.fileName, format: "pdf", blocks: pages.flatMap((t) => blocksFromPlainText(t)), structuredHeadings: false };
  }
  const decoded = new TextDecoder().decode(input.bytes);
  if (ext === "md") return { documentId: input.documentId, fileName: input.fileName, format: "md", blocks: blocksFromMarkdown(decoded), structuredHeadings: true };
  if (ext === "txt") return { documentId: input.documentId, fileName: input.fileName, format: "txt", blocks: blocksFromPlainText(decoded), structuredHeadings: false };
  throw new Error(`.${ext} documents are not supported for content comparison (use PDF, DOCX, Markdown or text).`);
}
