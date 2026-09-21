import { expect, test } from "@playwright/test";
import { buildFileTree, filterWorkspaceFiles } from "../../src/features/workbench/file-tree";

test("filterWorkspaceFiles keeps ancestor paths by filtering files then building the tree", () => {
  const files = ["README.md", "src/app.ts", "src/lib/util.ts", "docs/guide.md"];
  expect(filterWorkspaceFiles(files, "util")).toEqual(["src/lib/util.ts"]);
  expect(filterWorkspaceFiles(files, "SRC/")).toEqual(["src/app.ts", "src/lib/util.ts"]);
  expect(filterWorkspaceFiles(files, "   ")).toEqual(files);

  const tree = buildFileTree(filterWorkspaceFiles(files, "util"));
  expect(tree).toEqual([
    {
      name: "src",
      path: "src",
      kind: "directory",
      children: [
        {
          name: "lib",
          path: "src/lib",
          kind: "directory",
          children: [
            {
              name: "util.ts",
              path: "src/lib/util.ts",
              kind: "file",
              children: [],
            },
          ],
        },
      ],
    },
  ]);
});

test("buildFileTree sorts directories before files", () => {
  const tree = buildFileTree(["zeta.ts", "src/app.ts", "alpha.ts"]);
  expect(tree.map((node) => node.name)).toEqual(["src", "alpha.ts", "zeta.ts"]);
});
