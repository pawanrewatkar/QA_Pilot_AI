import { normalizeHeader } from "./mapping";
import type { ResultColumnSet, SheetColumn } from "./types";

export const resultHeaders = (set: number) =>
  set === 1 ? { actual: "Actual Result", status: "Status", date: "Date" } : { actual: `Actual Result ${set}`, status: `Status ${set}`, date: `Date ${set}` };

/**
 * Chooses where this execution's results go, without ever overwriting earlier results.
 *
 * Execution sets are "Actual Result / Status / Date", then "Actual Result 2 / Status 2 / Date 2", and so on.
 * A set is reused only when none of its existing columns contains any data (content is checked, not just
 * headers). A set with any data — even partial, e.g. only Actual Result and Status filled — counts as an
 * earlier execution, and the next set is used. Missing columns of the chosen set are appended after the last
 * used column. Columns mapped as test-case inputs are never treated as result columns.
 *
 * @param hasData returns true when the column has any non-empty cell below the header row.
 */
export function planResultColumns(columns: SheetColumn[], hasData: (column: number) => boolean, lastColumn: number, reserved: ReadonlySet<number> = new Set()): ResultColumnSet {
  const byHeader = new Map<string, number>();
  for (const c of columns) {
    const key = normalizeHeader(c.header);
    if (!byHeader.has(key)) byHeader.set(key, c.index);
  }
  for (let set = 1; ; set++) {
    const names = resultHeaders(set);
    const found = {
      actual: byHeader.get(normalizeHeader(names.actual)),
      status: byHeader.get(normalizeHeader(names.status)),
      date: byHeader.get(normalizeHeader(names.date)),
    };
    const existing = Object.values(found).filter((c): c is number => c !== undefined);
    if (existing.some((c) => reserved.has(c) || hasData(c))) continue; // earlier execution (or user data): keep it
    let next = Math.max(lastColumn, ...columns.map((c) => c.index), 0);
    const place = (header: string, index: number | undefined) => (index !== undefined ? { header, index, exists: true } : { header, index: ++next, exists: false });
    return { set, actual: place(names.actual, found.actual), status: place(names.status, found.status), date: place(names.date, found.date) };
  }
}
