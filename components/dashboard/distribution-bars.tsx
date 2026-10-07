import { formatNumber } from "@/lib/utils";

export interface DistributionItem {
  label: string;
  value: number;
  color: string;
  href?: string;
}

/**
 * Horizontal bars for a categorical count (e.g. bug severity, result status). Server-rendered,
 * drawn only from the counts passed in; each bar carries its label and value as text.
 */
export function DistributionBars({ items, caption }: { items: DistributionItem[]; caption: string }) {
  const total = items.reduce((a, i) => a + i.value, 0);
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <figure className="space-y-2">
      <figcaption className="sr-only">{caption}</figcaption>
      <ul className="space-y-2">
        {items.map((i) => {
          const pct = total ? Math.round((i.value / total) * 100) : 0;
          const label = (
            <span className="flex items-center justify-between gap-2 text-sm">
              <span>{i.label}</span>
              <span className="tabular-nums text-muted-foreground">
                {formatNumber(i.value)}
                {total ? ` · ${pct}%` : ""}
              </span>
            </span>
          );
          return (
            <li key={i.label} className="space-y-1">
              {i.href ? (
                <a href={i.href} className="block hover:underline">
                  {label}
                </a>
              ) : (
                label
              )}
              <div className="h-2 overflow-hidden rounded-full bg-muted" aria-hidden>
                <div className="h-full rounded-full" style={{ width: `${(i.value / max) * 100}%`, background: i.color }} />
              </div>
            </li>
          );
        })}
      </ul>
    </figure>
  );
}
