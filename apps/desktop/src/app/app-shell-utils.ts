import type { AppView } from "../../contracts/desktop-state";

export type ClosableSurface = "files" | "changes" | "terminal";

export function closableSurfaceFromTarget(target: EventTarget | null): ClosableSurface | null {
  if (!(target instanceof Element)) {
    return null;
  }
  if (target.closest("[data-pi-terminal]")) {
    return "terminal";
  }
  if (target.closest(".diff-panel")) {
    return "changes";
  }
  if (target.closest("[data-testid='file-workbench']")) {
    return "files";
  }
  return null;
}

export function isEventInsideTerminal(event: globalThis.KeyboardEvent): boolean {
  return closableSurfaceFromTarget(event.target) === "terminal";
}

export function canTogglePrimarySidebar(view: AppView | undefined): boolean {
  return view === "threads" || view === "new-thread" || view === "scheduled";
}
