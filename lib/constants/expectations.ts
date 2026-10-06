import type { ExpectationSource, TestResultStatus } from "@/types";

/** Expectation hierarchy, highest authority first (see EXPECTATION_SOURCES). */
export const EXPECTATION_LABELS: Record<ExpectationSource, { priority: number; label: string }> = {
  REQUIREMENT: { priority: 1, label: "Explicit requirement" },
  ACCEPTANCE_CRITERIA: { priority: 2, label: "Acceptance criteria" },
  FIGMA: { priority: 3, label: "Figma design" },
  REFERENCE_DOCUMENT: { priority: 4, label: "Reference document" },
  BROWSER_STANDARD: { priority: 5, label: "Standard browser / web behaviour" },
  DETECTED_FUNCTIONALITY: { priority: 6, label: "Functionality detected on the page" },
  AI_EXPLORATORY: { priority: 7, label: "AI exploratory expectation (never a verified failure)" },
};

/** How a verdict should be read: a FAIL is a verified failure; a WARNING is a potential issue for review. */
export function verdictLabel(status: TestResultStatus): string | null {
  if (status === "FAIL") return "Verified failure";
  if (status === "WARNING") return "Potential issue — review required";
  return null;
}
