import type ExcelJS from "exceljs";
import { websiteSlug } from "@/lib/reports/data";
import { HEADER_FILL, STATUS_FILL } from "@/lib/reports/excel";
import { planResultColumns } from "./result-columns";
import { cellText, loadWorkbook, WorkbookError } from "./workbook";
import type { ExternalStatus, OutputMode, ResultColumnSet, SheetColumn } from "./types";

export interface RowResult {
  rowNumber: number;
  status: ExternalStatus;
  actual: string;
  executedAt: Date;
}

export interface WriteOptions {
  sheetName: string;
  headerRow: number;
  mode: OutputMode;
  results: RowResult[];
  /** Columns mapped as test-case inputs; never used as result columns. */
  mappedColumns?: number[];
}

const fill = (argb: string): ExcelJS.Fill => ({ type: "pattern", pattern: "solid", fgColor: { argb } });
/** Excel worksheet names: at most 31 characters, none of []:*?/\ */
const sheetTitle = (s: string) => s.replace(/[[\]:*?/\\]/g, " ").trim().slice(0, 31) || "Results";

function uniqueSheetName(wb: ExcelJS.Workbook, base: string): string {
  const names = new Set(wb.worksheets.map((w) => w.name.toLowerCase()));
  let name = sheetTitle(base);
  for (let i = 2; names.has(name.toLowerCase()); i++) name = sheetTitle(`${base.slice(0, 26)} (${i})`);
  return name;
}

function headerColumns(ws: ExcelJS.Worksheet, headerRow: number): SheetColumn[] {
  const columns: SheetColumn[] = [];
  ws.getRow(headerRow).eachCell({ includeEmpty: false }, (cell, col) => {
    const header = cellText(cell);
    if (header) columns.push({ index: col, header });
  });
  return columns;
}

function columnHasData(ws: ExcelJS.Worksheet, headerRow: number, col: number): boolean {
  for (let r = headerRow + 1; r <= ws.rowCount; r++) if (cellText(ws.getRow(r).getCell(col))) return true;
  return false;
}

/** Copies a worksheet's cells (values and styles), column widths, merges, frozen panes and filter into a new sheet. */
function copySheet(wb: ExcelJS.Workbook, src: ExcelJS.Worksheet, name: string): ExcelJS.Worksheet {
  const dst = wb.addWorksheet(name, { views: src.views?.length ? structuredClone(src.views) : undefined });
  src.columns?.forEach((col, i) => {
    if (col?.width) dst.getColumn(i + 1).width = col.width;
  });
  src.eachRow({ includeEmpty: true }, (row, r) => {
    const out = dst.getRow(r);
    if (row.height) out.height = row.height;
    row.eachCell({ includeEmpty: true }, (cell, c) => {
      const target = out.getCell(c);
      target.value = cell.value;
      target.style = structuredClone(cell.style);
    });
  });
  for (const range of (src.model as { merges?: string[] }).merges ?? []) dst.mergeCells(range);
  if (src.autoFilter) dst.autoFilter = structuredClone(src.autoFilter);
  return dst;
}

/**
 * Writes one execution's results into a copy of the source workbook. The uploaded original is never
 * modified. EXISTING_SHEET adds the results to the selected sheet; NEW_SHEET leaves it untouched and writes
 * a copy of it (all original columns) plus the results to a new sheet. Earlier results are never overwritten.
 */
export async function writeResults(sourceBytes: Uint8Array, options: WriteOptions): Promise<{ bytes: Uint8Array; sheet: string; columns: ResultColumnSet }> {
  const wb = await loadWorkbook(sourceBytes);
  const source = wb.getWorksheet(options.sheetName);
  if (!source) throw new WorkbookError(`Worksheet "${options.sheetName}" no longer exists in the source workbook.`);
  const ws = options.mode === "NEW_SHEET" ? copySheet(wb, source, uniqueSheetName(wb, `${source.name} Results`)) : source;

  const columns = headerColumns(ws, options.headerRow);
  const plan = planResultColumns(columns, (c) => columnHasData(ws, options.headerRow, c), ws.columnCount, new Set(options.mappedColumns ?? []));

  // New headers copy the style of the last existing header cell so the sheet keeps its look.
  const lastHeader = columns.length ? ws.getRow(options.headerRow).getCell(columns[columns.length - 1].index) : null;
  const headerStyle: Partial<ExcelJS.Style> = lastHeader && Object.keys(lastHeader.style ?? {}).length
    ? structuredClone(lastHeader.style)
    : { font: { bold: true, color: { argb: "FFFFFFFF" } }, fill: fill(HEADER_FILL), alignment: { vertical: "middle", wrapText: true } };
  const widths = { actual: 60, status: 20, date: 14 };
  for (const key of ["actual", "status", "date"] as const) {
    const target = plan[key];
    const cell = ws.getRow(options.headerRow).getCell(target.index);
    if (!target.exists) {
      cell.value = target.header;
      cell.style = structuredClone(headerStyle);
      ws.getColumn(target.index).width = widths[key];
    }
  }

  for (const r of options.results) {
    const row = ws.getRow(r.rowNumber);
    const actual = row.getCell(plan.actual.index);
    const status = row.getCell(plan.status.index);
    const date = row.getCell(plan.date.index);
    actual.value = r.actual;
    actual.alignment = { vertical: "top", wrapText: true };
    status.value = r.status;
    status.font = { bold: true };
    status.alignment = { vertical: "top" };
    const statusFill = STATUS_FILL[r.status];
    if (statusFill) status.fill = fill(statusFill);
    // Cases that need a person: the Actual Result cell is highlighted yellow as well.
    if (r.status === "HUMAN INTERACTION") actual.fill = fill(STATUS_FILL["HUMAN INTERACTION"]);
    date.value = new Date(Date.UTC(r.executedAt.getUTCFullYear(), r.executedAt.getUTCMonth(), r.executedAt.getUTCDate()));
    date.numFmt = "yyyy-mm-dd";
    date.alignment = { vertical: "top" };
    row.commit();
  }

  return { bytes: new Uint8Array(await wb.xlsx.writeBuffer()), sheet: ws.name, columns: plan };
}

export function externalResultFileName(websiteUrl: string, date: Date): string {
  return `QA_External_Test_Result_${websiteSlug(websiteUrl)}_${date.toISOString().slice(0, 10)}.xlsx`;
}
