import { z } from "zod";
import { parseFigmaUrl } from "@/lib/figma/provider";
import type { ProjectInput } from "@/types";
import { normalizeWebsiteUrl } from "./url";

const optionalText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, `${label} must be at most ${max} characters.`)
    .transform((v) => (v === "" ? null : v));

export const projectInputSchema = z.object({
  name: z.string().trim().min(1, "Project name is required.").max(120, "Project name must be at most 120 characters."),
  websiteUrl: z.string().transform((value, ctx) => {
    const result = normalizeWebsiteUrl(value);
    if (!result.ok) {
      ctx.addIssue({ code: "custom", message: result.error });
      return z.NEVER;
    }
    return result.url;
  }),
  description: optionalText(2000, "Description"),
  figmaUrl: optionalText(2048, "Figma URL").refine((v) => v === null || parseFigmaUrl(v) !== null, {
    message: "Enter a figma.com file or design URL, e.g. https://www.figma.com/design/<key>/<name>.",
  }),
  testEmail: optionalText(254, "Test email").refine((v) => v === null || z.email().safeParse(v).success, {
    message: "Enter a valid email address.",
  }),
}) satisfies z.ZodType<ProjectInput, unknown>;

export type ProjectFieldErrors = Partial<Record<keyof ProjectInput | "referenceDocument" | "form", string>>;

export function parseProjectInput(raw: Record<string, unknown>):
  | { ok: true; data: ProjectInput }
  | { ok: false; errors: ProjectFieldErrors } {
  const result = projectInputSchema.safeParse({
    name: raw.name ?? "",
    websiteUrl: raw.websiteUrl ?? "",
    description: raw.description ?? "",
    figmaUrl: raw.figmaUrl ?? "",
    testEmail: raw.testEmail ?? "",
  });
  if (result.success) return { ok: true, data: result.data };
  const errors: ProjectFieldErrors = {};
  for (const issue of result.error.issues) {
    const key = issue.path[0] as keyof ProjectFieldErrors;
    errors[key] ??= issue.message;
  }
  return { ok: false, errors };
}
