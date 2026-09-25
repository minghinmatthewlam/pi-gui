import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A pane width the user dragged, remembered in this browser profile. `undefined`
 * means the user has not chosen one (or reset it), so the pane keeps its default.
 */
export function usePersistedPaneWidth(
  storageKey: string,
  range: { readonly min: number; readonly max: number },
) {
  const [width, setWidth] = useState<number | undefined>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      const saved = raw === null ? Number.NaN : Number(raw);
      if (Number.isFinite(saved) && saved >= range.min && saved <= range.max) return saved;
    } catch {
      // The layout remains usable when local preference storage is unavailable.
    }
    return undefined;
  });

  // The latest width not yet written; flushed on a timer, on page hide and on unmount
  // (collapsing the sidebar or opening Settings right after a drag must keep it).
  const unsaved = useRef<{ readonly width: number | undefined } | null>(null);
  const flush = useCallback(() => {
    const pending = unsaved.current;
    if (!pending) return;
    unsaved.current = null;
    try {
      if (pending.width === undefined) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, String(pending.width));
    } catch {
      // Width remains a live window preference even if it cannot be saved.
    }
  }, [storageKey]);

  const setAndRemember = useCallback((next: number | undefined) => {
    unsaved.current = { width: next };
    setWidth(next);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(flush, 150);
    return () => window.clearTimeout(timer);
  }, [flush, width]);

  useEffect(() => {
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [flush]);

  return [width, setAndRemember] as const;
}
