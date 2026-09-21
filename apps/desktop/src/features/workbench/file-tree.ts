export interface FileTreeNode {
  readonly name: string;
  readonly path: string;
  readonly kind: "directory" | "file";
  readonly children: readonly FileTreeNode[];
}

interface MutableFileTreeNode {
  readonly name: string;
  readonly path: string;
  readonly kind: "directory" | "file";
  readonly children: MutableFileTreeNode[];
  readonly childrenByKey: Map<string, MutableFileTreeNode>;
}

export function filterWorkspaceFiles(files: readonly string[], query: string): readonly string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return files;
  }
  return files.filter((filePath) => filePath.toLowerCase().includes(needle));
}

export function buildFileTree(files: readonly string[]): readonly FileTreeNode[] {
  const root: MutableFileTreeNode = {
    name: "",
    path: "",
    kind: "directory",
    children: [],
    childrenByKey: new Map(),
  };
  for (const filePath of files) {
    const parts = filePath.split("/").filter(Boolean);
    let cursor = root;
    let nodePath = "";
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]!;
      const isFile = index === parts.length - 1;
      nodePath = nodePath ? `${nodePath}/${part}` : part;
      const kind = isFile ? "file" : "directory";
      const childKey = `${kind}:${part}`;
      let next = cursor.childrenByKey.get(childKey);
      if (!next) {
        next = {
          name: part,
          path: nodePath,
          kind,
          children: [],
          childrenByKey: new Map(),
        };
        cursor.children.push(next);
        cursor.childrenByKey.set(childKey, next);
      }
      if (!isFile) {
        cursor = next;
      }
    }
  }
  return sortTree(root.children);
}

function sortTree(nodes: readonly MutableFileTreeNode[]): readonly FileTreeNode[] {
  return [...nodes]
    .sort((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind === "directory" ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    })
    .map((node) => ({
      name: node.name,
      path: node.path,
      kind: node.kind,
      children: sortTree(node.children),
    }));
}
