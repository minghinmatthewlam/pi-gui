/**
 * Editors pi-gui can hand a checkout to. Electron main probes this machine and
 * reports only the editors it can actually launch, so the renderer menu is
 * never a static IDE list that fails when an editor is missing.
 */

export interface DesktopEditorDescriptor {
  readonly id: string;
  readonly label: string;
  /** Compact name the topbar button shows, e.g. "vscode". */
  readonly shortLabel: string;
}

export interface DesktopEditorList {
  readonly editors: readonly DesktopEditorDescriptor[];
  /**
   * Editor the main button opens. Absent when nothing is installed, which is
   * also the state before the first probe finishes.
   */
  readonly preferredEditorId?: string;
}
