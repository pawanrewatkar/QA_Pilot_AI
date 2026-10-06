import { COMPARABLE_EXTENSIONS, extractReferenceContent } from "@/lib/content/document";
import type { ReferenceLoadResult } from "@/lib/content/types";
import type { SqliteEngineStore } from "@/lib/database/local/engine-store";
import { extensionOf } from "@/lib/documents/validate";
import type { StorageProvider } from "@/lib/storage/provider";

/** Lazily loads and extracts the project's latest reference document once per run. */
export function createReferenceLoader(store: SqliteEngineStore, storage: StorageProvider, projectId: string): () => Promise<ReferenceLoadResult> {
  let cached: Promise<ReferenceLoadResult> | null = null;
  return () => {
    cached ??= (async (): Promise<ReferenceLoadResult> => {
      const doc = store.getReferenceDocument(projectId);
      if (!doc) return { status: "missing" };
      const ext = extensionOf(doc.fileName);
      if (!(COMPARABLE_EXTENSIONS as readonly string[]).includes(ext)) {
        return { status: "unsupported", fileName: doc.fileName, reason: `.${ext} files cannot be compared yet; upload a PDF, DOCX, Markdown or text document.` };
      }
      const bytes = await storage.get(doc.storageKey);
      if (!bytes) return { status: "error", fileName: doc.fileName, reason: "The document file is missing from storage." };
      try {
        const content = await extractReferenceContent({ documentId: doc.id, fileName: doc.fileName, bytes });
        if (!content.blocks.length) return { status: "error", fileName: doc.fileName, reason: "No text could be extracted (the document may be scanned images)." };
        return { status: "ok", content };
      } catch (error) {
        return { status: "error", fileName: doc.fileName, reason: error instanceof Error ? error.message : String(error) };
      }
    })();
    return cached;
  };
}
