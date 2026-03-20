import { useEffect, useRef, useState, type Dispatch, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type SetStateAction } from "react";
import type { RuntimeSnapshot } from "@pi-app/session-driver/runtime-types";
import {
  getSelectedSession,
  getSelectedWorkspace,
  type AppView,
  type DesktopAppState,
  type WorkspaceRecord,
} from "./desktop-state";
import { FolderIcon, PlusIcon, SettingsIcon, SkillIcon } from "./icons";
import { ComposerPanel } from "./composer-panel";
import {
  buildModelOptions,
  findExactSlashCommand,
  findSlashSuggestions,
  flattenSlashSections,
  slashOptionsForCommand,
  type ComposerSlashCommand,
  type ComposerSlashOption,
} from "./composer-commands";
import { SkillsView } from "./skills-view";
import { SettingsView } from "./settings-view";
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

function useRunningLabel(startedAt: string | undefined) {
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

  return label;
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

function nextMenuIndex(current: number, delta: number, total: number): number {
  if (!total) {
    return 0;
  }

  return (current + delta + total) % total;
}

export default function App() {
  const [snapshot, setSnapshot] = useDesktopAppState();
  const [composerDraft, setComposerDraft] = useState("");
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashOptionIndex, setSlashOptionIndex] = useState(0);
  const [slashOptionCommand, setSlashOptionCommand] = useState<ComposerSlashCommand | undefined>();
  const [slashOptionProviderId, setSlashOptionProviderId] = useState<string | undefined>();
  const [slashMenuSuppressedDraft, setSlashMenuSuppressedDraft] = useState("");
  const [workspaceMenuId, setWorkspaceMenuId] = useState<string | null>(null);
  const [workspaceRenameId, setWorkspaceRenameId] = useState<string | null>(null);
  const [workspaceRenameDraft, setWorkspaceRenameDraft] = useState("");
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const timelinePaneRef = useRef<HTMLDivElement | null>(null);
  const lastTranscriptMarkerRef = useRef("");
  const pinnedToBottomRef = useRef(true);
  const workspaceMenuWrapRef = useRef<HTMLSpanElement | null>(null);
  const workspaceRenamePanelRef = useRef<HTMLFormElement | null>(null);
  const workspaceRenameInputRef = useRef<HTMLInputElement | null>(null);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const api = window.piApp;

  const selectedWorkspace = snapshot ? (getSelectedWorkspace(snapshot) ?? snapshot.workspaces[0]) : undefined;
  const selectedSession = snapshot ? (getSelectedSession(snapshot) ?? selectedWorkspace?.sessions[0]) : undefined;
  const selectedRuntime = selectedWorkspace ? snapshot?.runtimeByWorkspace[selectedWorkspace.id] : undefined;
  const composerAttachments = snapshot?.composerAttachments ?? [];
  const runningLabel = useRunningLabel(selectedSession?.status === "running" ? selectedSession.runningSince : undefined);
  const selectedSessionKey = `${selectedWorkspace?.id ?? ""}:${selectedSession?.id ?? ""}`;
  const persistedComposerDraft = snapshot?.composerDraft ?? "";
  const slashQuery = composerDraft.trimStart();
  const slashSections =
    slashQuery.startsWith("/")
      ? findSlashSuggestions(slashQuery, selectedRuntime)
      : [];
  const slashSuggestions = flattenSlashSections(slashSections);
  const exactSlashCommand = findExactSlashCommand(slashQuery, selectedRuntime);
  const activeSlashOptionCommand =
    slashOptionCommand ?? (exactSlashCommand?.submitMode === "pick-option" ? exactSlashCommand : undefined);
  const showSlashMenu =
    selectedSession?.status !== "running" &&
    slashQuery.startsWith("/") &&
    !slashQuery.includes("\n") &&
    !activeSlashOptionCommand &&
    slashQuery !== slashMenuSuppressedDraft &&
    slashSuggestions.length > 0;
  const selectedSlashCommand = showSlashMenu ? slashSuggestions[slashIndex % slashSuggestions.length] : undefined;
  const slashOptions =
    activeSlashOptionCommand?.kind === "model" && slashOptionProviderId
      ? buildModelOptions(selectedRuntime, slashOptionProviderId)
      : slashOptionsForCommand(activeSlashOptionCommand, selectedRuntime);
  const showSlashOptionMenu =
    selectedSession?.status !== "running" &&
    Boolean(activeSlashOptionCommand) &&
    slashOptions.length > 0 &&
    !slashQuery.includes("\n");
  const selectedSlashOption = showSlashOptionMenu ? slashOptions[slashOptionIndex % slashOptions.length] : undefined;

  useEffect(() => {
    if (!snapshot) {
      return;
    }
    setComposerDraft(snapshot.composerDraft);
  }, [selectedSessionKey]);

  useEffect(() => {
    setSlashIndex(0);
  }, [slashQuery]);

  useEffect(() => {
    if (slashMenuSuppressedDraft && slashQuery !== slashMenuSuppressedDraft) {
      setSlashMenuSuppressedDraft("");
    }
  }, [slashMenuSuppressedDraft, slashQuery]);

  useEffect(() => {
    if (!slashQuery.startsWith("/")) {
      setSlashOptionCommand(undefined);
      setSlashOptionProviderId(undefined);
      setSlashOptionIndex(0);
      return;
    }

    if (slashOptionCommand && slashQuery.trim().length > slashOptionCommand.command.length) {
      setSlashOptionCommand(undefined);
      setSlashOptionProviderId(undefined);
      setSlashOptionIndex(0);
    }
  }, [slashOptionCommand, slashQuery]);

  useEffect(() => {
    setShowJumpToLatest(false);
    lastTranscriptMarkerRef.current = "";
    pinnedToBottomRef.current = true;
    setSlashOptionCommand(undefined);
    setSlashOptionProviderId(undefined);
    setSlashOptionIndex(0);
    setSlashMenuSuppressedDraft("");
  }, [selectedSessionKey]);

  useEffect(() => {
    if (!workspaceRenameId) {
      return undefined;
    }

    workspaceRenameInputRef.current?.focus();
    workspaceRenameInputRef.current?.select();
    return undefined;
  }, [workspaceRenameId]);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      const menuContains = workspaceMenuWrapRef.current?.contains(target) ?? false;
      const renamePanelContains = workspaceRenamePanelRef.current?.contains(target) ?? false;
      if (!menuContains && !renamePanelContains) {
        setWorkspaceMenuId(null);
        setWorkspaceRenameId(null);
      }
    };

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setWorkspaceMenuId(null);
        setWorkspaceRenameId(null);
      }
    };

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  useEffect(() => {
    if (!api || composerDraft === persistedComposerDraft) {
      return undefined;
    }

    const timeout = window.setTimeout(() => {
      void updateSnapshot(api, setSnapshot, () => api.updateComposerDraft(composerDraft));
    }, 350);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [api, composerDraft, persistedComposerDraft, setSnapshot]);

  useEffect(() => {
    const composer = composerRef.current;
    if (!composer) {
      return undefined;
    }

    composer.style.height = "0px";
    composer.style.height = `${Math.min(composer.scrollHeight, 220)}px`;
  }, [composerDraft]);

  useEffect(() => {
    const pane = timelinePaneRef.current;
    if (!pane || !selectedSession) {
      return;
    }

    const marker = `${selectedSessionKey}:${selectedSession.transcript.length}:${selectedSession.transcript.at(-1)?.id ?? ""}`;
    if (marker === lastTranscriptMarkerRef.current) {
      return;
    }
    lastTranscriptMarkerRef.current = marker;

    if (pinnedToBottomRef.current) {
      pane.scrollTop = pane.scrollHeight;
      setShowJumpToLatest(false);
      return;
    }

    setShowJumpToLatest(true);
  }, [selectedSession, selectedSessionKey]);

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

  const setActiveView = (view: AppView) => {
    void updateSnapshot(api, setSnapshot, () => api.setActiveView(view));
  };

  const submitComposerDraft = () => {
    if (!selectedSession) {
      return;
    }

    if (selectedSession.status === "running") {
      void updateSnapshot(api, setSnapshot, () => api.cancelCurrentRun());
      return;
    }

    if (!composerDraft.trim() && composerAttachments.length === 0) {
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

  const handlePickImages = () => {
    void updateSnapshot(api, setSnapshot, () => api.pickComposerImages());
  };

  const handleRemoveImage = (attachmentId: string) => {
    void updateSnapshot(api, setSnapshot, () => api.removeComposerImage(attachmentId));
  };

  const handleRefreshRuntime = () => {
    if (!selectedWorkspace) {
      return;
    }
    void updateSnapshot(api, setSnapshot, () => api.refreshRuntime(selectedWorkspace.id));
  };

  const handleSetDefaultModel = (provider: string, modelId: string) => {
    if (!selectedWorkspace) {
      return;
    }
    void updateSnapshot(api, setSnapshot, () => api.setDefaultModel(selectedWorkspace.id, provider, modelId));
  };

  const handleSetThinkingLevel = (thinkingLevel: RuntimeSnapshot["settings"]["defaultThinkingLevel"]) => {
    if (!selectedWorkspace) {
      return;
    }
    void updateSnapshot(api, setSnapshot, () => api.setDefaultThinkingLevel(selectedWorkspace.id, thinkingLevel));
  };

  const handleToggleSkillCommands = (enabled: boolean) => {
    if (!selectedWorkspace) {
      return;
    }
    void updateSnapshot(api, setSnapshot, () => api.setEnableSkillCommands(selectedWorkspace.id, enabled));
  };

  const handleSetScopedModelPatterns = (patterns: readonly string[]) => {
    if (!selectedWorkspace) {
      return;
    }
    void updateSnapshot(api, setSnapshot, () => api.setScopedModelPatterns(selectedWorkspace.id, patterns));
  };

  const handleLoginProvider = (providerId: string) => {
    if (!selectedWorkspace) {
      return;
    }
    void updateSnapshot(api, setSnapshot, () => api.loginProvider(selectedWorkspace.id, providerId));
  };

  const handleLogoutProvider = (providerId: string) => {
    if (!selectedWorkspace) {
      return;
    }
    void updateSnapshot(api, setSnapshot, () => api.logoutProvider(selectedWorkspace.id, providerId));
  };

  const handleToggleSkill = (filePath: string, enabled: boolean) => {
    if (!selectedWorkspace) {
      return;
    }
    void updateSnapshot(api, setSnapshot, () => api.setSkillEnabled(selectedWorkspace.id, filePath, enabled));
  };

  const handleOpenSkillFolder = (filePath: string) => {
    if (!selectedWorkspace) {
      return;
    }
    void api.openSkillInFinder(selectedWorkspace.id, filePath);
  };

  const handleTrySkill = (command: string) => {
    setActiveView("threads");
    fillComposerFromSlash(command);
  };

  const handleSetNotificationPreferences = (preferences: Partial<DesktopAppState["notificationPreferences"]>) => {
    void updateSnapshot(api, setSnapshot, () => api.setNotificationPreferences(preferences));
  };

  const handleWorkspaceRenameStart = (workspace: WorkspaceRecord) => {
    setWorkspaceMenuId(null);
    setWorkspaceRenameId(workspace.id);
    setWorkspaceRenameDraft(workspace.name);
  };

  const handleWorkspaceRenameSubmit = (workspace: WorkspaceRecord) => {
    const nextName = workspaceRenameDraft.trim();
    setWorkspaceMenuId(null);
    setWorkspaceRenameId(null);
    if (!nextName || nextName === workspace.name) {
      setWorkspaceRenameDraft("");
      return;
    }
    setWorkspaceRenameDraft("");
    void updateSnapshot(api, setSnapshot, () => api.renameWorkspace(workspace.id, nextName));
  };

  const handleWorkspaceRemove = (workspace: WorkspaceRecord) => {
    const confirmed = window.confirm(`Remove ${workspace.name} from pi-app? This will not delete any files.`);
    setWorkspaceMenuId(null);
    setWorkspaceRenameId(null);
    if (!confirmed) {
      return;
    }
    void updateSnapshot(api, setSnapshot, () => api.removeWorkspace(workspace.id));
  };

  const handleWorkspaceRenameCancel = () => {
    setWorkspaceRenameId(null);
    setWorkspaceRenameDraft("");
  };

  const handleTimelineScroll = () => {
    const pane = timelinePaneRef.current;
    if (!pane) {
      return;
    }

    const pinned = isNearBottom(pane);
    pinnedToBottomRef.current = pinned;
    if (pinned) {
      setShowJumpToLatest(false);
    }
  };

  const jumpToLatest = () => {
    const pane = timelinePaneRef.current;
    if (!pane) {
      return;
    }

    pane.scrollTop = pane.scrollHeight;
    pinnedToBottomRef.current = true;
    setShowJumpToLatest(false);
  };

  const focusComposer = () => {
    window.requestAnimationFrame(() => {
      composerRef.current?.focus();
    });
  };

  const closeSlashOptionMenu = () => {
    setSlashOptionCommand(undefined);
    setSlashOptionProviderId(undefined);
    setSlashOptionIndex(0);
  };

  const resetSlashUi = () => {
    closeSlashOptionMenu();
    setSlashMenuSuppressedDraft("");
  };

  const fillComposerFromSlash = (draft: string, options?: { suppressMenu?: boolean }) => {
    setComposerDraft(draft);
    setSlashMenuSuppressedDraft(options?.suppressMenu ? draft : "");
    focusComposer();
  };

  const openSlashOptionMenu = (command: ComposerSlashCommand) => {
    setSlashMenuSuppressedDraft("");
    setSlashOptionCommand(command);
    setSlashOptionProviderId(undefined);
    setSlashOptionIndex(0);
    setComposerDraft(command.command);
    focusComposer();
  };

  const applySlashCommandSelection = (
    command: ComposerSlashCommand,
    mode: "click" | "tab" | "enter",
  ) => {
    const submitMode = command.submitMode ?? "prefill";
    if (submitMode === "pick-option") {
      openSlashOptionMenu(command);
      return;
    }

    if (command.kind === "settings" || command.kind === "scoped-models") {
      resetSlashUi();
      setComposerDraft("");
      setActiveView("settings");
      return;
    }

    if (submitMode === "immediate") {
      if (mode === "enter") {
        resetSlashUi();
        setComposerDraft(command.command);
        void updateSnapshot(api, setSnapshot, () => api.submitComposer(command.command)).then((state) => {
          setComposerDraft(state.composerDraft);
        });
        return;
      }

      closeSlashOptionMenu();
      fillComposerFromSlash(command.command, { suppressMenu: true });
      return;
    }

    closeSlashOptionMenu();
    fillComposerFromSlash(command.template, { suppressMenu: true });
  };

  const applySlashOptionSelection = (option: ComposerSlashOption) => {
    if (!activeSlashOptionCommand || !selectedWorkspace) {
      return;
    }

    if (activeSlashOptionCommand.kind === "model" && !slashOptionProviderId) {
      setSlashOptionProviderId(option.value);
      setSlashOptionIndex(0);
      setComposerDraft(`${activeSlashOptionCommand.command} ${option.value}`);
      focusComposer();
      return;
    }

    if (activeSlashOptionCommand.kind === "model" && slashOptionProviderId) {
      resetSlashUi();
      setComposerDraft("");
      void updateSnapshot(api, setSnapshot, () =>
        api.submitComposer(`/model ${slashOptionProviderId} ${option.value}`),
      ).then((state) => {
        setComposerDraft(state.composerDraft);
      });
      return;
    }

    if (activeSlashOptionCommand.kind === "login") {
      resetSlashUi();
      setComposerDraft("");
      void updateSnapshot(api, setSnapshot, () => api.loginProvider(selectedWorkspace.id, option.value)).then((state) => {
        setComposerDraft(state.composerDraft);
      });
      return;
    }

    if (activeSlashOptionCommand.kind === "logout") {
      resetSlashUi();
      setComposerDraft("");
      void updateSnapshot(api, setSnapshot, () => api.logoutProvider(selectedWorkspace.id, option.value)).then((state) => {
        setComposerDraft(state.composerDraft);
      });
      return;
    }

    closeSlashOptionMenu();
    fillComposerFromSlash(`${activeSlashOptionCommand.command} ${option.value}`);
  };

  const runWorkspaceMenuAction = (
    event: ReactMouseEvent<HTMLElement>,
    action: () => void,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setWorkspaceMenuId(null);
    action();
  };

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && selectedSession?.status === "running") {
      event.preventDefault();
      submitComposerDraft();
      return;
    }

    if ((showSlashMenu || showSlashOptionMenu) && event.key === "Escape") {
      event.preventDefault();
      resetSlashUi();
      return;
    }

    if (showSlashOptionMenu && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      setSlashOptionIndex((current) => nextMenuIndex(current, event.key === "ArrowDown" ? 1 : -1, slashOptions.length));
      return;
    }

    if (showSlashOptionMenu && (event.key === "Tab" || event.key === "Enter") && selectedSlashOption) {
      event.preventDefault();
      applySlashOptionSelection(selectedSlashOption);
      return;
    }

    if (showSlashMenu && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      setSlashIndex((current) => nextMenuIndex(current, event.key === "ArrowDown" ? 1 : -1, slashSuggestions.length));
      return;
    }

    if (showSlashMenu && event.key === "Tab" && selectedSlashCommand) {
      event.preventDefault();
      applySlashCommandSelection(selectedSlashCommand, "tab");
      return;
    }

    if (showSlashMenu && event.key === "Enter" && selectedSlashCommand && !slashQuery.includes(" ")) {
      event.preventDefault();
      applySlashCommandSelection(selectedSlashCommand, "enter");
      return;
    }

    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }

    event.preventDefault();
    if (!composerDraft.trim() && composerAttachments.length === 0) {
      return;
    }

    submitComposerDraft();
  };

  const handleTopbarDoubleClick = (event: ReactMouseEvent<HTMLElement>) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    if (target.closest(".topbar__actions")) {
      return;
    }

    void api.toggleWindowMaximize();
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

          <div className="sidebar__nav">
            <button
              className={`sidebar__nav-item ${snapshot.activeView === "threads" ? "sidebar__nav-item--active" : ""}`}
              type="button"
              onClick={() => setActiveView("threads")}
            >
              <FolderIcon />
              <span>Threads</span>
            </button>
            <button
              className={`sidebar__nav-item ${snapshot.activeView === "skills" ? "sidebar__nav-item--active" : ""}`}
              type="button"
              onClick={() => setActiveView("skills")}
            >
              <SkillIcon />
              <span>Skills</span>
            </button>
            <button
              className={`sidebar__nav-item ${snapshot.activeView === "settings" ? "sidebar__nav-item--active" : ""}`}
              type="button"
              onClick={() => setActiveView("settings")}
            >
              <SettingsIcon />
              <span>Settings</span>
            </button>
          </div>
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
                    <div className={`workspace-row ${workspaceActive ? "workspace-row--active" : ""}`}>
                      <button
                        className="workspace-row__select"
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
                      <span
                        className="workspace-row__menu-wrap"
                        ref={workspaceMenuId === workspace.id ? workspaceMenuWrapRef : undefined}
                      >
                        <button
                          aria-label={`Workspace actions for ${workspace.name}`}
                          aria-haspopup="menu"
                          className="icon-button workspace-row__menu-button"
                          aria-expanded={workspaceMenuId === workspace.id}
                          type="button"
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            setWorkspaceMenuId((current) => (current === workspace.id ? null : workspace.id));
                          }}
                        >
                          …
                        </button>
                        {workspaceMenuId === workspace.id ? (
                          <div className="workspace-menu">
                            <button
                              className="workspace-menu__item"
                              type="button"
                              onClick={(event) =>
                                runWorkspaceMenuAction(event, () => {
                                  void api.openWorkspaceInFinder(workspace.id);
                                })
                              }
                            >
                              Open in Finder
                            </button>
                            <button
                              className="workspace-menu__item"
                              type="button"
                              onClick={(event) => runWorkspaceMenuAction(event, () => handleWorkspaceRenameStart(workspace))}
                            >
                              Edit name
                            </button>
                            <button
                              className="workspace-menu__item workspace-menu__item--danger"
                              type="button"
                              onClick={(event) => runWorkspaceMenuAction(event, () => handleWorkspaceRemove(workspace))}
                            >
                              Remove
                            </button>
                          </div>
                        ) : null}
                      </span>
                    </div>
                    {workspaceRenameId === workspace.id ? (
                      <form
                        className="workspace-rename"
                        ref={workspaceRenamePanelRef}
                        onSubmit={(event) => {
                          event.preventDefault();
                          handleWorkspaceRenameSubmit(workspace);
                        }}
                      >
                        <input
                          aria-label={`Rename ${workspace.name}`}
                          className="workspace-rename__input"
                          ref={workspaceRenameInputRef}
                          value={workspaceRenameDraft}
                          onChange={(event) => {
                            setWorkspaceRenameDraft(event.target.value);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Escape") {
                              event.preventDefault();
                              handleWorkspaceRenameCancel();
                            }
                          }}
                        />
                        <div className="workspace-rename__actions">
                          <button className="workspace-rename__button" type="button" onClick={handleWorkspaceRenameCancel}>
                            Cancel
                          </button>
                          <button className="workspace-rename__button workspace-rename__button--primary" type="submit">
                            Save
                          </button>
                        </div>
                      </form>
                    ) : null}
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
                              {active && session.preview ? (
                                <span className="session-row__preview">{session.preview}</span>
                              ) : null}
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
      </aside>

      <main className="main">
        <header className="topbar" data-testid="topbar" onDoubleClick={handleTopbarDoubleClick}>
          <div className="topbar__title">
            <span className="topbar__workspace">
              {selectedWorkspace ? selectedWorkspace.name : "Open a folder to begin"}
            </span>
            {selectedWorkspace && snapshot.activeView === "threads" && selectedSession ? (
              <>
                <span className="topbar__separator">/</span>
                <span className="topbar__session">{selectedSession.title}</span>
              </>
            ) : selectedWorkspace && snapshot.activeView !== "threads" ? (
              <>
                <span className="topbar__separator">/</span>
                <span className="topbar__session">
                  {snapshot.activeView === "skills" ? "Skills" : "Settings"}
                </span>
              </>
            ) : null}
          </div>

          <div className="topbar__actions">
            <button
              aria-label="Add folder"
              className="icon-button topbar__icon"
              type="button"
              onClick={() => {
                void updateSnapshot(api, setSnapshot, () => api.pickWorkspace());
              }}
            >
              <FolderIcon />
            </button>
          </div>
        </header>

        {snapshot.activeView === "skills" ? (
          <SkillsView
            workspace={selectedWorkspace}
            runtime={selectedRuntime}
            onOpenSkillFolder={handleOpenSkillFolder}
            onRefresh={handleRefreshRuntime}
            onToggleSkill={handleToggleSkill}
            onTrySkill={(skill) =>
              handleTrySkill(
                skill.filePath
                  ? `${skill.slashCommand} `
                  : "Create a new skill for this workspace and explain which files you will add.",
              )
            }
          />
        ) : snapshot.activeView === "settings" ? (
          <SettingsView
            workspace={selectedWorkspace}
            runtime={selectedRuntime}
            notificationPreferences={snapshot.notificationPreferences}
            onLoginProvider={handleLoginProvider}
            onLogoutProvider={handleLogoutProvider}
            onRefresh={handleRefreshRuntime}
            onSetDefaultModel={handleSetDefaultModel}
            onSetNotificationPreferences={handleSetNotificationPreferences}
            onSetScopedModelPatterns={handleSetScopedModelPatterns}
            onSetThinkingLevel={handleSetThinkingLevel}
            onToggleSkillCommands={handleToggleSkillCommands}
          />
        ) : selectedWorkspace && selectedSession ? (
          <>
            <section className="canvas">
              <div className="conversation">
                <div className="chat-header">
                  <div className="chat-header__eyebrow">{selectedWorkspace.name}</div>
                  <div className="chat-header__row">
                    <h1 className="chat-header__title">{selectedSession.title}</h1>
                    <div className="chat-header__status">
                      {selectedSession.status === "running" ? runningLabel : formatRelativeTime(selectedSession.updatedAt)}
                    </div>
                  </div>
                </div>

                {snapshot.lastError ? <div className="error-banner">{snapshot.lastError}</div> : null}

                <div className="timeline-pane" ref={timelinePaneRef} onScroll={handleTimelineScroll}>
                  <div className="timeline" data-testid="transcript">
                    {selectedSession.transcript.length === 0 ? (
                      <div className="timeline-empty">Send a prompt to start the session.</div>
                    ) : (
                      selectedSession.transcript.map((item) => (
                        <TimelineItem item={item} key={item.id} />
                      ))
                    )}
                  </div>
                  {showJumpToLatest ? (
                    <button className="timeline-jump" type="button" onClick={jumpToLatest}>
                      New activity below
                    </button>
                  ) : null}
                </div>
              </div>
            </section>

            <ComposerPanel
              attachments={composerAttachments}
              composerDraft={composerDraft}
              composerRef={composerRef}
              onComposerKeyDown={handleComposerKeyDown}
              onPickImages={handlePickImages}
              onRemoveImage={handleRemoveImage}
              onSelectSlashCommand={(command) => {
                applySlashCommandSelection(command, "click");
              }}
              onSelectSlashOption={(option) => {
                applySlashOptionSelection(option);
              }}
              onSubmit={submitComposerDraft}
              runningLabel={runningLabel}
              selectedSession={selectedSession}
              selectedSlashCommand={activeSlashOptionCommand ?? selectedSlashCommand}
              selectedSlashOption={selectedSlashOption}
              setComposerDraft={setComposerDraft}
              showSlashOptionMenu={showSlashOptionMenu}
              showSlashMenu={showSlashMenu}
              slashOptions={slashOptions}
              slashSections={slashSections}
            />
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

function isNearBottom(element: HTMLDivElement): boolean {
  const remaining = element.scrollHeight - element.scrollTop - element.clientHeight;
  return remaining < 32;
}
