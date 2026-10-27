import type { Metadata } from "next";
import Link from "next/link";
import { createProjectAction } from "@/app/projects/actions";
import { PageHeader } from "@/components/shared/page-header";
import { ProjectForm } from "@/components/projects/project-form";
import { readEnv } from "@/lib/config/env";
import { requestDb } from "@/lib/server/db";

export const metadata: Metadata = { title: "New project" };

export default async function NewProjectPage() {
  // Same identity check as every other page (redirects without one); also renders at request time so
  // MAX_UPLOAD_MB is read then, not at build time.
  await requestDb();
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        eyebrow={<Link href="/projects" className="hover:underline">Projects</Link>}
        title="New project"
        description="Add the website you want to test. Nothing is crawled or tested until you run a configuration."
      />
      <ProjectForm action={createProjectAction} maxUploadMb={readEnv().MAX_UPLOAD_MB} submitLabel="Create project" cancelHref="/projects" />
    </div>
  );
}
