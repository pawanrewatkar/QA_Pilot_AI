import type { DatabaseProvider } from "@/lib/database/provider";
import { parseTestConfiguration, type TestConfigFieldErrors } from "@/lib/validation/test-config";
import type { TestConfiguration } from "@/types";

export type SaveConfigurationResult =
  | { ok: true; configuration: TestConfiguration }
  | { ok: false; errors: TestConfigFieldErrors };

/** Validates and saves (creates or updates) a test configuration for a project. */
export async function saveTestConfiguration(
  db: DatabaseProvider,
  projectId: string,
  configurationId: string | null,
  raw: unknown,
): Promise<SaveConfigurationResult> {
  const project = await db.projects.getById(projectId);
  if (!project) return { ok: false, errors: { form: "Project not found." } };

  const pages = await db.pages.list({ projectId, limit: 500 });
  const parsed = parseTestConfiguration(raw, project, new Set(pages.map((p) => p.id)));
  if (!parsed.ok) return parsed;

  let configuration: TestConfiguration | null;
  if (configurationId) {
    configuration = await db.testConfigurations.update(configurationId, parsed.data);
    if (!configuration) return { ok: false, errors: { form: "Configuration not found." } };
  } else {
    configuration = await db.testConfigurations.create(parsed.data);
  }

  await db.activity.record({
    projectId,
    entityType: "test_configuration",
    entityId: configuration.id,
    action: configurationId ? "updated" : "created",
    summary: `Test configuration "${configuration.name}" ${configurationId ? "updated" : "saved"} (${configuration.modules.length} modules, ${configuration.browsers.length} browsers, ${configuration.viewports.length} viewports)`,
  });
  return { ok: true, configuration };
}

export async function deleteTestConfiguration(db: DatabaseProvider, projectId: string, configurationId: string): Promise<boolean> {
  const existing = await db.testConfigurations.getById(configurationId);
  if (!existing || existing.projectId !== projectId) return false;
  await db.testConfigurations.delete(configurationId);
  await db.activity.record({
    projectId,
    entityType: "test_configuration",
    entityId: configurationId,
    action: "deleted",
    summary: `Test configuration "${existing.name}" deleted`,
  });
  return true;
}
