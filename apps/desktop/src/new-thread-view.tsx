import { useEffect, useRef, type KeyboardEvent } from "react";
import type { RuntimeSnapshot } from "@pi-app/session-driver/runtime-types";
import type { NewThreadEnvironment, WorkspaceRecord } from "./desktop-state";
import { ArrowUpIcon, ModelIcon, ReasoningIcon } from "./icons";

interface NewThreadViewProps {
  readonly workspaces: readonly WorkspaceRecord[];
  readonly selectedWorkspaceId: string;
  readonly runtime?: RuntimeSnapshot;
  readonly environment: NewThreadEnvironment;
  readonly prompt: string;
  readonly onChangePrompt: (prompt: string) => void;
  readonly onSelectEnvironment: (environment: NewThreadEnvironment) => void;
  readonly onSelectWorkspace: (workspaceId: string) => void;
  readonly onSubmit: () => void;
}

export function NewThreadView({
  workspaces,
  selectedWorkspaceId,
  runtime,
  environment,
  prompt,
  onChangePrompt,
  onSelectEnvironment,
  onSelectWorkspace,
  onSubmit,
}: NewThreadViewProps) {
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const workspace = workspaces.find((entry) => entry.id === selectedWorkspaceId) ?? workspaces[0];
  const modelLabel = runtime?.settings.defaultProvider && runtime?.settings.defaultModelId
    ? `${runtime.settings.defaultProvider}:${runtime.settings.defaultModelId}`
    : "Choose model in settings";
  const thinkingLabel = runtime?.settings.defaultThinkingLevel
    ? formatThinking(runtime.settings.defaultThinkingLevel)
    : "Reasoning default";

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }

    event.preventDefault();
    onSubmit();
  };

  useEffect(() => {
    composerRef.current?.focus();
  }, []);

  if (!workspace) {
    return (
      <section className="canvas canvas--empty">
        <div className="empty-panel">
          <div className="session-header__eyebrow">New thread</div>
          <h1>Open a folder to begin</h1>
          <p>Select a repository from the sidebar first, then start a local or worktree-backed thread.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="canvas canvas--new-thread">
      <div className="new-thread">
        <div className="new-thread__hero">
          <div className="new-thread__eyebrow">New thread</div>
          <h1 className="new-thread__title">Let&apos;s build</h1>
          <label className="new-thread__workspace-picker">
            <span className="sr-only">Workspace</span>
            <select
              className="new-thread__workspace"
              value={workspace.id}
              onChange={(event) => onSelectWorkspace(event.target.value)}
            >
              {workspaces.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="new-thread__composer">
          <textarea
            aria-label="New thread prompt"
            className="new-thread__textarea"
            data-testid="new-thread-composer"
            ref={composerRef}
            placeholder="Ask pi anything, use / for commands, or $ for skills"
            value={prompt}
            onChange={(event) => onChangePrompt(event.target.value)}
            onKeyDown={handleKeyDown}
          />

          <div className="new-thread__bar">
            <div className="new-thread__controls">
              <div className="new-thread__environment-group">
                <button
                  className={`new-thread__environment ${environment === "local" ? "new-thread__environment--active" : ""}`}
                  type="button"
                  onClick={() => onSelectEnvironment("local")}
                >
                  <span>Local</span>
                </button>
                <button
                  className={`new-thread__environment ${environment === "new-worktree" ? "new-thread__environment--active" : ""}`}
                  type="button"
                  onClick={() => onSelectEnvironment("new-worktree")}
                >
                  <span>New worktree</span>
                </button>
              </div>
              <div className="new-thread__meta">
                <span className="new-thread__meta-item">
                  <ModelIcon />
                  <span>{modelLabel}</span>
                </span>
                <span className="new-thread__meta-item">
                  <ReasoningIcon />
                  <span>{thinkingLabel}</span>
                </span>
              </div>
            </div>

            <button
              aria-label="Start thread"
              className="button button--primary button--cta-icon"
              type="button"
              onClick={onSubmit}
            >
              <ArrowUpIcon />
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function formatThinking(value: string): string {
  return value === "xhigh" ? "Extra High" : value.charAt(0).toUpperCase() + value.slice(1);
}
