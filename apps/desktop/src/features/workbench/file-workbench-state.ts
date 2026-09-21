export interface FileWorkbenchTabs {
  readonly tabs: readonly string[];
  readonly active: string | null;
}

export const EMPTY_FILE_TABS: FileWorkbenchTabs = { tabs: [], active: null };

export function openFile(state: FileWorkbenchTabs, path: string): FileWorkbenchTabs {
  if (state.tabs.includes(path)) {
    return { tabs: state.tabs, active: path };
  }
  return { tabs: [...state.tabs, path], active: path };
}

export function closeFile(state: FileWorkbenchTabs, path: string): FileWorkbenchTabs {
  const index = state.tabs.indexOf(path);
  if (index < 0) {
    return state;
  }
  const tabs = state.tabs.filter((tab) => tab !== path);
  if (tabs.length === 0) {
    return EMPTY_FILE_TABS;
  }
  if (state.active !== path) {
    return { tabs, active: state.active };
  }
  return { tabs, active: tabs[Math.min(index, tabs.length - 1)] ?? null };
}

export function activateFile(state: FileWorkbenchTabs, path: string): FileWorkbenchTabs {
  if (!state.tabs.includes(path)) {
    return state;
  }
  return { tabs: state.tabs, active: path };
}

export function pruneFiles(
  state: FileWorkbenchTabs,
  availablePaths: readonly string[],
): FileWorkbenchTabs {
  const allowed = new Set(availablePaths);
  const tabs = state.tabs.filter((tab) => allowed.has(tab));
  if (tabs.length === 0) {
    return EMPTY_FILE_TABS;
  }
  if (state.active && allowed.has(state.active)) {
    return { tabs, active: state.active };
  }
  return { tabs, active: tabs[tabs.length - 1] ?? null };
}

export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path);
}

export function breadcrumbSegments(path: string): readonly string[] {
  return path.split("/").filter(Boolean);
}

export function fileNameFromPath(path: string): string {
  const segments = breadcrumbSegments(path);
  return segments[segments.length - 1] ?? path;
}

export function ancestorDirectoryPaths(filePath: string): readonly string[] {
  const parts = breadcrumbSegments(filePath);
  if (parts.length < 2) {
    return [];
  }
  const directories: string[] = [];
  let current = "";
  for (const part of parts.slice(0, -1)) {
    current = current ? `${current}/${part}` : part;
    directories.push(current);
  }
  return directories;
}
