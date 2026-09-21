// Turns assistant text into a workspace file plus a line span. This module does
// not read the disk; a click later asks readWorkspaceFile whether the file exists.

export interface WorkspaceFileLine {
  readonly path: string;
  readonly line: number;
  readonly endLine: number;
}

const FILE_LINE_PATTERN = /^(.*?)(?::(\d+)(?:-(\d+)|:(\d+))?|#L(\d+))$/;
const PATH_START = /^[\p{L}\p{N}./_~@]$/u;
const LINE_NUMBER = /^[1-9]\d{0,6}$/;

interface MarkdownNode {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
  data?: {
    hProperties?: Record<string, string>;
  };
}

export function parseWorkspaceFileLine(
  raw: string,
  workspacePath: string | null,
): WorkspaceFileLine | null {
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed) || trimmed.includes("\\") || trimmed.includes("://")) {
    return null;
  }
  if (/^(https?|mailto|file):/i.test(trimmed)) {
    return null;
  }

  const match = FILE_LINE_PATTERN.exec(trimmed);
  if (!match) {
    return null;
  }
  const rawPath = match[1];
  const lineText = match[5] ?? match[2];
  const endText = match[3];
  if (!rawPath || rawPath.includes(":")) {
    return null;
  }
  const line = parseLineNumber(lineText);
  if (line === null) {
    return null;
  }
  const endLine = endText === undefined ? line : parseLineNumber(endText);
  if (endLine === null || endLine < line) {
    return null;
  }

  const relative = toWorkspaceRelative(rawPath, workspacePath);
  if (!relative || !isSafeRelativePath(relative)) {
    return null;
  }
  return { path: relative, line, endLine };
}

export function encodeWorkspaceFileLine(file: WorkspaceFileLine): string {
  return `${file.line}:${file.endLine}:${encodeURIComponent(file.path)}`;
}

export function workspaceFileLineFromAnchorProps(props: object): WorkspaceFileLine | null {
  const record = props as { dataWorkspaceFileLine?: unknown; "data-workspace-file-line"?: unknown };
  const encoded = record["data-workspace-file-line"] ?? record.dataWorkspaceFileLine;
  return typeof encoded === "string" ? decodeWorkspaceFileLine(encoded) : null;
}

export function decodeWorkspaceFileLine(value: string | undefined): WorkspaceFileLine | null {
  if (!value) {
    return null;
  }
  const match = /^(\d+):(\d+):(.*)$/.exec(value);
  if (!match) {
    return null;
  }
  const line = parseLineNumber(match[1]);
  const endLine = parseLineNumber(match[2]);
  if (line === null || endLine === null || endLine < line) {
    return null;
  }
  let path: string;
  try {
    path = decodeURIComponent(match[3] ?? "");
  } catch {
    return null;
  }
  if (!isSafeRelativePath(path)) {
    return null;
  }
  return { path, line, endLine };
}

export function remarkWorkspaceFileLines(workspacePath: string | null) {
  return () => (tree: MarkdownNode) => {
    annotateFileLines(tree, workspacePath);
  };
}

function annotateFileLines(node: MarkdownNode, workspacePath: string | null): void {
  if (node.type === "code" || !node.children) {
    return;
  }
  const next: MarkdownNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && typeof child.value === "string") {
      next.push(...splitProse(child.value, workspacePath));
      continue;
    }
    if (child.type === "inlineCode" && typeof child.value === "string") {
      const label = child.value.trim();
      const file = parseWorkspaceFileLine(label, workspacePath);
      next.push(file ? fileLineNode(file, label) : child);
      continue;
    }
    if (child.type === "link" && typeof child.url === "string") {
      const file = parseWorkspaceFileLine(decodeLinkDestination(child.url), workspacePath);
      if (file) {
        child.url = "";
        child.data = {
          ...child.data,
          hProperties: {
            ...child.data?.hProperties,
            dataWorkspaceFileLine: encodeWorkspaceFileLine(file),
          },
        };
      }
      next.push(child);
      continue;
    }
    if (child.type !== "code") {
      annotateFileLines(child, workspacePath);
    }
    next.push(child);
  }
  node.children = next;
}

function splitProse(value: string, workspacePath: string | null): MarkdownNode[] {
  const nodes: MarkdownNode[] = [];
  let cursor = 0;
  for (let index = 0; index < value.length;) {
    const character = value[index] ?? "";
    if (!isBoundary(value, index) || !PATH_START.test(character)) {
      index += 1;
      continue;
    }
    const end = scanTokenEnd(value, index);
    const token = value.slice(index, end);
    const file = parseWorkspaceFileLine(token, workspacePath);
    if (!file) {
      index = Math.max(end, index + 1);
      continue;
    }
    if (index > cursor) {
      nodes.push({ type: "text", value: value.slice(cursor, index) });
    }
    nodes.push(fileLineNode(file, token));
    cursor = end;
    index = end;
  }
  if (nodes.length === 0) {
    return [{ type: "text", value }];
  }
  if (cursor < value.length) {
    nodes.push({ type: "text", value: value.slice(cursor) });
  }
  return nodes;
}

function fileLineNode(file: WorkspaceFileLine, label: string): MarkdownNode {
  return {
    type: "link",
    url: "",
    children: [{ type: "text", value: label }],
    data: {
      hProperties: {
        dataWorkspaceFileLine: encodeWorkspaceFileLine(file),
      },
    },
  };
}

function decodeLinkDestination(url: string): string {
  const trimmed = url.trim();
  try {
    return decodeURI(trimmed);
  } catch {
    return trimmed;
  }
}

function toWorkspaceRelative(rawPath: string, workspacePath: string | null): string | null {
  let path = rawPath.startsWith("./") ? rawPath.slice(2) : rawPath;
  if (!path.startsWith("/")) {
    return path;
  }
  if (!workspacePath) {
    return null;
  }
  const root = workspacePath.replace(/\/+$/, "");
  if (!root.startsWith("/") || path === root || !path.startsWith(`${root}/`)) {
    return null;
  }
  path = path.slice(root.length + 1);
  return path.startsWith("./") ? path.slice(2) : path;
}

function isSafeRelativePath(relative: string): boolean {
  if (!relative || relative.startsWith("/") || relative.includes("//") || relative.includes("\\")) {
    return false;
  }
  const segments = relative.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return false;
  }
  const fileName = segments[segments.length - 1] ?? "";
  const dot = fileName.lastIndexOf(".");
  const extension = dot > 0 ? fileName.slice(dot + 1) : "";
  const hasDirectory = segments.length > 1;
  const extensionOk = /^[A-Za-z][A-Za-z0-9]*$/.test(extension);
  return hasDirectory || extensionOk;
}

function parseLineNumber(text: string | undefined): number | null {
  if (!text || !LINE_NUMBER.test(text)) {
    return null;
  }
  return Number(text);
}

function isBoundary(text: string, index: number): boolean {
  if (index === 0) {
    return true;
  }
  return /[\s([{"'`<]/.test(text[index - 1] ?? "");
}

function scanTokenEnd(text: string, start: number): number {
  let index = start;
  while (index < text.length && !isTokenStop(text, index)) {
    index += 1;
  }
  return index;
}

function isTokenStop(text: string, index: number): boolean {
  const character = text[index];
  if (!character) {
    return true;
  }
  if (character === ".") {
    const next = text[index + 1];
    if (!next) {
      return true;
    }
    return /[\s)\]}>,"'`;]/.test(next);
  }
  return /[\s)\]}>,"'`;?]/.test(character);
}
