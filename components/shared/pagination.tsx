import Link from "next/link";
import { Button } from "@/components/ui/button";

/** Previous/next pagination for GET-filtered list pages. Keeps every other query parameter. */
export function Pagination({ basePath, params, page, pageSize, total }: { basePath: string; params: Record<string, string | undefined>; page: number; pageSize: number; total: number }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  const href = (p: number) => {
    const s = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) s.set(k, v);
    if (p > 1) s.set("page", String(p));
    const q = s.toString();
    return q ? `${basePath}?${q}` : basePath;
  };
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-2 text-sm">
      <span className="text-muted-foreground">
        {from}–{to} of {total} · page {page} of {pages}
      </span>
      <div className="flex gap-2">
        {page > 1 ? (
          <Button variant="outline" size="sm" asChild>
            <Link href={href(page - 1)} rel="prev">Previous</Link>
          </Button>
        ) : (
          <Button variant="outline" size="sm" disabled>Previous</Button>
        )}
        {page < pages ? (
          <Button variant="outline" size="sm" asChild>
            <Link href={href(page + 1)} rel="next">Next</Link>
          </Button>
        ) : (
          <Button variant="outline" size="sm" disabled>Next</Button>
        )}
      </div>
    </nav>
  );
}

export function readPage(value: string | string[] | undefined): number {
  const v = Number(Array.isArray(value) ? value[0] : value);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 1;
}
