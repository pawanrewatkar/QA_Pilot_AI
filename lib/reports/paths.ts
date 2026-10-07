/** Storage prefix holding every file of one report bundle. */
export const bundlePrefix = (bundleId: string) => `reports/${bundleId}`;

export const REPORT_KIND_LABELS = {
  PDF: "PDF",
  HTML: "HTML",
  TESTING_EXCEL: "Testing Excel",
  BUG_EXCEL: "Bug Excel",
} as const;

export const REPORT_CONTENT_TYPES: Record<keyof typeof REPORT_KIND_LABELS, string> = {
  PDF: "application/pdf",
  HTML: "text/html; charset=utf-8",
  TESTING_EXCEL: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  BUG_EXCEL: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
