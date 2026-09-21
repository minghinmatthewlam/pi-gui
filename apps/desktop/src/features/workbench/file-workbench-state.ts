export interface FileLineMark {
  readonly start: number;
  readonly end: number;
}

export interface FileWorkbenchTabs {
  readonly tabs: readonly string[];
  readonly active: string | null;
  readonly line: FileLineMark | null;
  readonly lineNonce: number;
  /** Readable paths opened from a link that may be absent from the file list. */
  readonly retained: readonly string[];
}

export const EMPTY_FILE_TABS: FileWorkbenchTabs = {
  tabs: [],
  active: null,
  line: null,
  lineNonce: 0,
  retained: [],
};

export function openFile(state: FileWorkbenchTabs, path: string): FileWorkbenchTabs {
  if (state.tabs.includes(path)) {
    if (state.active === path && state.line === null) {
      return state;
    }
    return {
      tabs: state.tabs,
      active: path,
      line: null,
      lineNonce: state.lineNonce,
      retained: state.retained,
    };
  }
  return {
    tabs: [...state.tabs, path],
    active: path,
    line: null,
    lineNonce: state.lineNonce,
    retained: state.retained,
  };
}

export function openFileAtLine(
  state: FileWorkbenchTabs,
  path: string,
  line: number,
  endLine = line,
): FileWorkbenchTabs {
  const tabs = state.tabs.includes(path) ? state.tabs : [...state.tabs, path];
  const retained = state.retained.includes(path) ? state.retained : [...state.retained, path];
  return {
    tabs,
    active: path,
    line: { start: line, end: endLine },
    lineNonce: state.lineNonce + 1,
    retained,
  };
}

export function closeFile(state: FileWorkbenchTabs, path: string): FileWorkbenchTabs {
  const index = state.tabs.indexOf(path);
  if (index < 0) {
    return state;
  }
  const tabs = state.tabs.filter((tab) => tab !== path);
  const retained = state.retained.filter((item) => item !== path && tabs.includes(item));
  if (tabs.length === 0) {
    return EMPTY_FILE_TABS;
  }
  if (state.active !== path) {
    return {
      tabs,
      active: state.active,
      line: state.line,
      lineNonce: state.lineNonce,
      retained,
    };
  }
  return {
    tabs,
    active: tabs[Math.min(index, tabs.length - 1)] ?? null,
    line: null,
    lineNonce: state.lineNonce,
    retained,
  };
}

export function activateFile(state: FileWorkbenchTabs, path: string): FileWorkbenchTabs {
  if (!state.tabs.includes(path)) {
    return state;
  }
  if (state.active === path && state.line === null) {
    return state;
  }
  return {
    tabs: state.tabs,
    active: path,
    line: null,
    lineNonce: state.lineNonce,
    retained: state.retained,
  };
}

export function pruneFiles(
  state: FileWorkbenchTabs,
  availablePaths: readonly string[],
): FileWorkbenchTabs {
  const allowed = new Set(availablePaths);
  const retained = state.retained.filter((path) => state.tabs.includes(path) && !allowed.has(path));
  const keep = new Set<string>([...allowed, ...retained]);
  const tabs = state.tabs.filter((tab) => keep.has(tab));
  if (tabs.length === 0) {
    return EMPTY_FILE_TABS;
  }
  const active =
    state.active && tabs.includes(state.active) ? state.active : (tabs[tabs.length - 1] ?? null);
  return {
    tabs,
    active,
    line: active === state.active ? state.line : null,
    lineNonce: state.lineNonce,
    retained: retained.filter((path) => tabs.includes(path)),
  };
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
