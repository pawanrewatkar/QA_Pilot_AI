import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Label, NativeSelect } from "@/components/ui/form-controls";

/** GET form that scopes a list page to one project. Works without JavaScript. */
export function ProjectFilter({
  projects,
  selected,
  basePath,
}: {
  projects: { id: string; name: string }[];
  selected: string | undefined;
  basePath: string;
}) {
  if (projects.length === 0) return null;
  return (
    <form method="get" className="flex flex-wrap items-end gap-2 rounded-xl border bg-card p-4">
      <div className="grid min-w-56 flex-1 gap-1.5 sm:flex-none">
        <Label htmlFor="project">Project</Label>
        <NativeSelect id="project" name="project" defaultValue={selected ?? ""}>
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </NativeSelect>
      </div>
      <Button type="submit" variant="secondary">Apply</Button>
      {selected ? (
        <Button variant="ghost" asChild>
          <Link href={basePath}>Reset</Link>
        </Button>
      ) : null}
    </form>
  );
}

export function readProjectParam(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v && v.length <= 64 ? v : undefined;
}
