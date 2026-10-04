/// <reference lib="dom" />

// Dropped and picked files only become file attachments when their path on disk is known, and a
// DOM File does not carry one. Electron's preload reads it with webUtils. A Tauri webview fires
// no DOM drop for files: its native drag-drop event carries paths and a position instead, so its
// adapter builds Files from those paths, records each path here and dispatches the drop on the
// element under the pointer, which leaves the composer's drop handling the same on both shells.
const recordedPaths = new WeakMap<File, string>();

export function recordFilePath(file: File, path: string): void {
  recordedPaths.set(file, path);
}

export function filePathFor(file: File): string | null {
  const directPath = (file as File & { readonly path?: string }).path?.trim();
  if (directPath) {
    return directPath;
  }
  const recordedPath = recordedPaths.get(file);
  if (recordedPath) {
    return recordedPath;
  }
  return window.piApp?.getPathForFile?.(file)?.trim() || null;
}
