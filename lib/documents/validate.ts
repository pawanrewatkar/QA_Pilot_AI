/** Reference document types accepted for upload, keyed by lowercase extension. */
export const ALLOWED_DOCUMENT_TYPES: Record<string, { mime: string; signature?: "pdf" | "zip" | "ole" }> = {
  pdf: { mime: "application/pdf", signature: "pdf" },
  docx: { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", signature: "zip" },
  xlsx: { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", signature: "zip" },
  odt: { mime: "application/vnd.oasis.opendocument.text", signature: "zip" },
  doc: { mime: "application/msword", signature: "ole" },
  xls: { mime: "application/vnd.ms-excel", signature: "ole" },
  txt: { mime: "text/plain" },
  md: { mime: "text/markdown" },
  csv: { mime: "text/csv" },
  rtf: { mime: "application/rtf" },
};

export const DOCUMENT_ACCEPT_ATTR = Object.keys(ALLOWED_DOCUMENT_TYPES)
  .map((ext) => `.${ext}`)
  .join(",");

export function extensionOf(fileName: string): string {
  const match = /\.([A-Za-z0-9]+)$/.exec(fileName);
  return match ? match[1].toLowerCase() : "";
}

/** Strips path components and control characters; keeps a readable, bounded file name. */
export function sanitizeFileName(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f"<>|:*?]/g, "").trim();
  return (cleaned || "document").slice(0, 200);
}

function matchesSignature(bytes: Uint8Array, signature: "pdf" | "zip" | "ole"): boolean {
  const starts = (sig: number[]) => sig.every((b, i) => bytes[i] === b);
  switch (signature) {
    case "pdf":
      return starts([0x25, 0x50, 0x44, 0x46]); // %PDF
    case "zip":
      return starts([0x50, 0x4b, 0x03, 0x04]); // PK..
    case "ole":
      return starts([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  }
}

export type DocumentValidation = { ok: true; mimeType: string; fileName: string } | { ok: false; error: string };

/** Validates an uploaded reference document by extension, size and (where possible) file signature. */
export function validateDocument(fileName: string, bytes: Uint8Array, maxBytes: number): DocumentValidation {
  const name = sanitizeFileName(fileName);
  const ext = extensionOf(name);
  const type = ALLOWED_DOCUMENT_TYPES[ext];
  if (!type) {
    return { ok: false, error: `Unsupported file type. Allowed: ${Object.keys(ALLOWED_DOCUMENT_TYPES).join(", ")}.` };
  }
  if (bytes.byteLength === 0) return { ok: false, error: "The uploaded file is empty." };
  if (bytes.byteLength > maxBytes) {
    return { ok: false, error: `File is too large. Maximum size is ${Math.round(maxBytes / 1024 / 1024)} MB.` };
  }
  if (type.signature && !matchesSignature(bytes, type.signature)) {
    return { ok: false, error: `File content does not match the .${ext} format.` };
  }
  return { ok: true, mimeType: type.mime, fileName: name };
}
