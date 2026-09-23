import { expect, test } from "@playwright/test";
import {
  decodeTaskWorkbenchTemplate,
  MAX_WORKBENCH_FILE_TABS,
  toolRefId,
  type ToolRef,
} from "../../contracts/workbench";
import { openFileAtLine } from "../../src/features/workbench/file-workbench-state";
import {
  activeWorkbenchTool,
  applyWorkbenchActions,
  initialWorkbenchView,
  reduceWorkbench,
  restoreWorkbenchView,
} from "../../src/features/workbench/workbench-state";

test("tasks without a saved layout keep the workbench hidden with Changes ready", () => {
  const existing = initialWorkbenchView("checkout");
  expect(existing).toMatchObject({
    visibility: "hidden",
    tools: [{ kind: "changes" }],
    selection: { kind: "tool", toolId: "changes" },
    changes: { scope: { kind: "uncommitted" }, workspaceId: "checkout", selectedPath: null },
  });
  expect(decodeTaskWorkbenchTemplate(existing)).toEqual(existing);
});

test("opening a tool adds or focuses its singleton without discarding other tools", () => {
  const initial = initialWorkbenchView("checkout");
  const files = reduceWorkbench(initial, { type: "open-tool", tool: { kind: "files" } });
  const terminal = reduceWorkbench(files, { type: "open-tool", tool: { kind: "terminal" } });
  const focused = reduceWorkbench(terminal, { type: "open-tool", tool: { kind: "files" } });
  expect(focused.tools.map(toolRefId)).toEqual(["changes", "files", "terminal"]);
  expect(focused.selection).toEqual({ kind: "tool", toolId: "files" });
  expect(reduceWorkbench(focused, { type: "open-tool", tool: { kind: "files" } })).toBe(focused);
  expect(reduceWorkbench(focused, { type: "activate-tool", toolId: "missing" })).toBe(focused);
});

test("close selects a neighbor, preserves inactive selection, and leaves a chooser after the last tab", () => {
  let view = initialWorkbenchView("checkout");
  for (const kind of ["files", "terminal"] as const) {
    view = reduceWorkbench(view, { type: "open-tool", tool: { kind } });
  }
  const closedInactive = reduceWorkbench(view, { type: "close-tool", toolId: "changes" });
  expect(closedInactive.selection).toEqual({ kind: "tool", toolId: "terminal" });
  const files = reduceWorkbench(closedInactive, { type: "close-tool", toolId: "terminal" });
  expect(files.selection).toEqual({ kind: "tool", toolId: "files" });
  const changes = reduceWorkbench(
    reduceWorkbench(files, { type: "open-tool", tool: { kind: "changes" } }),
    { type: "close-tool", toolId: "files" },
  );
  const empty = reduceWorkbench(changes, { type: "close-tool", toolId: "changes" });
  expect(empty).toMatchObject({ tools: [], visibility: "visible", selection: { kind: "chooser" } });
  expect(activeWorkbenchTool(empty)).toBeUndefined();
  expect(reduceWorkbench(empty, { type: "close-tool", toolId: "missing" })).toBe(empty);
  expect(decodeTaskWorkbenchTemplate(empty)).toEqual(empty);
});

test("hiding and tab switching retain file references and Changes selection", () => {
  const initial = initialWorkbenchView("checkout");
  const tabs = openFileAtLine(initial.files.tabs, "README.md", 5, 7);
  let view = reduceWorkbench(initial, {
    type: "set-files",
    files: { workspaceId: "other-checkout", tabs },
  });
  view = reduceWorkbench(view, {
    type: "set-changes",
    changes: {
      scope: { kind: "uncommitted" },
      workspaceId: "checkout",
      selectedPath: "src/index.ts",
    },
  });
  view = reduceWorkbench(view, { type: "open-tool", tool: { kind: "files" } });
  const hidden = reduceWorkbench(view, { type: "set-visibility", visibility: "hidden" });
  expect(hidden.tools).toBe(view.tools);
  expect(hidden.selection).toBe(view.selection);
  expect(hidden.files).toBe(view.files);
  const changes = reduceWorkbench(hidden, { type: "open-tool", tool: { kind: "changes" } });
  expect(changes.visibility).toBe("visible");
  expect(changes.files.tabs).toBe(tabs);
  expect(changes.changes.selectedPath).toBe("src/index.ts");
  const closedFiles = reduceWorkbench(changes, { type: "close-tool", toolId: "files" });
  expect(closedFiles.files.tabs).toBe(tabs);
  expect(decodeTaskWorkbenchTemplate(closedFiles)).toEqual(closedFiles);
});

test("the chooser leaves tool order and state intact", () => {
  const view = reduceWorkbench(initialWorkbenchView("checkout"), {
    type: "open-tool",
    tool: { kind: "terminal" },
  });
  const chooser = reduceWorkbench(view, { type: "show-chooser" });
  expect(chooser.tools).toBe(view.tools);
  expect(chooser.selection).toEqual({ kind: "chooser" });
  expect(reduceWorkbench(chooser, { type: "show-chooser" })).toBe(chooser);
});

test("saved extension references retain their own identity without a registered frontend", () => {
  const first: ToolRef = { kind: "extension", extensionId: "review", viewId: "pull-request" };
  const second: ToolRef = { kind: "extension", extensionId: "other", viewId: "pull-request" };
  let view = reduceWorkbench(initialWorkbenchView("checkout"), { type: "open-tool", tool: first });
  view = reduceWorkbench(view, { type: "open-tool", tool: second });
  expect(view.tools).toHaveLength(3);
  expect(activeWorkbenchTool(view)).toEqual(second);
  expect(decodeTaskWorkbenchTemplate(view)).toEqual(view);
});

test("restore rebases early explicit actions without losing saved tools or document tabs", () => {
  const untouched = initialWorkbenchView("checkout");
  const saved = reduceWorkbench(untouched, {
    type: "open-file",
    file: { workspaceId: "checkout", path: "saved.ts", line: 2 },
  });
  expect(restoreWorkbenchView(untouched, saved, []).view).toBe(saved);
  expect(restoreWorkbenchView(untouched, null, []).view).toBe(untouched);
  const { view: live } = restoreWorkbenchView(untouched, saved, [
    { type: "open-tool", tool: { kind: "terminal" } },
    { type: "open-file", file: { workspaceId: "checkout", path: "early-link.ts", line: 5 } },
  ]);
  expect(live.tools.map(toolRefId)).toEqual(["changes", "files", "terminal"]);
  expect(live.files.tabs.tabs).toEqual(["saved.ts", "early-link.ts"]);
  expect(live.files.tabs.active).toBe("early-link.ts");
  // A second window can load the durable template without mutating the first window's value.
  const secondWindow = restoreWorkbenchView(initialWorkbenchView("checkout"), saved, []).view;
  const editedSecond = reduceWorkbench(secondWindow, { type: "close-tool", toolId: "files" });
  expect(editedSecond.tools).toEqual([{ kind: "changes" }]);
  expect(saved.tools).toEqual([{ kind: "changes" }, { kind: "files" }]);
});

test("the file limit preserves existing references and reports blocked appends during restore", () => {
  const initial = initialWorkbenchView("checkout");
  const paths = Array.from({ length: MAX_WORKBENCH_FILE_TABS }, (_, index) => `file-${index}.ts`);
  const full = reduceWorkbench(initial, {
    type: "set-files",
    files: {
      workspaceId: "checkout",
      tabs: { ...initial.files.tabs, tabs: paths, active: paths[0] ?? null },
    },
  });
  const action = {
    type: "open-file",
    file: { workspaceId: "checkout", path: "one-too-many.ts" },
  } as const;
  const blocked = applyWorkbenchActions(full, [action]);
  expect(blocked.view).toBe(full);
  expect(blocked.error).toContain("Close a file tab");
  expect(restoreWorkbenchView(initial, full, [action])).toEqual(blocked);
  expect(decodeTaskWorkbenchTemplate(blocked.view)).toEqual(full);
  const existing = applyWorkbenchActions(full, [
    { type: "open-file", file: { workspaceId: "checkout", path: "file-0.ts" } },
  ]);
  expect(existing.error).toBe("");
  expect(existing.view.files.tabs.tabs).toHaveLength(MAX_WORKBENCH_FILE_TABS);
});
