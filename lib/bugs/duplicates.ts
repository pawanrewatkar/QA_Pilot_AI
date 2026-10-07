/**
 * Duplicate detection. The active detector is deterministic: the same fingerprint (page + test
 * case identity) is the same bug. "Related" bugs share a page, test type and selector but come
 * from different checks; they are shown for review and never merged automatically.
 *
 * A future AI-assisted detector can implement the same interface (e.g. backed by
 * AIProvider.findDuplicateBugs) and must only ever suggest, never merge on its own.
 */
export interface BugIdentity {
  id?: string;
  fingerprint: string;
  pageUrl: string | null;
  testType: string | null;
  selector: string | null;
  element: string | null;
}

export interface DuplicateMatch {
  bugId: string;
  kind: "duplicate" | "related";
  reason: string;
}

export interface DuplicateDetector {
  readonly id: string;
  /** Exact duplicates are merged by the engine; related matches are informational. */
  find(candidate: BugIdentity, existing: (BugIdentity & { id: string })[]): DuplicateMatch[];
}

export class DeterministicDuplicateDetector implements DuplicateDetector {
  readonly id = "deterministic";

  find(candidate: BugIdentity, existing: (BugIdentity & { id: string })[]): DuplicateMatch[] {
    const out: DuplicateMatch[] = [];
    for (const bug of existing) {
      if (bug.id === candidate.id) continue;
      if (bug.fingerprint === candidate.fingerprint) {
        out.push({ bugId: bug.id, kind: "duplicate", reason: "Same page and same test case identity" });
        continue;
      }
      const samePage = !!bug.pageUrl && bug.pageUrl === candidate.pageUrl;
      const sameType = !!bug.testType && bug.testType === candidate.testType;
      const sameTarget = (!!bug.selector && bug.selector === candidate.selector) || (!!bug.element && bug.element === candidate.element);
      if (samePage && sameType && sameTarget) out.push({ bugId: bug.id, kind: "related", reason: "Same page, test type and element" });
    }
    return out;
  }
}
