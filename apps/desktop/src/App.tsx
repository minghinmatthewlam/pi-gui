import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type Dispatch, type DragEvent, type KeyboardEvent, type SetStateAction } from "react";
import type { RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import {
  getSelectedSession,
  getSelectedWorkspace,
  type AppView,
  type DesktopAppState,
  type WorktreeRecord,
  type WorkspaceRecord,
} from "./desktop-state";
import { formatRelativeTime } from "./string-utils";
import { ComposerPanel } from "./composer-panel";
import { DiffPanel } from "./diff-panel";
import type { ComposerSlashCommand } from "./composer-commands";
import { desktopCommands, getDesktopCommandFromShortcut, type PiDesktopCommand } from "./ipc";
import { SkillsView } from "./skills-view";
import { SettingsView, type SettingsSection } from "./settings-view";
import { TimelineItem } from "./timeline-item";
import { SecondarySurface } from "./secondary-surface";
import { NewThreadView } from "./new-thread-view";
import { buildThreadGroups } from "./thread-groups";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";
import { useSlashMenu } from "./hooks/use-slash-menu";
import { useMentionMenu } from "./hooks/use-mention-menu";
import { useWorkspaceMenu } from "./hooks/use-workspace-menu";

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

export default function App() {
  const [snapshot, setSnapshot] = useDesktopAppState();
  const [composerDraft, setComposerDraft] = useState("");
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const [settingsWorkspaceId, setSettingsWorkspaceId] = useState("");
  const [skillsWorkspaceId, setSkillsWorkspaceId] = useState("");
  const [newThreadRootWorkspaceId, setNewThreadRootWorkspaceId] = useState("");
  const [newThreadEnvironment, setNewThreadEnvironment] = useState<"local" | "new-worktree">("local");
  const [newThreadPrompt, setNewThreadPrompt] = useState("");
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const timelinePaneRef = useRef<HTMLDivElement | null>(null);
  const lastTranscriptMarkerRef = useRef("");
  const pinnedToBottomRef = useRef(true);
  const previousActiveViewRef = useRef<AppView | null>(null);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [showDiffPanel, setShowDiffPanel] = useState(false);
  const api = window.piApp;

  const selectedWorkspace = snapshot ? (getSelectedWorkspace(snapshot) ?? snapshot.workspaces[0]) : undefined;
  const selectedSession = snapshot ? (getSelectedSession(snapshot) ?? selectedWorkspace?.sessions[0]) : undefined;
  const {
    activeWorktrees,
    linkedWorktreeByWorkspaceId,
    rootWorkspace,
    rootWorkspaceOptions,
    visibleWorkspaces,
  } = useMemo(() => {
    if (!snapshot) {
      return {
        activeWorktrees: [] as readonly WorktreeRecord[],
        linkedWorktreeByWorkspaceId: new Map<string, WorktreeRecord>(),
        rootWorkspace: undefined as WorkspaceRecord | undefined,
        rootWorkspaceOptions: [] as readonly WorkspaceRecord[],
        visibleWorkspaces: [] as readonly WorkspaceRecord[],
      };
    }

    const workspacesById = new Map(snapshot.workspaces.map((workspace) => [workspace.id, workspace] as const));
    const primaryWorkspaces = snapshot.workspaces.filter((workspace) => workspace.kind === "primary");
    const orphanWorkspaces = snapshot.workspaces.filter(
      (workspace) => workspace.kind === "worktree" && !workspacesById.has(workspace.rootWorkspaceId ?? ""),
    );
    const nextVisibleWorkspaces =
      primaryWorkspaces.length > 0 ? [...primaryWorkspaces, ...orphanWorkspaces] : snapshot.workspaces;
    const nextLinkedWorktreeByWorkspaceId = new Map(
      Object.values(snapshot.worktreesByWorkspace)
        .flat()
        .filter((worktree) => Boolean(worktree.linkedWorkspaceId))
        .map((worktree) => [worktree.linkedWorkspaceId as string, worktree] as const),
    );
    const nextRootWorkspace =
      selectedWorkspace?.kind === "worktree"
        ? snapshot.workspaces.find((workspace) => workspace.id === selectedWorkspace.rootWorkspaceId) ?? selectedWorkspace
        : selectedWorkspace;

    return {
      activeWorktrees: nextRootWorkspace ? snapshot.worktreesByWorkspace[nextRootWorkspace.id] ?? [] : [],
      linkedWorktreeByWorkspaceId: nextLinkedWorktreeByWorkspaceId,
      rootWorkspace: nextRootWorkspace,
      rootWorkspaceOptions:
        primaryWorkspaces.length > 0
          ? primaryWorkspaces
          : nextVisibleWorkspaces.filter((workspace) => workspace.kind !== "worktree"),
      visibleWorkspaces: nextVisibleWorkspaces,
    };
  }, [selectedWorkspace, snapshot]);
  const selectedRuntime = selectedWorkspace ? snapshot?.runtimeByWorkspace[selectedWorkspace.id] : undefined;
  const selectedWorktree = selectedWorkspace ? linkedWorktreeByWorkspaceId.get(selectedWorkspace.id) : undefined;
  const settingsWorkspace = settingsWorkspaceId
    ? rootWorkspaceOptions.find((workspace) => workspace.id === settingsWorkspaceId)
    : undefined;
  const skillsWorkspace = skillsWorkspaceId
    ? rootWorkspaceOptions.find((workspace) => workspace.id === skillsWorkspaceId)
    : undefined;
  const settingsRuntime = settingsWorkspace ? snapshot?.runtimeByWorkspace[settingsWorkspace.id] : undefined;
  const skillsRuntime = skillsWorkspace ? snapshot?.runtimeByWorkspace[skillsWorkspace.id] : undefined;
  const composerAttachments = snapshot?.composerAttachments ?? [];
  const runningLabel = useRunningLabel(selectedSession?.status === "running" ? selectedSession.runningSince : undefined);
  const selectedSessionKey = `${selectedWorkspace?.id ?? ""}:${selectedSession?.id ?? ""}`;
  const persistedComposerDraft = snapshot?.composerDraft ?? "";
  const threadGroups = useMemo(
    () => (snapshot ? buildThreadGroups(snapshot) : []),
    [snapshot],
  );

  const focusComposer = () => {
    window.requestAnimationFrame(() => {
      composerRef.current?.focus();
    });
  };

  const openSettings = (workspaceId?: string, section?: SettingsSection) => {
    if (!api) {
      return;
    }
    const nextWorkspaceId =
      workspaceId && rootWorkspaceOptions.some((workspace) => workspace.id === workspaceId)
        ? workspaceId
        : settingsWorkspace?.id || rootWorkspaceOptions[0]?.id || "";
    if (nextWorkspaceId) {
      setSettingsWorkspaceId(nextWorkspaceId);
    }
    if (section) {
      setSettingsSection(section);
    }
    void updateSnapshot(api, setSnapshot, () => api.setActiveView("settings"));
  };

  const slashMenu = useSlashMenu({
    composerDraft,
    setComposerDraft,
    selectedRuntime,
    selectedSessionKey,
    selectedSession,
    selectedWorkspace,
    isRunning: selectedSession?.status === "running",
    api,
    setSnapshot,
    focusComposer,
    openSettings,
    updateSnapshot,
  });

  const mentionMenu = useMentionMenu({
    composerDraft,
    setComposerDraft,
    composerRef,
    workspaceId: selectedWorkspace?.id,
    api,
  });

  const wsMenu = useWorkspaceMenu({
    api,
    setSnapshot,
    updateSnapshot,
  });

  useEffect(() => {
    if (!snapshot) {
      return;
    }
    setComposerDraft(snapshot.composerDraft);
  }, [selectedSessionKey]);

  useEffect(() => {
    if (rootWorkspaceOptions.length === 0) {
      setSettingsWorkspaceId("");
      setSkillsWorkspaceId("");
      setNewThreadRootWorkspaceId("");
      return;
    }
    setSettingsWorkspaceId((current) =>
      rootWorkspaceOptions.some((workspace) => workspace.id === current) ? current : (current || rootWorkspaceOptions[0]?.id || ""),
    );
    setSkillsWorkspaceId((current) =>
      rootWorkspaceOptions.some((workspace) => workspace.id === current) ? current : (current || rootWorkspaceOptions[0]?.id || ""),
    );
    setNewThreadRootWorkspaceId((current) =>
      rootWorkspaceOptions.some((workspace) => workspace.id === current) ? current : (current || rootWorkspaceOptions[0]?.id || ""),
    );
  }, [rootWorkspaceOptions]);

  useEffect(() => {
    const handleCommand = (command: PiDesktopCommand) => {
      if (command === desktopCommands.openSettings) {
        openSettings(selectedWorkspace?.rootWorkspaceId ?? selectedWorkspace?.id);
      } else if (command === desktopCommands.openNewThread) {
        openNewThreadSurface(selectedWorkspace?.rootWorkspaceId ?? selectedWorkspace?.id);
      }
    };

    const removeCommandListener = window.piApp?.onCommand?.(handleCommand);
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      // Cmd+D toggles diff panel
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "d" && !event.shiftKey) {
        event.preventDefault();
        setShowDiffPanel((prev) => !prev);
        return;
      }
      const command = getDesktopCommandFromShortcut({
        modifier: event.metaKey || event.ctrlKey,
        shift: event.shiftKey,
        key: event.key,
        code: event.code,
      });
      if (command) {
        event.preventDefault();
        handleCommand(command);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      removeCommandListener?.();
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [selectedWorkspace?.id, selectedWorkspace?.rootWorkspaceId]);

  useEffect(() => {
    setShowJumpToLatest(false);
    lastTranscriptMarkerRef.current = "";
    pinnedToBottomRef.current = true;
  }, [selectedSessionKey]);

  useEffect(() => {
    if (!snapshot) {
      return;
    }

    if (
      snapshot.activeView === "threads" &&
      previousActiveViewRef.current !== "threads" &&
      selectedSession
    ) {
      focusComposer();
    }

    previousActiveViewRef.current = snapshot.activeView;
  }, [selectedSession, snapshot]);

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
          <div className="loading-card__eyebrow">pi-gui</div>
          <h1>Loading sessions</h1>
          <p>The desktop shell is restoring folder and thread state from the main process.</p>
        </main>
      </div>
    );
  }

  const setActiveView = (view: AppView) => {
    void updateSnapshot(api, setSnapshot, () => api.setActiveView(view));
  };

  const openSkills = (workspaceId?: string) => {
    const nextWorkspaceId =
      workspaceId && rootWorkspaceOptions.some((workspace) => workspace.id === workspaceId)
        ? workspaceId
        : skillsWorkspace?.id || rootWorkspaceOptions[0]?.id || "";
    if (nextWorkspaceId) {
      setSkillsWorkspaceId(nextWorkspaceId);
    }
    setActiveView("skills");
  };

  const openNewThreadSurface = (workspaceId?: string) => {
    const nextRootWorkspace =
      (workspaceId && rootWorkspaceOptions.find((workspace) => workspace.id === workspaceId)) ||
      rootWorkspace ||
      visibleWorkspaces[0];
    if (nextRootWorkspace) {
      setNewThreadRootWorkspaceId(nextRootWorkspace.id);
    }
    setNewThreadEnvironment("local");
    setNewThreadPrompt("");
    setActiveView("new-thread");
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

  const handleComposerPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const items = event.clipboardData?.items;
    if (!items) {
      return;
    }
    const imageItems = Array.from(items).filter((item) => item.type.startsWith("image/"));
    if (imageItems.length === 0) {
      return;
    }
    event.preventDefault();
    void addImagesFromFiles(imageItems.map((item) => item.getAsFile()).filter(Boolean) as File[]);
  };

  const handleComposerDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files).filter((file) => file.type.startsWith("image/"));
    if (files.length === 0) {
      return;
    }
    void addImagesFromFiles(files);
  };

  async function addImagesFromFiles(files: File[]) {
    if (!api) {
      return;
    }
    const attachments = await Promise.all(
      files.map(
        (file) =>
          new Promise<{ id: string; name: string; mimeType: string; data: string }>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => {
              const dataUrl = reader.result as string;
              const commaIndex = dataUrl.indexOf(",");
              resolve({
                id: crypto.randomUUID(),
                name: file.name || "pasted-image.png",
                mimeType: file.type || "image/png",
                data: dataUrl.slice(commaIndex + 1),
              });
            };
            reader.readAsDataURL(file);
          }),
      ),
    );
    void updateSnapshot(api, setSnapshot, () => api.addComposerImages(attachments));
  }

  const handleRefreshRuntime = () => {
    if (!settingsWorkspace) {
      return;
    }
    void updateSnapshot(api, setSnapshot, () => api.refreshRuntime(settingsWorkspace.id));
  };

  const handleSetDefaultModel = (provider: string, modelId: string) => {
    if (!settingsWorkspace) {
      return;
    }
    void updateSnapshot(api, setSnapshot, () => api.setDefaultModel(settingsWorkspace.id, provider, modelId));
  };

  const handleSetThinkingLevel = (thinkingLevel: RuntimeSnapshot["settings"]["defaultThinkingLevel"]) => {
    if (!settingsWorkspace) {
      return;
    }
    void updateSnapshot(api, setSnapshot, () => api.setDefaultThinkingLevel(settingsWorkspace.id, thinkingLevel));
  };

  const handleToggleSkillCommands = (enabled: boolean) => {
    if (!settingsWorkspace) {
      return;
    }
    void updateSnapshot(api, setSnapshot, () => api.setEnableSkillCommands(settingsWorkspace.id, enabled));
  };

  const handleSetScopedModelPatterns = (patterns: readonly string[]) => {
    if (!settingsWorkspace) {
      return;
    }
    void updateSnapshot(api, setSnapshot, () => api.setScopedModelPatterns(settingsWorkspace.id, patterns));
  };

  const handleLoginProvider = (providerId: string) => {
    if (!settingsWorkspace) {
      return;
    }
    void updateSnapshot(api, setSnapshot, () => api.loginProvider(settingsWorkspace.id, providerId));
  };

  const handleLogoutProvider = (providerId: string) => {
    if (!settingsWorkspace) {
      return;
    }
    void updateSnapshot(api, setSnapshot, () => api.logoutProvider(settingsWorkspace.id, providerId));
  };

  const handleToggleSkill = (filePath: string, enabled: boolean) => {
    if (!skillsWorkspace) {
      return;
    }
    void updateSnapshot(api, setSnapshot, () => api.setSkillEnabled(skillsWorkspace.id, filePath, enabled));
  };

  const handleOpenSkillFolder = (filePath: string) => {
    if (!skillsWorkspace) {
      return;
    }
    void api.openSkillInFinder(skillsWorkspace.id, filePath);
  };

  const handleTrySkill = (command: string) => {
    void updateSnapshot(api, setSnapshot, () => api.setActiveView("threads"));
    slashMenu.fillComposerFromSlash(command);
  };

  const handleSetNotificationPreferences = (preferences: Partial<DesktopAppState["notificationPreferences"]>) => {
    void updateSnapshot(api, setSnapshot, () => api.setNotificationPreferences(preferences));
  };

  const handleArchiveSession = (rootWorkspaceId: string, target: { workspaceId: string; sessionId: string }) => {
    wsMenu.toggleArchived(rootWorkspaceId, true);
    void updateSnapshot(api, setSnapshot, () => api.archiveSession(target));
  };

  const handleSelectSession = (target: { workspaceId: string; sessionId: string }) => {
    void updateSnapshot(api, setSnapshot, () => api.selectSession(target)).then(() => {
      focusComposer();
    });
  };

  const handleUnarchiveSession = (target: { workspaceId: string; sessionId: string }) => {
    void updateSnapshot(api, setSnapshot, () => api.unarchiveSession(target));
  };

  const handleStartThread = () => {
    if (!newThreadRootWorkspaceId) {
      return;
    }
    void updateSnapshot(api, setSnapshot, () =>
      api.startThread({
        rootWorkspaceId: newThreadRootWorkspaceId,
        environment: newThreadEnvironment,
        prompt: newThreadPrompt,
      }),
    ).then(() => {
      setNewThreadPrompt("");
      setNewThreadEnvironment("local");
    });
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

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && selectedSession?.status === "running") {
      event.preventDefault();
      submitComposerDraft();
      return;
    }

    if (mentionMenu.handleMentionKeyDown(event)) {
      return;
    }

    if (slashMenu.handleSlashKeyDown(event)) {
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

  const settingsNav = [
    { id: "general", label: "General" },
    { id: "providers", label: "Providers" },
    { id: "models", label: "Models" },
    { id: "notifications", label: "Notifications" },
  ] as const;

  if (snapshot.activeView === "settings") {
    return (
      <SecondarySurface
        activeNavId={settingsSection}
        navItems={settingsNav}
        onBack={() => setActiveView("threads")}
        onSelectNav={(section) => setSettingsSection(section as SettingsSection)}
        testId="settings-surface"
        title="Settings"
      >
        {settingsSection === "providers" || settingsSection === "models" ? (
          <div className="surface-toolbar">
            <label className="surface-toolbar__field">
              <span>Workspace</span>
              <select
                value={settingsWorkspace?.id ?? ""}
                onChange={(event) => setSettingsWorkspaceId(event.target.value)}
              >
                {rootWorkspaceOptions.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : null}
        <SettingsView
          workspace={settingsWorkspace}
          runtime={settingsRuntime}
          section={settingsSection}
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
      </SecondarySurface>
    );
  }

  if (snapshot.activeView === "skills") {
    return (
      <SecondarySurface onBack={() => setActiveView("threads")} testId="skills-surface" title="Skills">
        <div className="surface-toolbar">
          <label className="surface-toolbar__field">
            <span>Workspace</span>
            <select
              value={skillsWorkspace?.id ?? ""}
              onChange={(event) => setSkillsWorkspaceId(event.target.value)}
            >
              {rootWorkspaceOptions.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <SkillsView
          workspace={skillsWorkspace}
          runtime={skillsRuntime}
          onOpenSkillFolder={handleOpenSkillFolder}
          onRefresh={() => {
            if (!skillsWorkspace) {
              return;
            }
            void updateSnapshot(api, setSnapshot, () => api.refreshRuntime(skillsWorkspace.id));
          }}
          onToggleSkill={handleToggleSkill}
          onTrySkill={(skill) =>
            handleTrySkill(
              skill.filePath
                ? `${skill.slashCommand} `
                : "Create a new skill for this workspace and explain which files you will add.",
            )
          }
        />
      </SecondarySurface>
    );
  }

  return (
    <div className="shell">
      <Sidebar
        activeView={snapshot.activeView}
        selectedWorkspace={selectedWorkspace}
        selectedSession={selectedSession}
        visibleWorkspaces={visibleWorkspaces}
        threadGroups={threadGroups}
        linkedWorktreeByWorkspaceId={linkedWorktreeByWorkspaceId}
        wsMenu={wsMenu}
        api={api}
        setSnapshot={setSnapshot}
        updateSnapshot={updateSnapshot}
        onNewThread={() => openNewThreadSurface()}
        onSetActiveView={setActiveView}
        onOpenSkills={openSkills}
        onOpenSettings={openSettings}
        onArchiveSession={handleArchiveSession}
        onSelectSession={handleSelectSession}
        onUnarchiveSession={handleUnarchiveSession}
      />

      <main className={`main ${showDiffPanel ? "main--with-diff" : ""}`}>
        <Topbar
          activeView={snapshot.activeView}
          rootWorkspace={rootWorkspace}
          selectedWorkspace={selectedWorkspace}
          selectedSession={selectedSession}
          selectedWorktree={selectedWorktree}
          activeWorktrees={activeWorktrees}
          workspaces={snapshot.workspaces}
          wsMenu={wsMenu}
          api={api}
          setSnapshot={setSnapshot}
          updateSnapshot={updateSnapshot}
          showDiffPanel={showDiffPanel}
          onToggleDiffPanel={() => setShowDiffPanel((prev) => !prev)}
        />

        {snapshot.activeView === "new-thread" ? (
          rootWorkspaceOptions.length > 0 ? (
            <NewThreadView
              workspaces={rootWorkspaceOptions}
              selectedWorkspaceId={newThreadRootWorkspaceId || rootWorkspaceOptions[0]?.id || ""}
              runtime={
                (() => {
                  const workspace =
                    rootWorkspaceOptions.find((entry) => entry.id === newThreadRootWorkspaceId) ?? rootWorkspaceOptions[0];
                  return workspace ? snapshot.runtimeByWorkspace[workspace.id] : undefined;
                })()
              }
              environment={newThreadEnvironment}
              prompt={newThreadPrompt}
              onChangePrompt={setNewThreadPrompt}
              onSelectEnvironment={setNewThreadEnvironment}
              onSelectWorkspace={setNewThreadRootWorkspaceId}
              onSubmit={handleStartThread}
            />
          ) : (
            <section className="canvas canvas--empty">
              <div className="empty-panel">
                <div className="session-header__eyebrow">Workspace</div>
                <h1>Open a folder to start</h1>
                <p>Add a project folder before creating a new thread.</p>
              </div>
            </section>
          )
        ) : selectedWorkspace && selectedSession ? (
          <>
            <section className="canvas">
              <div className="conversation">
                <div className="chat-header">
                  <div className="chat-header__eyebrow">
                    {selectedWorkspace.kind === "worktree"
                      ? `${rootWorkspace?.name ?? selectedWorkspace.name} · ${selectedWorktree?.name ?? selectedWorkspace.branchName ?? "Worktree"}`
                      : `${selectedWorkspace.name} · Local`}
                  </div>
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
              activeSlashCommand={slashMenu.activeSlashFlow?.command}
              activeSlashCommandMeta={describeActiveSlashFlow(slashMenu.activeSlashFlow?.command)}
              attachments={composerAttachments}
              composerDraft={composerDraft}
              composerRef={composerRef}
              onClearSlashCommand={slashMenu.resetSlashUi}
              onComposerKeyDown={handleComposerKeyDown}
              onComposerPaste={handleComposerPaste}
              onComposerDrop={handleComposerDrop}
              onPickImages={handlePickImages}
              onRemoveImage={handleRemoveImage}
              onSelectSlashCommand={(command) => {
                slashMenu.applySlashCommandSelection(command, "click");
              }}
              onSelectSlashOption={(option) => {
                slashMenu.applySlashOptionSelection(option);
              }}
              onSubmit={submitComposerDraft}
              runningLabel={runningLabel}
              selectedSession={selectedSession}
              selectedSlashCommand={slashMenu.activeSlashOptionCommand ?? slashMenu.selectedSlashCommand}
              selectedSlashOption={slashMenu.selectedSlashOption}
              setComposerDraft={setComposerDraft}
              showSlashOptionMenu={slashMenu.showSlashOptionMenu}
              showSlashMenu={slashMenu.showSlashMenu}
              slashOptions={slashMenu.slashOptions}
              slashSections={slashMenu.slashSections}
              showMentionMenu={mentionMenu.showMentionMenu}
              mentionOptions={mentionMenu.mentionOptions}
              selectedMentionIndex={mentionMenu.selectedIndex}
              onSelectMention={(filePath) => {
                const textarea = composerRef.current;
                if (!textarea) {
                  return;
                }
                const cursorPos = textarea.selectionStart;
                const textBeforeCursor = composerDraft.slice(0, cursorPos);
                const atIndex = textBeforeCursor.lastIndexOf("@");
                if (atIndex < 0) {
                  return;
                }
                const before = composerDraft.slice(0, atIndex);
                const after = composerDraft.slice(cursorPos);
                const inserted = `@${filePath} `;
                setComposerDraft(`${before}${inserted}${after}`);
              }}
            />
            {showDiffPanel && selectedWorkspace ? (
              <DiffPanel
                workspaceId={selectedWorkspace.id}
                api={api}
                sessionStatus={selectedSession.status}
              />
            ) : null}
          </>
        ) : selectedWorkspace ? (
          <section className="canvas canvas--empty">
            <div className="empty-panel">
              <div className="session-header__eyebrow">Workspace</div>
              <h1>{selectedWorkspace.name}</h1>
              <p>Create a thread for this folder, then jump between sessions from the sidebar.</p>
              <div className="empty-panel__actions">
                <button
                  className="button button--primary"
                  type="button"
                  onClick={() => openNewThreadSurface()}
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

function describeActiveSlashFlow(
  command: ComposerSlashCommand | undefined,
): string | undefined {
  if (!command) {
    return undefined;
  }

  return command.description;
}

