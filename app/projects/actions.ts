"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { readEnv } from "@/lib/config/env";
import { getDatabase } from "@/lib/database";
import { createProject, deleteProject, updateProject, type ProjectServiceDeps, type UploadedFile } from "@/lib/services/projects";
import { deleteTestConfiguration, saveTestConfiguration } from "@/lib/services/test-configurations";
import { getStorage } from "@/lib/storage";
import type { ProjectFieldErrors } from "@/lib/validation/project";
import type { TestConfigFieldErrors } from "@/lib/validation/test-config";

// NOTE: QA Pilot AI has no authentication in this local-first phase. Before deploying
// to a shared environment, add an auth check at the top of every action below.

export interface ProjectFormState {
  errors: ProjectFieldErrors;
  values: Record<string, string>;
}

const PROJECT_FIELDS = ["name", "websiteUrl", "description", "figmaUrl", "testEmail"] as const;

function deps(): ProjectServiceDeps {
  return { db: getDatabase(), storage: getStorage(), maxUploadBytes: readEnv().MAX_UPLOAD_MB * 1024 * 1024 };
}

function readProjectFields(formData: FormData): Record<string, string> {
  return Object.fromEntries(PROJECT_FIELDS.map((f) => [f, String(formData.get(f) ?? "")]));
}

async function readUpload(formData: FormData): Promise<UploadedFile | null> {
  const file = formData.get("referenceDocument");
  if (!(file instanceof File) || file.size === 0 || !file.name) return null;
  return { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
}

function revalidateProjectViews(id?: string) {
  revalidatePath("/");
  revalidatePath("/projects");
  revalidatePath("/history");
  if (id) revalidatePath(`/projects/${id}`);
}

export async function createProjectAction(_prev: ProjectFormState, formData: FormData): Promise<ProjectFormState> {
  const values = readProjectFields(formData);
  const result = await createProject(deps(), values, await readUpload(formData));
  if (!result.ok) return { errors: result.errors, values };
  revalidateProjectViews(result.project.id);
  redirect(`/projects/${result.project.id}?created=1`);
}

export async function updateProjectAction(id: string, _prev: ProjectFormState, formData: FormData): Promise<ProjectFormState> {
  const values = readProjectFields(formData);
  const result = await updateProject(deps(), id, values, {
    file: await readUpload(formData),
    removeDocument: formData.get("removeDocument") === "on",
  });
  if (!result.ok) return { errors: result.errors, values };
  revalidateProjectViews(id);
  redirect(`/projects/${id}?updated=1`);
}

export async function deleteProjectAction(formData: FormData): Promise<void> {
  const id = String(formData.get("projectId") ?? "");
  if (id) await deleteProject(deps(), id);
  revalidateProjectViews();
  redirect("/projects?deleted=1");
}

export interface ConfigurationFormState {
  errors: TestConfigFieldErrors;
  savedAt: string | null;
  configurationId: string | null;
}

export async function saveConfigurationAction(
  projectId: string,
  prev: ConfigurationFormState,
  payload: unknown,
): Promise<ConfigurationFormState> {
  const result = await saveTestConfiguration(getDatabase(), projectId, prev.configurationId, payload);
  if (!result.ok) return { ...prev, errors: result.errors, savedAt: null };
  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/history");
  return { errors: {}, savedAt: result.configuration.updatedAt, configurationId: result.configuration.id };
}

export async function deleteConfigurationAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const configurationId = String(formData.get("configurationId") ?? "");
  if (projectId && configurationId) await deleteTestConfiguration(getDatabase(), projectId, configurationId);
  revalidatePath(`/projects/${projectId}`);
  redirect(`/projects/${projectId}`);
}
