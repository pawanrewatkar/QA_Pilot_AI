import { createHash, randomUUID } from "node:crypto";
import type { DatabaseProvider } from "@/lib/database/provider";
import { extensionOf, validateDocument } from "@/lib/documents/validate";
import type { StorageProvider } from "@/lib/storage/provider";
import { parseProjectInput, type ProjectFieldErrors } from "@/lib/validation/project";
import type { DocumentRecord, Project } from "@/types";

/**
 * Project use-cases. Takes providers as arguments so the same logic runs in server
 * actions, the worker and tests.
 */
export interface ProjectServiceDeps {
  db: DatabaseProvider;
  storage: StorageProvider;
  maxUploadBytes: number;
}

export interface UploadedFile {
  name: string;
  bytes: Uint8Array;
}

export type ProjectMutationResult = { ok: true; project: Project } | { ok: false; errors: ProjectFieldErrors };

const projectStoragePrefix = (projectId: string) => `projects/${projectId}`;

async function storeReferenceDocument(deps: ProjectServiceDeps, projectId: string, file: UploadedFile): Promise<DocumentRecord> {
  const check = validateDocument(file.name, file.bytes, deps.maxUploadBytes);
  if (!check.ok) throw new Error(check.error);
  const key = `${projectStoragePrefix(projectId)}/documents/${randomUUID()}.${extensionOf(check.fileName)}`;
  await deps.storage.put(key, file.bytes, { contentType: check.mimeType });
  try {
    return await deps.db.documents.create({
      projectId,
      kind: "REFERENCE",
      fileName: check.fileName,
      mimeType: check.mimeType,
      sizeBytes: file.bytes.byteLength,
      storageKey: key,
      checksumSha256: createHash("sha256").update(file.bytes).digest("hex"),
    });
  } catch (error) {
    await deps.storage.delete(key);
    throw error;
  }
}

async function removeDocuments(deps: ProjectServiceDeps, docs: DocumentRecord[]): Promise<void> {
  for (const doc of docs) {
    await deps.db.documents.delete(doc.id);
    await deps.storage.delete(doc.storageKey);
  }
}

function validateUpload(deps: ProjectServiceDeps, file: UploadedFile | null): ProjectFieldErrors | null {
  if (!file) return null;
  const check = validateDocument(file.name, file.bytes, deps.maxUploadBytes);
  return check.ok ? null : { referenceDocument: check.error };
}

export async function createProject(
  deps: ProjectServiceDeps,
  raw: Record<string, unknown>,
  file: UploadedFile | null,
): Promise<ProjectMutationResult> {
  const parsed = parseProjectInput(raw);
  const uploadErrors = validateUpload(deps, file);
  if (!parsed.ok || uploadErrors) {
    return { ok: false, errors: { ...(parsed.ok ? {} : parsed.errors), ...uploadErrors } };
  }

  const project = await deps.db.projects.create(parsed.data);
  if (file) {
    try {
      await storeReferenceDocument(deps, project.id, file);
    } catch (error) {
      // Keep create atomic from the user's point of view.
      await deps.db.projects.delete(project.id);
      await deps.storage.deletePrefix(projectStoragePrefix(project.id));
      return { ok: false, errors: { referenceDocument: error instanceof Error ? error.message : "Upload failed." } };
    }
  }

  await deps.db.activity.record({
    projectId: project.id,
    entityType: "project",
    entityId: project.id,
    action: "created",
    summary: `Project "${project.name}" created for ${project.websiteUrl}`,
  });
  return { ok: true, project };
}

export async function updateProject(
  deps: ProjectServiceDeps,
  id: string,
  raw: Record<string, unknown>,
  options: { file: UploadedFile | null; removeDocument: boolean },
): Promise<ProjectMutationResult> {
  const existing = await deps.db.projects.getById(id);
  if (!existing) return { ok: false, errors: { form: "Project not found. It may have been deleted." } };

  const parsed = parseProjectInput(raw);
  const uploadErrors = validateUpload(deps, options.file);
  if (!parsed.ok || uploadErrors) {
    return { ok: false, errors: { ...(parsed.ok ? {} : parsed.errors), ...uploadErrors } };
  }

  const project = await deps.db.projects.update(id, parsed.data);
  if (!project) return { ok: false, errors: { form: "Project not found. It may have been deleted." } };

  const previousDocs = (await deps.db.documents.listByProject(id)).filter((d) => d.kind === "REFERENCE");
  if (options.file) {
    try {
      await storeReferenceDocument(deps, id, options.file);
    } catch (error) {
      return { ok: false, errors: { referenceDocument: error instanceof Error ? error.message : "Upload failed." } };
    }
    await removeDocuments(deps, previousDocs);
  } else if (options.removeDocument) {
    await removeDocuments(deps, previousDocs);
  }

  await deps.db.activity.record({
    projectId: id,
    entityType: "project",
    entityId: id,
    action: "updated",
    summary: `Project "${project.name}" updated`,
  });
  return { ok: true, project };
}

export async function deleteProject(deps: ProjectServiceDeps, id: string): Promise<boolean> {
  const existing = await deps.db.projects.getById(id);
  if (!existing) return false;
  const deleted = await deps.db.projects.delete(id);
  if (!deleted) return false;
  await deps.storage.deletePrefix(projectStoragePrefix(id));
  await deps.db.activity.record({
    projectId: null,
    entityType: "project",
    entityId: id,
    action: "deleted",
    summary: `Project "${existing.name}" deleted with all of its data`,
  });
  return true;
}
