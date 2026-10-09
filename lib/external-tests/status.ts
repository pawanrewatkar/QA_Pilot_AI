import type { ExternalStatus } from "./types";

/** Worst-first: a case is as good as its weakest browser/device result. */
const PRECEDENCE: ExternalStatus[] = ["FAIL", "HUMAN INTERACTION", "NOT EXECUTED", "PASS", "NOT APPLICABLE"];

export function aggregateStatus(statuses: ExternalStatus[]): ExternalStatus {
  for (const s of PRECEDENCE) if (statuses.includes(s)) return s;
  return "NOT EXECUTED";
}
