import Link from "next/link";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Rows per page offered on every paginated list; the first is the default. */
export const PAGE_SIZES = [10, 20, 50] as const;
export const DEFAULT_PAGE_SIZE = PAGE_SIZES[0];

/**
 * Previous/next pagination with a rows-per-page choice (10, 20, 50) for GET-filtered list pages. Keeps every other
 * query parameter; the page size travels as `size` (omitted when it is the default) and changing it returns to page 1.
 */
export function Pagination({ basePath, params, page, pageSize, total }: { basePath: string; params: Record<string, string | undefined>; page: number; pageSize: number; total: number }) {
  if (total <= DEFAULT_PAGE_SIZE) return null;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const href = (p: number, size = pageSize) => {
    const s = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) s.set(k, v);
    if (size !== DEFAULT_PAGE_SIZE) s.set("size", String(size));
    if (p > 1) s.set("page", String(p));
    const q = s.toString();
    return q ? `${basePath}?${q}` : basePath;
  };
  const current = Math.min(page, pages);
  const from = (current - 1) * pageSize + 1;
  const to = Math.min(total, current * pageSize);
  return (
    <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-2 px-1 text-sm">
      <span className="text-muted-foreground">
        {from}–{to} of {total} · page {current} of {pages}
      </span>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1" role="group" aria-label="Results per page">
          <span className="mr-1 text-muted-foreground">Per page</span>
          {PAGE_SIZES.map((size) => (
            <Link
              key={size}
              href={href(1, size)}
              aria-current={size === pageSize ? "true" : undefined}
              className={cn("rounded-md border px-2 py-0.5 text-xs", size === pageSize ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted")}
            >
              {size}
            </Link>
          ))}
        </div>
        <div className="flex gap-2">
          {current > 1 ? (
            <Button variant="outline" size="sm" asChild>
              <Link href={href(current - 1)} rel="prev">Previous</Link>
            </Button>
          ) : (
            <Button variant="outline" size="sm" disabled>Previous</Button>
          )}
          {current < pages ? (
            <Button variant="outline" size="sm" asChild>
              <Link href={href(current + 1)} rel="next">Next</Link>
            </Button>
          ) : (
            <Button variant="outline" size="sm" disabled>Next</Button>
          )}
        </div>
      </div>
    </nav>
  );
}

export function readPage(value: string | string[] | undefined): number {
  const v = Number(Array.isArray(value) ? value[0] : value);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 1;
}

/** Rows per page from the `size` query parameter: one of PAGE_SIZES, otherwise the default (10). */
export function readPageSize(value: string | string[] | undefined): number {
  const v = Number(Array.isArray(value) ? value[0] : value);
  return (PAGE_SIZES as readonly number[]).includes(v) ? v : DEFAULT_PAGE_SIZE;
}
