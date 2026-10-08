import { Trash2 } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { deleteConfigurationAction, saveConfigurationAction } from "@/app/projects/actions";
import { PageHeader } from "@/components/shared/page-header";
import { SubmitButton } from "@/components/shared/submit-button";
import { TestConfigurationForm } from "@/components/test-config/test-configuration-form";
import { requestDb } from "@/lib/server/db";

export const metadata: Metadata = { title: "Test configuration" };

export default async function ConfigurePage({ params, searchParams }: PageProps<"/projects/[id]/configure">) {
  const { id } = await params;
  const { config } = await searchParams;
  const configId = Array.isArray(config) ? config[0] : config;

  const db = await requestDb();
  const project = await db.projects.getById(id);
  if (!project) notFound();

  const initial = configId ? await db.testConfigurations.getById(configId) : null;
  if (configId && (!initial || initial.projectId !== id)) notFound();

  const pages = await db.pages.list({ projectId: id, limit: 500 });

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <>
            <Link href="/projects" className="hover:underline">Projects</Link> /{" "}
            <Link href={`/projects/${id}`} className="hover:underline">{project.name}</Link>
          </>
        }
        title={initial ? `Edit configuration: ${initial.name}` : "New test configuration"}
        description="Choose what to test and how. Saving a configuration does not run any tests."
        actions={
          initial ? (
            <form action={deleteConfigurationAction}>
              <input type="hidden" name="projectId" value={id} />
              <input type="hidden" name="configurationId" value={initial.id} />
              <SubmitButton variant="outline" className="text-destructive-text hover:text-destructive" pendingLabel="Deleting…">
                <Trash2 /> Delete configuration
              </SubmitButton>
            </form>
          ) : null
        }
      />
      <TestConfigurationForm
        key={initial?.id ?? "new"}
        project={{
          id,
          websiteUrl: project.websiteUrl,
          available: {
            figmaUrl: project.figmaUrl !== null,
            referenceDocument: project.referenceDocument !== null,
            testEmail: project.testEmail !== null,
            testCredentials: false,
          },
        }}
        pages={pages.map((p) => ({ id: p.id, url: p.url, title: p.title }))}
        initial={initial}
        action={saveConfigurationAction.bind(null, id)}
      />
    </div>
  );
}
