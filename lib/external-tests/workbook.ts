import ExcelJS from "exceljs";
import { extensionOf, matchesSignature, sanitizeFileName } from "@/lib/documents/validate";
import { CASE_FIELDS, MAX_TEST_CASES, type ColumnMapping, type ExternalCase, type ParsedSheet, type SheetColumn, type SheetRow } from "./types";
import { scoreHeader } from "./mapping";

export const SUPPORTED_WORKBOOK_EXTENSIONS = ["xlsx", "xlsm"] as const;

export class WorkbookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkbookError";
  }
}

/** Validates name, size and file signature before the workbook is parsed. Cell contents are always treated as data. */
export function validateWorkbookFile(fileName: string, bytes: Uint8Array, maxBytes: number): { ok: true; fileName: string } | { ok: false; error: string } {
  const name = sanitizeFileName(fileName || "test-cases.xlsx");
  const ext = extensionOf(name);
  if (!(SUPPORTED_WORKBOOK_EXTENSIONS as readonly string[]).includes(ext)) {
    return { ok: false, error: `Unsupported file type ".${ext || "?"}". Upload an Excel workbook (.xlsx or .xlsm). Older .xls files must be saved as .xlsx first.` };
  }
  if (bytes.byteLength === 0) return { ok: false, error: "The workbook is empty." };
  if (bytes.byteLength > maxBytes) return { ok: false, error: `The workbook is too large. Maximum size is ${Math.round(maxBytes / 1024 / 1024)} MB.` };
  if (!matchesSignature(bytes, "zip")) return { ok: false, error: "The file is not a valid Excel workbook (.xlsx files are ZIP archives)." };
  return { ok: true, fileName: name };
}

export async function loadWorkbook(bytes: Uint8Array): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer);
  } catch (error) {
    throw new WorkbookError(`The workbook could not be read: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  }
  if (wb.worksheets.length === 0) throw new WorkbookError("The workbook contains no worksheets.");
  return wb;
}

export function worksheetNames(wb: ExcelJS.Workbook): string[] {
  return wb.worksheets.filter((ws) => ws.state !== "veryHidden").map((ws) => ws.name);
}

/** Text of a cell as the user sees it (formula results, rich text, dates); never evaluates anything. */
export function cellText(cell: ExcelJS.Cell): string {
  const v = cell.value;
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    if ("richText" in v) return v.richText.map((r) => r.text).join("").trim();
    if ("result" in v) return v.result === undefined || v.result === null ? "" : String(v.result instanceof Date ? v.result.toISOString().slice(0, 10) : v.result).trim();
    if ("text" in v) return String(v.text).trim();
    if ("error" in v) return String(v.error);
  }
  return String(cell.text ?? v).trim();
}

const HEADER_SCAN_ROWS = 20;

/**
 * Finds the header row: within the first rows, the row whose cells look most like test-case headers
 * (at least two non-empty cells). Falls back to the first row with two or more values.
 */
export function detectHeaderRow(ws: ExcelJS.Worksheet): number | null {
  let best: { row: number; score: number } | null = null;
  let firstFilled: number | null = null;
  const last = Math.min(ws.rowCount, HEADER_SCAN_ROWS);
  for (let r = 1; r <= last; r++) {
    const texts: string[] = [];
    ws.getRow(r).eachCell({ includeEmpty: false }, (cell) => {
      const t = cellText(cell);
      if (t) texts.push(t);
    });
    if (texts.length < 2) continue;
    firstFilled ??= r;
    const score = texts.reduce((n, t) => n + (CASE_FIELDS.some((f) => scoreHeader(t, f) > 0) ? 1 : 0), 0);
    if (score > 0 && (!best || score > best.score)) best = { row: r, score };
  }
  return best?.row ?? firstFilled;
}

/** Reads a worksheet: header columns and every non-empty data row below the header. Original data is untouched. */
export function readSheet(wb: ExcelJS.Workbook, sheetName: string): ParsedSheet {
  const ws = wb.getWorksheet(sheetName);
  if (!ws) throw new WorkbookError(`Worksheet "${sheetName}" does not exist in this workbook.`);
  const headerRow = detectHeaderRow(ws);
  if (headerRow === null) throw new WorkbookError(`Worksheet "${sheetName}" is empty or has no header row.`);
  const columns: SheetColumn[] = [];
  ws.getRow(headerRow).eachCell({ includeEmpty: false }, (cell, col) => {
    const header = cellText(cell);
    if (header) columns.push({ index: col, header });
  });
  const rows: SheetRow[] = [];
  let truncatedRows = 0;
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const cells: Record<number, string> = {};
    let filled = false;
    ws.getRow(r).eachCell({ includeEmpty: false }, (cell, col) => {
      const t = cellText(cell);
      if (t) {
        cells[col] = t;
        filled = true;
      }
    });
    if (!filled) continue; // completely empty rows are ignored
    if (rows.length >= MAX_TEST_CASES) {
      truncatedRows++;
      continue;
    }
    rows.push({ rowNumber: r, cells });
  }
  return { name: ws.name, headerRow, columns, rows, truncatedRows };
}

/** Turns mapped rows into test cases; rows without a test case/scenario text are skipped. */
export function toCases(sheet: ParsedSheet, mapping: ColumnMapping): ExternalCase[] {
  const get = (row: SheetRow, col: number | undefined) => (col ? (row.cells[col] ?? "").trim() || null : null);
  const out: ExternalCase[] = [];
  for (const row of sheet.rows) {
    const title = get(row, mapping.title) ?? get(row, mapping.scenario);
    const scenario = get(row, mapping.scenario);
    if (!title) continue;
    out.push({
      rowNumber: row.rowNumber,
      caseRef: get(row, mapping.caseId),
      title: scenario && scenario !== title ? `${title} — ${scenario}` : title,
      steps: get(row, mapping.steps),
      expected: get(row, mapping.expected),
      url: get(row, mapping.url),
      testData: get(row, mapping.testData),
      preconditions: get(row, mapping.preconditions),
    });
  }
  return out;
}
