import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { updateProjectAction } from "@/app/projects/actions";
import { PageHeader } from "@/components/shared/page-header";
import { ProjectForm } from "@/components/projects/project-form";
import { readEnv } from "@/lib/config/env";
import { requestDb } from "@/lib/server/db";

export const metadata: Metadata = { title: "Edit project" };

export default async function EditProjectPage({ params }: PageProps<"/projects/[id]/edit">) {
  const { id } = await params;
  const db = await requestDb();
  const project = await db.projects.getById(id);
  if (!project) notFound();

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        eyebrow={
          <>
            <Link href="/projects" className="hover:underline">Projects</Link> /{" "}
            <Link href={`/projects/${project.id}`} className="hover:underline">{project.name}</Link>
          </>
        }
        title="Edit project"
      />
      <ProjectForm
        action={updateProjectAction.bind(null, project.id)}
        initialValues={{
          name: project.name,
          websiteUrl: project.websiteUrl,
          description: project.description ?? "",
          figmaUrl: project.figmaUrl ?? "",
          testEmail: project.testEmail ?? "",
        }}
        existingDocument={project.referenceDocument}
        maxUploadMb={readEnv().MAX_UPLOAD_MB}
        submitLabel="Save changes"
        cancelHref={`/projects/${project.id}`}
      />
    </div>
  );
}
