import { expect, test } from "@playwright/test";
import {
  EMPTY_FILE_TABS,
  activateFile,
  ancestorDirectoryPaths,
  breadcrumbSegments,
  closeFile,
  fileNameFromPath,
  isMarkdownPath,
  openFile,
  pruneFiles,
} from "../../src/features/workbench/file-workbench-state";

test("openFile adds a tab and activates it", () => {
  const opened = openFile(EMPTY_FILE_TABS, "src/app.ts");
  expect(opened).toEqual({ tabs: ["src/app.ts"], active: "src/app.ts" });
  expect(openFile(opened, "src/app.ts")).toEqual(opened);
  expect(openFile(opened, "README.md")).toEqual({
    tabs: ["src/app.ts", "README.md"],
    active: "README.md",
  });
});

test("closeFile keeps active inside tabs", () => {
  const two = openFile(openFile(EMPTY_FILE_TABS, "a.ts"), "b.ts");
  expect(closeFile(two, "b.ts")).toEqual({ tabs: ["a.ts"], active: "a.ts" });
  expect(closeFile(two, "a.ts")).toEqual({ tabs: ["b.ts"], active: "b.ts" });
  expect(closeFile(closeFile(two, "a.ts"), "b.ts")).toEqual(EMPTY_FILE_TABS);
  expect(activateFile(two, "missing.ts")).toEqual(two);
  expect(activateFile(two, "a.ts").active).toBe("a.ts");
});

test("pruneFiles drops missing paths and repairs active", () => {
  const state = openFile(openFile(EMPTY_FILE_TABS, "keep.ts"), "gone.ts");
  expect(pruneFiles(state, ["keep.ts"])).toEqual({ tabs: ["keep.ts"], active: "keep.ts" });
  expect(pruneFiles(state, [])).toEqual(EMPTY_FILE_TABS);
  expect(pruneFiles(EMPTY_FILE_TABS, ["keep.ts"])).toEqual(EMPTY_FILE_TABS);
});

test("path helpers", () => {
  expect(isMarkdownPath("notes.md")).toBe(true);
  expect(isMarkdownPath("src/app.ts")).toBe(false);
  expect(fileNameFromPath("src/lib/util.ts")).toBe("util.ts");
  expect(breadcrumbSegments("src/lib/util.ts")).toEqual(["src", "lib", "util.ts"]);
  expect(ancestorDirectoryPaths("src/lib/util.ts")).toEqual(["src", "src/lib"]);
  expect(ancestorDirectoryPaths("README.md")).toEqual([]);
});
