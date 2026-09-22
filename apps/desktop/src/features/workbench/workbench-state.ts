import {
  MAX_WORKBENCH_FILE_TABS,
  MAX_WORKBENCH_TOOLS,
  toolRefId,
  type TaskWorkbenchTemplate,
  type ToolRef,
} from "../../../contracts/workbench";
import { EMPTY_FILE_TABS, openFile, openFileAtLine } from "./file-workbench-state";

export interface WorkspaceFileReference {
  readonly workspaceId: string;
  readonly path: string;
  readonly line?: number;
  readonly endLine?: number;
}

export type WorkbenchAction =
  | { readonly type: "open-tool"; readonly tool: ToolRef }
  | { readonly type: "activate-tool"; readonly toolId: string }
  | { readonly type: "close-tool"; readonly toolId: string }
  | { readonly type: "show-chooser" }
  | { readonly type: "set-visibility"; readonly visibility: "visible" | "hidden" }
  | { readonly type: "set-files"; readonly files: TaskWorkbenchTemplate["files"] }
  | { readonly type: "set-changes"; readonly changes: TaskWorkbenchTemplate["changes"] }
  | { readonly type: "open-file"; readonly file: WorkspaceFileReference };

export function initialWorkbenchView(workspaceId: string, isUnsent = false): TaskWorkbenchTemplate {
  return {
    visibility: isUnsent ? "hidden" : "visible",
    tools: [{ kind: "changes" }],
    selection: { kind: "tool", toolId: "changes" },
    files: { workspaceId, tabs: EMPTY_FILE_TABS },
    changes: { workspaceId, selectedPath: null, scope: { kind: "uncommitted" } },
  };
}

export function activeWorkbenchTool(view: TaskWorkbenchTemplate): ToolRef | undefined {
  const selection = view.selection;
  return selection.kind === "tool"
    ? view.tools.find((tool) => toolRefId(tool) === selection.toolId)
    : undefined;
}

/** Rebase explicit actions onto the saved layout before the first write. */
export function restoreWorkbenchView(
  fallback: TaskWorkbenchTemplate,
  saved: TaskWorkbenchTemplate | null,
  pendingActions: readonly WorkbenchAction[],
): { readonly view: TaskWorkbenchTemplate; readonly error: string } {
  return applyWorkbenchActions(saved ?? fallback, pendingActions);
}

function actionLimitError(view: TaskWorkbenchTemplate, action: WorkbenchAction): string {
  if (
    (action.type === "set-files" && action.files.tabs.tabs.length > MAX_WORKBENCH_FILE_TABS) ||
    (action.type === "open-file" &&
      view.files.workspaceId === action.file.workspaceId &&
      view.files.tabs.tabs.length >= MAX_WORKBENCH_FILE_TABS &&
      !view.files.tabs.tabs.includes(action.file.path))
  ) {
    return `You have ${MAX_WORKBENCH_FILE_TABS} file tabs open. Close a file tab before opening another.`;
  }
  if (
    action.type === "open-tool" &&
    view.tools.length >= MAX_WORKBENCH_TOOLS &&
    !view.tools.some((tool) => toolRefId(tool) === toolRefId(action.tool))
  ) {
    return "Close a tool tab before opening another.";
  }
  return "";
}

export function applyWorkbenchActions(
  initial: TaskWorkbenchTemplate,
  actions: readonly WorkbenchAction[],
): { readonly view: TaskWorkbenchTemplate; readonly error: string } {
  let view = initial;
  let error = "";
  for (const action of actions) {
    const limitError = actionLimitError(view, action);
    if (limitError) error = limitError;
    else view = reduceWorkbench(view, action);
  }
  return { view, error };
}

/** The sole transition path for a window's live tool layout. */
export function reduceWorkbench(
  view: TaskWorkbenchTemplate,
  action: WorkbenchAction,
): TaskWorkbenchTemplate {
  if (actionLimitError(view, action)) return view;
  switch (action.type) {
    case "open-tool": {
      const toolId = toolRefId(action.tool);
      const existing = view.tools.some((tool) => toolRefId(tool) === toolId);
      if (
        existing &&
        view.visibility === "visible" &&
        view.selection.kind === "tool" &&
        view.selection.toolId === toolId
      ) {
        return view;
      }
      return {
        ...view,
        visibility: "visible",
        tools: existing ? view.tools : [...view.tools, action.tool],
        selection: { kind: "tool", toolId },
      };
    }
    case "activate-tool": {
      const tool = view.tools.find((candidate) => toolRefId(candidate) === action.toolId);
      return tool ? reduceWorkbench(view, { type: "open-tool", tool }) : view;
    }
    case "close-tool": {
      const index = view.tools.findIndex((tool) => toolRefId(tool) === action.toolId);
      if (index < 0) return view;
      const tools = view.tools.filter((tool) => toolRefId(tool) !== action.toolId);
      if (tools.length === 0) {
        return { ...view, tools, selection: { kind: "chooser" } };
      }
      if (view.selection.kind !== "tool" || view.selection.toolId !== action.toolId) {
        return { ...view, tools };
      }
      const neighbor = tools[Math.min(index, tools.length - 1)];
      return {
        ...view,
        tools,
        selection: neighbor ? { kind: "tool", toolId: toolRefId(neighbor) } : { kind: "chooser" },
      };
    }
    case "show-chooser":
      return view.visibility === "visible" && view.selection.kind === "chooser"
        ? view
        : { ...view, visibility: "visible", selection: { kind: "chooser" } };
    case "set-visibility":
      return view.visibility === action.visibility
        ? view
        : { ...view, visibility: action.visibility };
    case "set-files":
      return action.files === view.files ? view : { ...view, files: action.files };
    case "set-changes":
      return action.changes === view.changes ? view : { ...view, changes: action.changes };
    case "open-file": {
      const { file } = action;
      const current =
        view.files.workspaceId === file.workspaceId ? view.files.tabs : EMPTY_FILE_TABS;
      const tabs =
        file.line === undefined
          ? openFile(current, file.path)
          : openFileAtLine(current, file.path, file.line, file.endLine);
      return reduceWorkbench(
        { ...view, files: { workspaceId: file.workspaceId, tabs } },
        { type: "open-tool", tool: { kind: "files" } },
      );
    }
  }
}
