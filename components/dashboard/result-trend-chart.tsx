"use client";

import { useState } from "react";
import type { ResultTrendPoint } from "@/types";

/** Reserved status colors: never reused for categorical series; always paired with a text label. */
const SERIES = [
  { key: "passed", label: "Passed", color: "#0ca30c" },
  { key: "warnings", label: "Warnings", color: "#fab219" },
  { key: "failed", label: "Failed", color: "#d03b3b" },
] as const;

const CHART_HEIGHT = 160;
const GAP_PX = 2;

function shortDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" });
}

export function ResultTrendChart({ points }: { points: ResultTrendPoint[] }) {
  const [active, setActive] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);
  const max = Math.max(1, ...points.map((p) => p.passed + p.failed + p.warnings));
  const activePoint = active === null ? null : points[active];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ul className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground" aria-label="Legend">
          {SERIES.map((s) => (
            <li key={s.key} className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-sm" style={{ background: s.color }} aria-hidden />
              {s.label}
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={() => setShowTable((v) => !v)}
          className="text-xs font-medium text-primary hover:underline"
          aria-expanded={showTable}
        >
          {showTable ? "Show chart" : "Show as table"}
        </button>
      </div>

      {showTable ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Executed results per day</caption>
            <thead className="text-xs text-muted-foreground">
              <tr className="border-b">
                <th scope="col" className="py-2 text-left font-medium">Day (UTC)</th>
                {SERIES.map((s) => (
                  <th key={s.key} scope="col" className="py-2 text-right font-medium">{s.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.day} className="border-b last:border-0">
                  <td className="py-1.5">{p.day}</td>
                  {SERIES.map((s) => (
                    <td key={s.key} className="py-1.5 text-right tabular-nums">{p[s.key]}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="relative">
          <div className="pointer-events-none absolute inset-x-0 top-0 border-t border-dashed border-border" aria-hidden />
          <div className="pointer-events-none absolute right-0 -top-4 text-[10px] text-muted-foreground tabular-nums" aria-hidden>
            {max}
          </div>
          <div
            className="flex items-end gap-1 border-b border-border"
            style={{ height: CHART_HEIGHT }}
            role="group"
            aria-label={`Stacked bars of passed, warning and failed results across ${points.length} days. Use "Show as table" for exact values.`}
            onMouseLeave={() => setActive(null)}
          >
            {points.map((p, i) => {
              const segments = SERIES.filter((s) => p[s.key] > 0);
              return (
                <button
                  key={p.day}
                  type="button"
                  className="group flex h-full min-w-0 flex-1 flex-col justify-end rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onMouseEnter={() => setActive(i)}
                  onFocus={() => setActive(i)}
                  onBlur={() => setActive(null)}
                  aria-label={`${p.day}: ${p.passed} passed, ${p.warnings} warnings, ${p.failed} failed`}
                >
                  {/* Rendered top-down: last series sits on top; PASS anchors the baseline. */}
                  {[...segments].reverse().map((s, idx) => {
                    const height = (p[s.key] / max) * CHART_HEIGHT;
                    return (
                      <span
                        key={s.key}
                        className="mx-auto block w-full max-w-7 transition-opacity group-hover:opacity-90"
                        style={{
                          height: Math.max(2, height - (idx < segments.length - 1 ? GAP_PX : 0)),
                          marginBottom: idx < segments.length - 1 ? GAP_PX : 0,
                          background: s.color,
                          borderTopLeftRadius: idx === 0 ? 4 : 0,
                          borderTopRightRadius: idx === 0 ? 4 : 0,
                          opacity: active === null || active === i ? 1 : 0.45,
                        }}
                      />
                    );
                  })}
                </button>
              );
            })}
          </div>
          <div className="mt-1 flex justify-between text-[10px] text-muted-foreground" aria-hidden>
            <span>{points.length ? shortDay(points[0].day) : ""}</span>
            <span>{points.length > 1 ? shortDay(points[points.length - 1].day) : ""}</span>
          </div>
          {activePoint ? (
            <div className="pointer-events-none absolute top-2 left-2 rounded-md border bg-popover px-3 py-2 text-xs shadow-md" role="status">
              <p className="mb-1 font-medium text-foreground">{shortDay(activePoint.day)}</p>
              {SERIES.map((s) => (
                <p key={s.key} className="flex items-center gap-2 text-muted-foreground">
                  <span className="size-2 rounded-sm" style={{ background: s.color }} aria-hidden />
                  {s.label}
                  <span className="ml-auto pl-3 font-medium text-foreground tabular-nums">{activePoint[s.key]}</span>
                </p>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
