import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { toolRefId, type TaskWorkbenchTemplate, type ToolRef } from "../../../contracts/workbench";
import {
  CloseIcon,
  DiffIcon,
  ExtensionIcon,
  FileIcon,
  PlusIcon,
  TerminalIcon,
  WorktreeIcon,
} from "../../ui/icons";
import { activeWorkbenchTool } from "./workbench-state";

interface WorkbenchProps {
  readonly view: TaskWorkbenchTemplate;
  readonly onOpenTool: (tool: ToolRef) => void;
  readonly onActivateTool: (toolId: string) => void;
  readonly onCloseTool: (toolId: string) => void;
  readonly onShowChooser: () => void;
  readonly children?: ReactNode;
  readonly error?: string;
  readonly loading?: boolean;
  readonly onRetryRestore?: () => void;
}

const BUILTIN_TOOLS = [
  { kind: "files", description: "Browse files in this checkout" },
  { kind: "changes", description: "Review uncommitted changes" },
  { kind: "worktrees", description: "Open a task in another checkout" },
  { kind: "terminal", description: "Run commands in this task's checkout" },
] as const;

export function workbenchToolLabel(tool: ToolRef): string {
  switch (tool.kind) {
    case "files":
      return "Files";
    case "changes":
      return "Changes";
    case "worktrees":
      return "Worktrees";
    case "terminal":
      return "Terminal";
    case "extension":
      return tool.viewId;
  }
}

function ToolIcon({ tool }: { readonly tool: ToolRef }) {
  switch (tool.kind) {
    case "files":
      return <FileIcon />;
    case "changes":
      return <DiffIcon />;
    case "worktrees":
      return <WorktreeIcon />;
    case "terminal":
      return <TerminalIcon />;
    case "extension":
      return <ExtensionIcon />;
  }
}

export function Workbench({
  view,
  onOpenTool,
  onActivateTool,
  onCloseTool,
  onShowChooser,
  children,
  error,
  loading = false,
  onRetryRestore,
}: WorkbenchProps) {
  const panelId = useId();
  const addRef = useRef<HTMLButtonElement | null>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const activeTool = activeWorkbenchTool(view);
  const tabId = (toolId: string) => `${panelId}-${encodeURIComponent(toolId)}`;

  const closeAndFocus = (toolId: string) => {
    const index = view.tools.findIndex((tool) => toolRefId(tool) === toolId);
    const remaining = view.tools.filter((tool) => toolRefId(tool) !== toolId);
    const neighbor = remaining[Math.min(index, remaining.length - 1)];
    const active = view.selection;
    const nextId =
      active.kind === "tool" && active.toolId !== toolId
        ? active.toolId
        : neighbor
          ? toolRefId(neighbor)
          : undefined;
    onCloseTool(toolId);
    window.requestAnimationFrame(() => {
      if (nextId) tabRefs.current.get(nextId)?.focus();
      else addRef.current?.focus();
    });
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, toolId: string) => {
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      closeAndFocus(toolId);
      return;
    }
    const index = view.tools.findIndex((tool) => toolRefId(tool) === toolId);
    const nextIndex =
      event.key === "ArrowRight"
        ? (index + 1) % view.tools.length
        : event.key === "ArrowLeft"
          ? (index - 1 + view.tools.length) % view.tools.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? view.tools.length - 1
              : undefined;
    if (nextIndex === undefined) return;
    event.preventDefault();
    const nextTool = view.tools[nextIndex];
    if (!nextTool) return;
    const nextId = toolRefId(nextTool);
    onActivateTool(nextId);
    tabRefs.current.get(nextId)?.focus();
  };

  if (view.visibility === "hidden") return null;

  return (
    <aside
      aria-label="Side workspace"
      className="workbench side-panel"
      data-testid="workbench"
      id="task-workbench"
    >
      <div className="workbench__tabbar">
        <div aria-label="Workspace tools" className="workbench__tabs" role="tablist">
          {view.tools.map((tool, index) => {
            const toolId = toolRefId(tool);
            const label = workbenchToolLabel(tool);
            const selected = view.selection.kind === "tool" && view.selection.toolId === toolId;
            return (
              <div className="workbench__tab-wrapper" key={toolId} role="presentation">
                <button
                  aria-controls={panelId}
                  aria-label={label}
                  aria-selected={selected}
                  className={`workbench__tab${selected ? " workbench__tab--active" : ""}`}
                  data-testid={`workbench-tab-${toolId}`}
                  disabled={loading}
                  id={tabId(toolId)}
                  onClick={() => onActivateTool(toolId)}
                  onKeyDown={(event) => onTabKeyDown(event, toolId)}
                  ref={(button) => {
                    if (button) tabRefs.current.set(toolId, button);
                    else tabRefs.current.delete(toolId);
                  }}
                  role="tab"
                  tabIndex={selected || (view.selection.kind === "chooser" && index === 0) ? 0 : -1}
                  title={tool.kind === "extension" ? `${tool.extensionId}: ${label}` : label}
                  type="button"
                >
                  <ToolIcon tool={tool} />
                  <span>{label}</span>
                </button>
                <button
                  aria-label={`Close ${label} tab`}
                  className="workbench__tab-close icon-button"
                  disabled={loading}
                  onClick={() => closeAndFocus(toolId)}
                  tabIndex={-1}
                  title={`Close ${label} tab`}
                  type="button"
                >
                  <CloseIcon />
                </button>
              </div>
            );
          })}
        </div>
        <button
          aria-label="Add tab"
          className="workbench__add icon-button"
          data-testid="workbench-add-tab"
          disabled={loading}
          onClick={onShowChooser}
          ref={addRef}
          title="Add tab"
          type="button"
        >
          <PlusIcon />
        </button>
      </div>
      {error ? (
        <div className="workbench__error" role="status">
          <p>{error}</p>
          {loading && onRetryRestore ? (
            <button className="button" onClick={onRetryRestore} type="button">
              Retry restoring tabs
            </button>
          ) : null}
        </div>
      ) : null}
      <div
        aria-labelledby={activeTool ? tabId(toolRefId(activeTool)) : undefined}
        className="workbench__content"
        id={panelId}
        role={activeTool ? "tabpanel" : undefined}
      >
        {loading ? (
          <p className="workbench__loading" role="status">
            {error
              ? "Saved tabs are unavailable until restoration succeeds."
              : "Restoring tool tabs…"}
          </p>
        ) : view.selection.kind === "chooser" ? (
          <div className="workbench__chooser" data-testid="workbench-chooser">
            <h2>Open a tool</h2>
            <p>Keep the tools you need alongside your conversation.</p>
            {BUILTIN_TOOLS.map(({ kind, description }) => (
              <button
                aria-label={workbenchToolLabel({ kind })}
                className="workbench__choice"
                key={kind}
                onClick={() => onOpenTool({ kind })}
                type="button"
              >
                <span className="workbench__choice-icon">
                  <ToolIcon tool={{ kind }} />
                </span>
                <span className="workbench__choice-copy">
                  <strong>{workbenchToolLabel({ kind })}</strong>
                  <span>{description}</span>
                </span>
              </button>
            ))}
          </div>
        ) : activeTool?.kind === "extension" ? (
          <div className="workbench__unavailable" role="status">
            <ExtensionIcon />
            <h2>This extension view is unavailable</h2>
            <p>
              {activeTool.extensionId} · {activeTool.viewId}
            </p>
            <p>Your saved tab is retained. Extension commands can still be used when installed.</p>
            <button
              className="button"
              onClick={() => closeAndFocus(toolRefId(activeTool))}
              type="button"
            >
              Close tab
            </button>
          </div>
        ) : (
          children
        )}
      </div>
    </aside>
  );
}
