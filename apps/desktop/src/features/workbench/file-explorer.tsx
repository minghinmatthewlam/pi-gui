import { useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FileIcon,
  FolderIcon,
  RefreshIcon,
} from "../../ui/icons";
import { ancestorDirectoryPaths } from "./file-workbench-state";
import { buildFileTree, filterWorkspaceFiles, type FileTreeNode } from "./file-tree";

interface FileExplorerProps {
  readonly files: readonly string[] | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly selectedPath: string | null;
  readonly onSelect: (path: string) => void;
  readonly onRefresh: () => void;
}

export function FileExplorer({
  files,
  loading,
  error,
  selectedPath,
  onSelect,
  onRefresh,
}: FileExplorerProps) {
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const filterActive = filter.trim().length > 0;
  const visibleFiles = useMemo(
    () => (files ? filterWorkspaceFiles(files, filter) : []),
    [files, filter],
  );
  const tree = useMemo(() => buildFileTree(visibleFiles), [visibleFiles]);

  useEffect(() => {
    if (!selectedPath) {
      return;
    }
    setExpanded((current) => {
      const next = new Set(current);
      let changed = false;
      for (const directory of ancestorDirectoryPaths(selectedPath)) {
        if (!next.has(directory)) {
          next.add(directory);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [selectedPath]);

  const emptyCopy = error
    ? error
    : files === null
      ? "Loading files..."
      : files.length === 0
        ? "No indexed files"
        : visibleFiles.length === 0
          ? "No matching files"
          : null;

  return (
    <section className="file-explorer" data-testid="file-explorer" aria-label="File explorer">
      <div className="file-explorer__toolbar">
        <input
          aria-label="Filter files"
          className="file-explorer__filter"
          data-testid="file-workbench-filter"
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter files…"
          type="search"
          value={filter}
        />
        <button
          aria-label="Refresh"
          className="icon-button"
          disabled={loading}
          onClick={onRefresh}
          type="button"
        >
          <RefreshIcon />
        </button>
      </div>
      {emptyCopy ? (
        <div className="diff-panel__empty">{emptyCopy}</div>
      ) : (
        <div className="file-workbench__tree" data-testid="file-workbench-tree">
          {tree.map((node) => (
            <FileTreeRow
              key={node.path || node.name}
              expandAll={filterActive}
              expanded={expanded}
              node={node}
              selectedPath={selectedPath}
              onSelect={onSelect}
              onToggleDirectory={(path) => {
                setExpanded((current) => {
                  const next = new Set(current);
                  if (next.has(path)) {
                    next.delete(path);
                  } else {
                    next.add(path);
                  }
                  return next;
                });
              }}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function FileTreeRow({
  node,
  expandAll,
  expanded,
  selectedPath,
  onSelect,
  onToggleDirectory,
}: {
  readonly node: FileTreeNode;
  readonly expandAll: boolean;
  readonly expanded: ReadonlySet<string>;
  readonly selectedPath: string | null;
  readonly onSelect: (path: string) => void;
  readonly onToggleDirectory: (path: string) => void;
}) {
  if (node.kind === "directory") {
    const isExpanded = expandAll || expanded.has(node.path);
    return (
      <div>
        <button
          aria-expanded={isExpanded}
          className="file-workbench__tree-row file-workbench__tree-row--dir"
          style={{ "--depth": depthFromPath(node.path) } as CSSProperties}
          type="button"
          onClick={() => onToggleDirectory(node.path)}
        >
          <span className="file-workbench__tree-icon">
            {isExpanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
          </span>
          <span className="file-workbench__tree-icon">
            <FolderIcon />
          </span>
          <span>{node.name}</span>
        </button>
        {isExpanded
          ? node.children.map((child) => (
              <FileTreeRow
                key={child.path || child.name}
                expandAll={expandAll}
                expanded={expanded}
                node={child}
                selectedPath={selectedPath}
                onSelect={onSelect}
                onToggleDirectory={onToggleDirectory}
              />
            ))
          : null}
      </div>
    );
  }

  const isSelected = selectedPath === node.path;
  return (
    <button
      className={`file-workbench__tree-row file-workbench__tree-row--file ${isSelected ? "file-workbench__tree-row--selected" : ""}`}
      data-file-path={node.path}
      style={{ "--depth": depthFromPath(node.path) } as CSSProperties}
      type="button"
      onClick={() => onSelect(node.path)}
    >
      <span className="file-workbench__tree-icon">
        <FileIcon />
      </span>
      <span>{node.name}</span>
    </button>
  );
}

function depthFromPath(path: string): number {
  return path.split("/").filter(Boolean).length - 1;
}
