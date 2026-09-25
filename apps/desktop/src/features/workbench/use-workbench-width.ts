import type { CSSProperties } from "react";
import { usePersistedPaneWidth } from "../../ui/use-persisted-pane-width";

/** A window layout preference shared by all tools and tasks, independent of their contents. */
export function useWorkbenchWidth() {
  const [width, setWidth] = usePersistedPaneWidth("pi-gui.workbench-width", {
    min: 320,
    max: 1200,
  });
  const style: CSSProperties & { "--workbench-width": string } = {
    "--workbench-width": `${width ?? 440}px`,
  };
  return { style, setWidth };
}
