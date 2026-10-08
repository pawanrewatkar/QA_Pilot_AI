"use client";

import { CircleAlert } from "lucide-react";
import Link from "next/link";
import { useActionState } from "react";
import type { ProjectFormState } from "@/app/projects/actions";
import { SubmitButton } from "@/components/shared/submit-button";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { describedBy, Field, Input, Label, Textarea } from "@/components/ui/form-controls";
import { DOCUMENT_ACCEPT_ATTR } from "@/lib/documents/validate";
import { formatBytes } from "@/lib/utils";
import type { DocumentRecord } from "@/types";

interface ProjectFormProps {
  action: (state: ProjectFormState, formData: FormData) => Promise<ProjectFormState>;
  initialValues?: Partial<Record<"name" | "websiteUrl" | "description" | "figmaUrl" | "testEmail", string>>;
  existingDocument?: DocumentRecord | null;
  maxUploadMb: number;
  submitLabel: string;
  cancelHref: string;
}

export function ProjectForm({ action, initialValues = {}, existingDocument, maxUploadMb, submitLabel, cancelHref }: ProjectFormProps) {
  const [state, formAction] = useActionState(action, { errors: {}, values: {} });
  const v = (key: keyof NonNullable<ProjectFormProps["initialValues"]>) => state.values[key] ?? initialValues[key] ?? "";
  const e = state.errors;
  const errorCount = Object.keys(e).length;

  return (
    <form action={formAction} noValidate className="space-y-6">
      {errorCount > 0 ? (
        <Alert variant="destructive">
          <CircleAlert />
          <div>
            <AlertTitle>{e.form ?? "Please fix the highlighted fields."}</AlertTitle>
          </div>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Website</CardTitle>
          <CardDescription>The website this project tests. Only http and https URLs are accepted.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5">
          <Field id="name" label="Project name" required error={e.name}>
            <Input id="name" name="name" defaultValue={v("name")} key={`name-${v("name")}`} maxLength={120} required aria-invalid={!!e.name} aria-describedby={describedBy("name", e.name)} />
          </Field>
          <Field id="websiteUrl" label="Website URL" required error={e.websiteUrl} hint="e.g. https://example.com — https:// is added if omitted.">
            <Input
              id="websiteUrl"
              name="websiteUrl"
              type="url"
              inputMode="url"
              placeholder="https://example.com"
              defaultValue={v("websiteUrl")}
              key={`url-${v("websiteUrl")}`}
              required
              aria-invalid={!!e.websiteUrl}
              aria-describedby={describedBy("websiteUrl", e.websiteUrl, true)}
            />
          </Field>
          <Field id="description" label="Description" error={e.description}>
            <Textarea id="description" name="description" rows={3} maxLength={2000} defaultValue={v("description")} key={`desc-${v("description")}`} aria-invalid={!!e.description} aria-describedby={describedBy("description", e.description)} />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>References &amp; test data</CardTitle>
          <CardDescription>Optional inputs used by Figma, Content, Newsletter and Form testing.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5">
          <Field id="figmaUrl" label="Figma URL" error={e.figmaUrl} hint="A figma.com file or design link. Figma comparison needs a Figma provider; until one is configured it is recorded as NOT EXECUTED.">
            <Input id="figmaUrl" name="figmaUrl" type="url" placeholder="https://www.figma.com/design/…" defaultValue={v("figmaUrl")} key={`figma-${v("figmaUrl")}`} aria-invalid={!!e.figmaUrl} aria-describedby={describedBy("figmaUrl", e.figmaUrl, true)} />
          </Field>
          <Field id="testEmail" label="Test email" error={e.testEmail} hint="A mailbox you control, used when testing newsletter and contact forms.">
            <Input id="testEmail" name="testEmail" type="email" placeholder="qa@yourdomain.com" defaultValue={v("testEmail")} key={`email-${v("testEmail")}`} aria-invalid={!!e.testEmail} aria-describedby={describedBy("testEmail", e.testEmail, true)} />
          </Field>
          <Field
            id="referenceDocument"
            label="Reference document"
            error={e.referenceDocument}
            hint={`Expected content for Content testing (PDF, DOCX, Markdown and text can be compared). PDF, Word, Excel, text, Markdown or CSV, up to ${maxUploadMb} MB.`}
          >
            {existingDocument ? (
              <div className="flex flex-col gap-2 rounded-md border bg-muted/40 p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                <span className="min-w-0 truncate">
                  Current: <span className="font-medium">{existingDocument.fileName}</span>{" "}
                  <span className="text-muted-foreground">({formatBytes(existingDocument.sizeBytes)})</span>
                </span>
                <span className="flex items-center gap-2">
                  <Checkbox id="removeDocument" name="removeDocument" />
                  <Label htmlFor="removeDocument" className="font-normal">Remove</Label>
                </span>
              </div>
            ) : null}
            <Input
              id="referenceDocument"
              name="referenceDocument"
              type="file"
              accept={DOCUMENT_ACCEPT_ATTR}
              aria-invalid={!!e.referenceDocument}
              aria-describedby={describedBy("referenceDocument", e.referenceDocument, true)}
            />
            {existingDocument ? <p className="text-xs text-muted-foreground">Uploading a new file replaces the current document.</p> : null}
          </Field>
        </CardContent>
        <CardFooter className="justify-end">
          <Button variant="outline" asChild>
            <Link href={cancelHref}>Cancel</Link>
          </Button>
          <SubmitButton pendingLabel="Saving…">{submitLabel}</SubmitButton>
        </CardFooter>
      </Card>
    </form>
  );
}
