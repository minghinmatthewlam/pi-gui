import { useEffect, useRef, useState, type Dispatch, type KeyboardEvent, type SetStateAction } from "react";
import {
  getSelectedSession,
  getSelectedWorkspace,
  type DesktopAppState,
  type WorkspaceRecord,
} from "./desktop-state";
import { FolderIcon, PlusIcon, SettingsIcon } from "./icons";
import { TimelineItem } from "./timeline-item";

function useDesktopAppState() {
  const [snapshot, setSnapshot] = useState<DesktopAppState | null>(null);

  useEffect(() => {
    let active = true;
    const api = window.piApp;
    if (!api) {
      return undefined;
    }

    void api.getState().then((state) => {
      if (active) {
        setSnapshot(state);
      }
    });

    const unsubscribe = api.onStateChanged((state) => {
      if (active) {
        setSnapshot(state);
      }
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return [snapshot, setSnapshot] as const;
}

function formatRelativeTime(value: string): string {
  if (!value) {
    return "";
  }

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return value;
  }

  const diffMs = Date.now() - timestamp;
  const diffMinutes = Math.max(0, Math.floor(diffMs / 60000));
  if (diffMinutes < 1) return "now";
  if (diffMinutes < 60) return `${diffMinutes}m`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d`;
  return new Date(timestamp).toLocaleDateString();
}

function updateSnapshot(
  api: NonNullable<typeof window.piApp>,
  setSnapshot: Dispatch<SetStateAction<DesktopAppState | null>>,
  action: () => Promise<DesktopAppState>,
) {
  return action().then((state) => {
    setSnapshot(state);
    return state;
  });
}

function RunningStatus({ startedAt }: { readonly startedAt?: string }) {
  const [label, setLabel] = useState(() => formatRunningLabel(startedAt));

  useEffect(() => {
    setLabel(formatRunningLabel(startedAt));
    if (!startedAt) {
      return undefined;
    }

    const interval = window.setInterval(() => {
      setLabel(formatRunningLabel(startedAt));
    }, 1000);

    return () => {
      window.clearInterval(interval);
    };
  }, [startedAt]);

  return <>{label}</>;
}

function formatRunningLabel(startedAt: string | undefined): string {
  if (!startedAt) {
    return "Working…";
  }

  const diffMs = Math.max(0, Date.now() - Date.parse(startedAt));
  const seconds = Math.max(1, Math.floor(diffMs / 1000));
  if (seconds < 60) {
    return `Working for ${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return remaining === 0 ? `Working for ${minutes}m` : `Working for ${minutes}m ${remaining}s`;
}

export default function App() {
  const [snapshot, setSnapshot] = useDesktopAppState();
  const [composerDraft, setComposerDraft] = useState("");
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const api = window.piApp;

  const selectedWorkspace = snapshot ? (getSelectedWorkspace(snapshot) ?? snapshot.workspaces[0]) : undefined;
  const selectedSession = snapshot ? (getSelectedSession(snapshot) ?? selectedWorkspace?.sessions[0]) : undefined;
  const selectedSessionKey = `${selectedWorkspace?.id ?? ""}:${selectedSession?.id ?? ""}`;

  useEffect(() => {
    if (!snapshot) {
      return;
    }
    setComposerDraft(snapshot.composerDraft);
  }, [selectedSessionKey]);

  useEffect(() => {
    if (!api || !snapshot || composerDraft === snapshot.composerDraft) {
      return undefined;
    }

    const timeout = window.setTimeout(() => {
      void updateSnapshot(api, setSnapshot, () => api.updateComposerDraft(composerDraft));
    }, 350);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [api, composerDraft, setSnapshot, snapshot]);

  useEffect(() => {
    const composer = composerRef.current;
    if (!composer) {
      return undefined;
    }

    composer.style.height = "0px";
    composer.style.height = `${Math.min(composer.scrollHeight, 220)}px`;
  }, [composerDraft]);

  if (!api || !snapshot) {
    return (
      <div className="shell shell--loading">
        <main className="loading-card">
          <div className="loading-card__eyebrow">pi-app</div>
          <h1>Loading sessions</h1>
          <p>The desktop shell is restoring folder and thread state from the main process.</p>
        </main>
      </div>
    );
  }

  const submitComposerDraft = () => {
    if (!composerDraft.trim()) {
      return;
    }
    const previousDraft = composerDraft;
    setComposerDraft("");
    void (async () => {
      const nextState = await updateSnapshot(api, setSnapshot, () => api.submitComposer(previousDraft));
      setComposerDraft(nextState.composerDraft);
    })().catch(() => {
      setComposerDraft(previousDraft);
    });
  };

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }

    event.preventDefault();
    if (!composerDraft.trim()) {
      return;
    }

    submitComposerDraft();
  };

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar__top">
          <button
            className="sidebar__new"
            type="button"
            disabled={!selectedWorkspace}
            onClick={() => {
              if (!selectedWorkspace) {
                return;
              }
              void updateSnapshot(api, setSnapshot, () =>
                api.createSession({ workspaceId: selectedWorkspace.id, title: "New thread" }),
              );
            }}
          >
            <PlusIcon />
            <span>New thread</span>
          </button>
        </div>

        <div className="sidebar__section">
          <div className="section__head">
            <span>Threads</span>
            <div className="section__tools">
              <button
                aria-label="Open folder"
                className="icon-button"
                type="button"
                onClick={() => {
                  void updateSnapshot(api, setSnapshot, () => api.pickWorkspace());
                }}
              >
                <FolderIcon />
              </button>
            </div>
          </div>

          {snapshot.workspaces.length === 0 ? (
            <div className="empty-state" data-testid="empty-state">
              <h2>No folders yet</h2>
              <p>Open a project folder to start building a workspace and session list.</p>
              <button
                className="button button--primary"
                type="button"
                onClick={() => {
                  void updateSnapshot(api, setSnapshot, () => api.pickWorkspace());
                }}
              >
                Open first folder
              </button>
            </div>
          ) : (
            <div className="workspace-list" data-testid="workspace-list">
              {snapshot.workspaces.map((workspace: WorkspaceRecord) => {
                const workspaceActive = workspace.id === selectedWorkspace?.id;
                return (
                  <section key={workspace.id} className="workspace-group">
                    <button
                      className={`workspace-row ${workspaceActive ? "workspace-row--active" : ""}`}
                      onClick={() => {
                        void updateSnapshot(api, setSnapshot, () => api.selectWorkspace(workspace.id));
                      }}
                      type="button"
                    >
                      <span className="workspace-row__icon" aria-hidden="true">
                        <FolderIcon />
                      </span>
                      <span className="workspace-row__name">{workspace.name}</span>
                      <span className="workspace-row__time">{formatRelativeTime(workspace.lastOpenedAt)}</span>
                    </button>
                    <div className="session-list">
                      {workspace.sessions.map((session) => {
                        const active = workspace.id === selectedWorkspace?.id && session.id === selectedSession?.id;
                        return (
                          <button
                            key={session.id}
                            className={`session-row ${active ? "session-row--active" : ""}`}
                            onClick={() => {
                              void updateSnapshot(api, setSnapshot, () =>
                                api.selectSession({ workspaceId: workspace.id, sessionId: session.id }),
                              );
                            }}
                            type="button"
                          >
                            <span className={`session-row__status session-row__status--${session.status}`} />
                            <span className="session-row__body">
                              <span className="session-row__title">{session.title}</span>
                              <span className="session-row__preview">{session.preview}</span>
                            </span>
                            <span className="session-row__time">{formatRelativeTime(session.updatedAt)}</span>
                          </button>
                        );
                      })}
                    </div>
                  </section>
                );
              })}
            </div>
          )}
        </div>

        <div className="sidebar__footer">
          <div className="sidebar__settings">
            <span className="sidebar__settings-mark">
              <SettingsIcon />
            </span>
            <span>Settings</span>
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="topbar__title">
            {selectedWorkspace && selectedSession ? (
              <>
                <span className="topbar__workspace">{selectedWorkspace.name}</span>
                <span className="topbar__separator">/</span>
                <span className="topbar__session">{selectedSession.title}</span>
              </>
            ) : (
              <span className="topbar__workspace">Open a folder to begin</span>
            )}
          </div>

          <div className="topbar__actions">
            <button
              className="button button--ghost"
              type="button"
              onClick={() => {
                void updateSnapshot(api, setSnapshot, () => api.pickWorkspace());
              }}
            >
              <FolderIcon />
              <span>Add folder</span>
            </button>
          </div>
        </header>

        {selectedWorkspace && selectedSession ? (
          <>
            <section className="canvas">
              {snapshot.lastError ? <div className="error-banner">{snapshot.lastError}</div> : null}

              <div className="timeline-pane">
                <div className="timeline" data-testid="transcript">
                  {selectedSession.transcript.length === 0 ? (
                    <div className="timeline-empty">Send a prompt to start the session.</div>
                  ) : (
                    selectedSession.transcript.map((item) => (
                      <TimelineItem item={item} key={item.id} />
                    ))
                  )}
                </div>
              </div>
            </section>

            <footer className="composer">
              <div className="composer__surface">
                <textarea
                  aria-label="Composer"
                  data-testid="composer"
                  ref={composerRef}
                  value={composerDraft}
                  onChange={(event) => {
                    setComposerDraft(event.target.value);
                  }}
                  onKeyDown={handleComposerKeyDown}
                  placeholder="Ask pi to inspect the repo, run a fix, or continue the current thread..."
                />
                <div className="composer__bar">
                  <div className="composer__hint">
                    {selectedSession.status === "running" ? (
                      <RunningStatus startedAt={selectedSession.runningSince} />
                    ) : (
                      "Enter to send · Shift+Enter for newline"
                    )}
                  </div>
                  <button
                    className="button button--primary"
                    data-testid="send"
                    type="button"
                    disabled={!composerDraft.trim() && selectedSession.status !== "running"}
                    onClick={() => {
                      if (selectedSession.status === "running") {
                        void updateSnapshot(api, setSnapshot, () => api.cancelCurrentRun());
                        return;
                      }
                      submitComposerDraft();
                    }}
                  >
                    {selectedSession.status === "running" ? "Stop" : "Send"}
                  </button>
                </div>
              </div>
            </footer>
          </>
        ) : selectedWorkspace ? (
          <section className="canvas canvas--empty">
            <div className="empty-panel">
              <div className="session-header__eyebrow">Workspace</div>
              <h1>{selectedWorkspace.name}</h1>
              <p>Create a thread for this folder, then jump between sessions from the sidebar.</p>
              <div className="empty-panel__meta">
                <span className="meta-chip meta-chip--path">{selectedWorkspace.path}</span>
                <span className="meta-chip">{formatRelativeTime(selectedWorkspace.lastOpenedAt)}</span>
              </div>
              <div className="empty-panel__actions">
                <button
                  className="button button--primary"
                  type="button"
                  onClick={() => {
                    void updateSnapshot(api, setSnapshot, () =>
                      api.createSession({ workspaceId: selectedWorkspace.id, title: "New thread" }),
                    );
                  }}
                >
                  New thread
                </button>
              </div>
            </div>
          </section>
        ) : (
          <section className="canvas canvas--empty">
            <div className="empty-panel">
              <div className="session-header__eyebrow">Workspace</div>
              <h1>Open a folder to start</h1>
              <p>Add project folders, group sessions under them, and jump between threads from the sidebar.</p>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
