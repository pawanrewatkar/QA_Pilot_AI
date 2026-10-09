import { CASE_FIELD_LABELS, CASE_FIELDS, type CaseField, type ColumnMapping, type SheetColumn } from "./types";

/** Header spellings per field, strongest first. Matching ignores case, punctuation and extra spaces. */
const SYNONYMS: Record<CaseField, string[]> = {
  caseId: ["test case id", "testcase id", "tc id", "tc no", "tc number", "case id", "test id", "id", "tc", "s no", "sr no", "serial no", "no"],
  title: ["test case", "test case title", "test case name", "testcase", "test title", "title", "test case description", "description", "summary", "objective", "test objective", "name"],
  scenario: ["test scenario", "scenario", "scenario description", "feature", "use case", "requirement"],
  steps: ["test steps", "steps", "steps to reproduce", "step", "test procedure", "procedure", "action", "actions", "test actions"],
  expected: ["expected result", "expected results", "expected", "expected outcome", "expected behaviour", "expected behavior", "expected output"],
  url: ["url", "page url", "page", "link", "test url", "screen url"],
  testData: ["test data", "data", "input", "input data", "test input"],
  preconditions: ["precondition", "preconditions", "pre condition", "pre conditions", "prerequisite", "prerequisites"],
};

/** Columns written by this module; never mapped as inputs. */
const RESULT_HEADER = /^(actual result|status|date|execution date|executed on)( \d+)?$/;

export const normalizeHeader = (h: string) => h.toLowerCase().replace(/[_\-./#:()]+/g, " ").replace(/\s+/g, " ").trim();

/** 0 = no match; higher = better. Exact synonym beats a synonym contained in the header. */
export function scoreHeader(header: string, field: CaseField): number {
  const h = normalizeHeader(header);
  if (!h || RESULT_HEADER.test(h)) return 0;
  const list = SYNONYMS[field];
  const exact = list.indexOf(h);
  if (exact >= 0) return 100 - exact;
  // Longer synonyms contained as whole words (e.g. "Expected Result (UI)") score lower than exact ones.
  for (const [i, syn] of list.entries()) {
    if (syn.length >= 4 && new RegExp(`\\b${syn.replace(/ /g, "\\s")}\\b`).test(h)) return 50 - i;
  }
  return 0;
}

/** Proposes a mapping: each field gets its best-scoring column, and each column is used at most once. */
export function detectMapping(columns: SheetColumn[]): ColumnMapping {
  const candidates: { field: CaseField; column: number; score: number }[] = [];
  for (const field of CASE_FIELDS) {
    for (const c of columns) {
      const score = scoreHeader(c.header, field);
      if (score > 0) candidates.push({ field, column: c.index, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const mapping: ColumnMapping = {};
  const used = new Set<number>();
  for (const c of candidates) {
    if (mapping[c.field] !== undefined || used.has(c.column)) continue;
    mapping[c.field] = c.column;
    used.add(c.column);
  }
  return mapping;
}

export interface MappingValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/** A sheet is executable when each case has a test case/scenario and an expected result. Steps are optional. */
export function validateMapping(mapping: ColumnMapping, columns: SheetColumn[]): MappingValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const valid = new Set(columns.map((c) => c.index));
  for (const [field, col] of Object.entries(mapping)) {
    if (col !== undefined && !valid.has(col)) errors.push(`${CASE_FIELD_LABELS[field as CaseField]} is mapped to a column that does not exist.`);
  }
  const cols = Object.values(mapping).filter((c): c is number => c !== undefined);
  if (new Set(cols).size !== cols.length) errors.push("The same column is mapped to more than one field.");
  if (mapping.title === undefined && mapping.scenario === undefined) errors.push("Map a Test Case or Test Scenario column.");
  if (mapping.expected === undefined) errors.push("Map an Expected Result column.");
  if (mapping.steps === undefined) warnings.push("No Test Steps column is mapped. Steps will be inferred where the test case clearly describes them; otherwise the case is NOT EXECUTED.");
  return { ok: errors.length === 0, errors, warnings };
}
