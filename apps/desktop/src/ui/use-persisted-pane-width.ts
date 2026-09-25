import { useEffect, useState } from "react";

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

  useEffect(() => {
    const save = () => {
      try {
        if (width === undefined) localStorage.removeItem(storageKey);
        else localStorage.setItem(storageKey, String(width));
      } catch {
        // Width remains a live window preference even if it cannot be saved.
      }
    };
    const timer = window.setTimeout(save, 150);
    window.addEventListener("pagehide", save);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pagehide", save);
    };
  }, [storageKey, width]);

  return [width, setWidth] as const;
}
