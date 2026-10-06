"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Polls a JSON endpoint while `active` is true. Polling pauses while the tab is hidden and
 * stops on its own once `isDone(data)` returns true.
 */
export function usePolling<T>(url: string, options: { initial: T; intervalMs?: number; active: boolean; isDone?: (data: T) => boolean }) {
  const [data, setData] = useState<T>(options.initial);
  const [error, setError] = useState<string | null>(null);
  const isDoneRef = useRef(options.isDone);
  useEffect(() => {
    isDoneRef.current = options.isDone;
  });

  useEffect(() => {
    if (!options.active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (document.visibilityState === "visible") {
        try {
          const res = await fetch(url, { cache: "no-store" });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const next = (await res.json()) as T;
          if (cancelled) return;
          setData(next);
          setError(null);
          if (isDoneRef.current?.(next)) return;
        } catch (e) {
          if (!cancelled) setError(e instanceof Error ? e.message : "Request failed");
        }
      }
      if (!cancelled) timer = setTimeout(tick, options.intervalMs ?? 1500);
    };
    timer = setTimeout(tick, options.intervalMs ?? 1500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [url, options.active, options.intervalMs]);

  return { data, error };
}
