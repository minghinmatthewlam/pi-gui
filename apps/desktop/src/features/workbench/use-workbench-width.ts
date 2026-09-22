import { useEffect, useState, type CSSProperties } from "react";

const STORAGE_KEY = "pi-gui.workbench-width";

/** A window layout preference shared by all tools and tasks, independent of their contents. */
export function useWorkbenchWidth() {
  const [width, setWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(STORAGE_KEY));
      if (Number.isFinite(saved) && saved >= 320 && saved <= 1200) return saved;
    } catch {
      // The layout remains usable when local preference storage is unavailable.
    }
    return 440;
  });

  useEffect(() => {
    const save = () => {
      try {
        localStorage.setItem(STORAGE_KEY, String(width));
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
  }, [width]);

  const style: CSSProperties & { "--workbench-width": string } = {
    "--workbench-width": `${width}px`,
  };
  return { style, setWidth };
}
