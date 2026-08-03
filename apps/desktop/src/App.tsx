import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import {
  getSelectedSession,
  getSelectedWorkspace,
  type AppView,
} from "./desktop-state";
import { updateSnapshot, useDesktopAppState } from "./app/desktop-app-state";
import { buildFileWorkbenchContexts } from "./app/file-workbench-contexts";
import { canTogglePrimarySidebar, isEventInsideTerminal } from "./app/app-shell-utils";
import { useRunningLabel } from "./hooks/use-running-label";
import { useTimelineScroll, type SidePanelMode } from "./hooks/use-timeline-scroll";
import { formatRelativeTime } from "./string-utils";
import { restoreTopmostDialogFocus } from "./dialog-focus";
import { ComposerPanel } from "./composer-panel";
import { DiffPanel } from "./diff-panel";
import type { DiffPanelFileRequest } from "./diff-panel-types";
import { buildModelOptions } from "./composer-commands";
import {
  desktopCommands,
  getDesktopCommandFromShortcut,
  getDesktopShortcutLabel,
  type PiDesktopCommand,
} from "./ipc";
import { deriveModelOnboardingState } from "./model-onboarding";
import type { SettingsSection } from "./settings-view";
import { SecondarySurfaces } from "./app/secondary-surfaces";
import { NewThreadView } from "./new-thread-view";
import { DashboardView } from "./dashboard-view";
import { buildThreadGroups } from "./thread-groups";
import { Sidebar } from "./sidebar";
import { SidebarToggleButton } from "./sidebar-toggle-button";
import { Topbar } from "./topbar";
import { TerminalPanel } from "./terminal-panel";
import { ConversationTimeline } from "./conversation-timeline";
import { loadPromptRailVisible, savePromptRailVisible } from "./prompt-rail-store";
import { useSlashMenu } from "./hooks/use-slash-menu";
import { useMentionMenu } from "./hooks/use-mention-menu";
import { useThreadSearch } from "./hooks/use-thread-search";
import { useWorkspaceMenu } from "./hooks/use-workspace-menu";
import { useNewThreadController } from "./hooks/use-new-thread-controller";
import { buildExtensionDockModel, ExtensionDialog, hasExtensionDockContent } from "./extension-session-ui";
import { TreeModal } from "./tree-modal";
import { ForkModal } from "./fork-modal";
import { getEffectiveModelRuntime } from "./model-settings";
import { applyThemePresetToRoot } from "./theme-presets";
import { deriveWorkspaceContext } from "./workspace-context";
import { useTreeForkModals } from "./hooks/use-tree-fork-modals";
import { useComposerDraftSync } from "./hooks/use-composer-draft-sync";
import { useSessionComposer } from "./hooks/use-session-composer";

export default function App() {
  const [snapshot, setSnapshot, selectedTranscript] = useDesktopAppState();
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const [settingsWorkspaceId, setSettingsWorkspaceId] = useState("");
  const [skillsWorkspaceId, setSkillsWorkspaceId] = useState("");
  const [extensionsWorkspaceId, setExtensionsWorkspaceId] = useState("");
  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">("light");
  const [dockExpandedBySession, setDockExpandedBySession] = useState<Record<string, boolean>>({});
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const timelinePaneRef = useRef<HTMLDivElement | null>(null);
  const previousActiveViewRef = useRef<AppView | null>(null);
  const [dismissedSchemaSkewSessionKeys, setDismissedSchemaSkewSessionKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [sidePanelMode, setSidePanelMode] = useState<SidePanelMode | null>(null);
  const [openTerminalSessionKey, setOpenTerminalSessionKey] = useState("");
  const [takeoverTerminalSessionKey, setTakeoverTerminalSessionKey] = useState("");
  const [terminalHeight, setTerminalHeight] = useState(340);
  const [diffFileRequest, setDiffFileRequest] = useState<DiffPanelFileRequest | null>(null);
  const [promptRailVisible, setPromptRailVisible] = useState(loadPromptRailVisible);
  const threadSearch = useThreadSearch(timelinePaneRef);
  const api = window.piApp;
  const sidebarToggleStateRef = useRef<{
    readonly api: typeof window.piApp;
    readonly activeView: AppView | undefined;
    readonly sidebarCollapsed: boolean;
  }>({
    api,
    activeView: undefined,
    sidebarCollapsed: false,
  });
  sidebarToggleStateRef.current = {
    api,
    activeView: snapshot?.activeView,
    sidebarCollapsed: snapshot?.sidebarCollapsed ?? false,
  };

  useEffect(() => {
    const piApi = window.piApp;
    if (!piApi) return;

    void piApi.getResolvedTheme().then((theme) => {
      setResolvedTheme(theme);
      document.documentElement.classList.toggle("dark", theme === "dark");
    });

    const unsub = piApi.onThemeChanged((theme) => {
      setResolvedTheme(theme);
      document.documentElement.classList.toggle("dark", theme === "dark");
    });

    return unsub;
  }, []);

  useEffect(() => {
    applyThemePresetToRoot(document.documentElement, snapshot?.themePresetId ?? "default", resolvedTheme);
  }, [resolvedTheme, snapshot?.themePresetId]);

  useEffect(() => {
    if (snapshot) {
      document.documentElement.classList.toggle("enable-transparency", snapshot.enableTransparency);
    }
  }, [snapshot?.enableTransparency]);

  const {
    activeWorktrees,
    linkedWorktreeByWorkspaceId,
    rootWorkspace,
    rootWorkspaceOptions,
    selectedWorkspace,
    visibleWorkspaces,
  } = useMemo(() => deriveWorkspaceContext(snapshot), [snapshot]);
  const selectedSession = snapshot ? (getSelectedSession(snapshot) ?? selectedWorkspace?.sessions[0]) : undefined;
  const selectedRuntime = selectedWorkspace ? snapshot?.runtimeByWorkspace[selectedWorkspace.id] : undefined;
  const selectedModelRuntime = snapshot ? getEffectiveModelRuntime(snapshot, selectedWorkspace) : undefined;
  const selectedWorktree = selectedWorkspace ? linkedWorktreeByWorkspaceId.get(selectedWorkspace.id) : undefined;
  const selectedDefaultEnabled = buildModelOptions(selectedModelRuntime).some(
    (m) => m.providerId === selectedModelRuntime?.settings.defaultProvider && m.modelId === selectedModelRuntime?.settings.defaultModelId,
  );
  const resolvedSessionProvider =
    selectedSession?.config?.provider ??
    (selectedDefaultEnabled ? selectedModelRuntime?.settings.defaultProvider : undefined);
  const resolvedSessionModelId =
    selectedSession?.config?.modelId ??
    (selectedDefaultEnabled ? selectedModelRuntime?.settings.defaultModelId : undefined);
  const resolvedSessionThinkingLevel =
    selectedSession?.config?.thinkingLevel ?? selectedModelRuntime?.settings.defaultThinkingLevel;
  const selectedSessionModelOnboarding = deriveModelOnboardingState(selectedModelRuntime, {
    provider: resolvedSessionProvider,
    modelId: resolvedSessionModelId,
  });
  const queuedComposerMessages = snapshot?.queuedComposerMessages ?? [];
  const editingQueuedMessageId = snapshot?.editingQueuedMessageId;
  const runningLabel = useRunningLabel(selectedSession?.status === "running" ? selectedSession.runningSince : undefined);
  const selectedSessionKey = selectedWorkspace && selectedSession ? `${selectedWorkspace.id}:${selectedSession.id}` : "";
  const { composerDraft, setComposerDraft, composerDraftRef, flushComposerDraft } = useComposerDraftSync({
    api,
    snapshot,
    selectedSessionKey,
  });
  const isTerminalVisibleForSelectedThread = Boolean(selectedSessionKey) && openTerminalSessionKey === selectedSessionKey;
  const isTerminalTakeoverForSelectedThread = Boolean(selectedSessionKey) && takeoverTerminalSessionKey === selectedSessionKey;
  const selectedTranscriptForSession =
    selectedTranscript &&
    selectedWorkspace &&
    selectedSession &&
    selectedTranscript.workspaceId === selectedWorkspace.id &&
    selectedTranscript.sessionId === selectedSession.id
      ? selectedTranscript
      : null;
  const activeTranscript = selectedTranscriptForSession?.transcript ?? [];
  const isTranscriptLoading = Boolean(selectedSession) && !selectedTranscriptForSession;
  const {
    setTimelinePaneElement,
    disableTimelineVirtualization,
    finalizeTimelineVirtualizationDisable,
    handleTimelineScroll,
    handleTimelineScrollIntent,
    handleTimelineContentHeightChange,
    showJumpToLatest,
    jumpToLatest,
    saveCurrentTimelineScrollState,
    beginPreserveTimelineBottom,
    schedulePinnedBottomRealignment,
  } = useTimelineScroll({
    selectedSessionKey,
    activeTranscript,
    selectedSession,
    selectedTranscriptForSession,
    activeView: snapshot?.activeView,
    sidePanelMode,
    composerRef,
    composerDraft,
    timelinePaneRef,
  });
  const showSchemaSkewNotice =
    selectedTranscriptForSession?.schemaInfo?.writtenByNewerRuntime === true &&
    Boolean(selectedSessionKey) &&
    !dismissedSchemaSkewSessionKeys.has(selectedSessionKey);
  const selectedSessionCommands = selectedSession ? snapshot?.sessionCommandsBySession[selectedSessionKey] ?? [] : [];
  const selectedExtensionUi = selectedSession ? snapshot?.sessionExtensionUiBySession[selectedSessionKey] : undefined;
  const selectedWorkspaceCommandCompatibility = selectedWorkspace
    ? snapshot?.extensionCommandCompatibilityByWorkspace[selectedWorkspace.id] ?? []
    : [];
  const fileWorkbenchContexts = useMemo(
    () =>
      buildFileWorkbenchContexts({
        workspaces: snapshot?.workspaces ?? [],
        selectedWorkspace,
        selectedSessionTitle: selectedExtensionUi?.title || selectedSession?.title,
        rootWorkspace,
        activeWorktrees,
      }),
    [
      activeWorktrees,
      rootWorkspace,
      selectedExtensionUi?.title,
      selectedSession?.title,
      selectedWorkspace,
      snapshot?.workspaces,
    ],
  );
  useEffect(() => {
    if (snapshot && snapshot.workspaces.length === 0) {
      setOpenTerminalSessionKey("");
      setTakeoverTerminalSessionKey("");
    }
  }, [snapshot]);
  useEffect(() => {
    setOpenTerminalSessionKey("");
    setTakeoverTerminalSessionKey("");
  }, [selectedSessionKey]);
  const selectedExtensionDock = useMemo(() => buildExtensionDockModel(selectedExtensionUi), [selectedExtensionUi]);
  const displayedSessionTitle = selectedExtensionUi?.title ?? selectedSession?.title ?? "";
  const activeExtensionDialog = selectedExtensionUi?.pendingDialogs[0];
  const isSelectedExtensionDockExpanded = dockExpandedBySession[selectedSessionKey] ?? false;
  const threadGroups = useMemo(
    () => (snapshot ? buildThreadGroups(snapshot) : []),
    [snapshot?.workspaces, snapshot?.worktreesByWorkspace, snapshot?.workspaceOrder],
  );
  const focusComposer = () => {
    window.requestAnimationFrame(() => {
      if (restoreTopmostDialogFocus()) {
        return;
      }
      composerRef.current?.focus();
    });
  };
  const toggleTerminal = useCallback(() => {
    if (!selectedSessionKey) {
      return;
    }
    if (openTerminalSessionKey === selectedSessionKey) {
      setOpenTerminalSessionKey("");
      setTakeoverTerminalSessionKey("");
      return;
    }
    setOpenTerminalSessionKey(selectedSessionKey);
  }, [openTerminalSessionKey, selectedSessionKey]);
  const handleViewFileInDiff = useCallback((path: string) => {
    setSidePanelMode("changes");
    setDiffFileRequest({ path, nonce: Date.now() });
  }, []);

  const dismissSchemaSkewNotice = useCallback((sessionKey: string) => {
    setDismissedSchemaSkewSessionKeys((current) => {
      if (current.has(sessionKey)) {
        return current;
      }
      const next = new Set(current);
      next.add(sessionKey);
      return next;
    });
  }, []);

  const toggleSidePanelMode = useCallback((mode: SidePanelMode) => {
    const shouldPreserveBottom = beginPreserveTimelineBottom();

    setSidePanelMode((current) => (current === mode ? null : mode));

    if (!shouldPreserveBottom) {
      return;
    }

    schedulePinnedBottomRealignment(3);
  }, [beginPreserveTimelineBottom, schedulePinnedBottomRealignment]);

  const toggleChangesPanel = useCallback(() => {
    toggleSidePanelMode("changes");
  }, [toggleSidePanelMode]);

  const toggleFilesPanel = useCallback(() => {
    toggleSidePanelMode("files");
  }, [toggleSidePanelMode]);

  const togglePromptRail = useCallback(() => {
    setPromptRailVisible((current) => {
      const next = !current;
      savePromptRailVisible(next);
      return next;
    });
  }, []);

  const openSettings = (workspaceId?: string, section?: SettingsSection) => {
    if (!api) {
      return;
    }
    const nextWorkspaceId =
      workspaceId && rootWorkspaceOptions.some((workspace) => workspace.id === workspaceId)
        ? workspaceId
        : settingsWorkspaceId || rootWorkspaceOptions[0]?.id || "";
    if (nextWorkspaceId) {
      setSettingsWorkspaceId(nextWorkspaceId);
    }
    if (section) {
      setSettingsSection(section);
    }
    void updateSnapshot(api, setSnapshot, () => api.setActiveView("settings"));
  };

  const {
    treeModalState,
    forkModalState,
    closeTreeModal,
    openTreeModal,
    navigateTreeSelection,
    closeForkModal,
    openForkModal,
    handleForkSubmit,
    canUseWorktree,
  } = useTreeForkModals({
    api,
    snapshot,
    setSnapshot,
    selectedWorkspace,
    selectedSession,
    selectedSessionKey,
    rootWorkspace,
    activeView: snapshot?.activeView,
    setComposerDraft,
    focusComposer,
  });

  const slashMenu = useSlashMenu({
    composerDraft,
    setComposerDraft,
    selectedRuntime,
    selectedModelRuntime,
    sessionCommands: selectedSessionCommands,
    commandCompatibility: selectedWorkspaceCommandCompatibility,
    selectedSessionKey,
    selectedSession,
    selectedWorkspace,
    isRunning: selectedSession?.status === "running",
    api,
    setSnapshot,
    focusComposer,
    openSettings,
    updateSnapshot,
    allowTreeCommand: true,
    onRunTreeCommand: openTreeModal,
  });

  const enableSelectedMentionExtension = useCallback(
    (filePath: string) => {
      if (!api || !selectedWorkspace) {
        return Promise.resolve();
      }
      return updateSnapshot(api, setSnapshot, () => api.setExtensionEnabled(selectedWorkspace.id, filePath, true)).then(
        () => undefined,
      );
    },
    [api, selectedWorkspace],
  );

  const mentionMenu = useMentionMenu({
    composerDraft,
    setComposerDraft,
    composerRef,
    workspaceId: selectedWorkspace?.id,
    runtime: selectedRuntime,
    api,
    onEnableExtension: enableSelectedMentionExtension,
  });

  const wsMenu = useWorkspaceMenu({
    api,
    setSnapshot,
    updateSnapshot,
  });

  const newThread = useNewThreadController({
    api,
    snapshot,
    setSnapshot,
    rootWorkspace,
    rootWorkspaceOptions,
    visibleWorkspaces,
    selectedWorkspace,
    expandWorkspace: wsMenu.expandWorkspace,
    openSettings,
  });

  const {
    composerAttachments,
    submitComposerDraft,
    handlePickAttachments,
    handleRemoveAttachment,
    handleEditQueuedMessage,
    handleCancelQueuedEdit,
    handleRemoveQueuedMessage,
    handleSteerQueuedMessage,
    handleComposerPaste,
    handleComposerDrop,
    handlePastedClipboardImage,
    handleComposerKeyDown,
  } = useSessionComposer({
    api,
    snapshot,
    setSnapshot,
    selectedSession,
    composerDraft,
    setComposerDraft,
    composerDraftRef,
    composerRef,
    requiresModelSelection: selectedSessionModelOnboarding.requiresModelSelection,
    openTreeModal,
    handleMentionKeyDown: mentionMenu.handleMentionKeyDown,
    handleSlashKeyDown: slashMenu.handleSlashKeyDown,
    newThreadComposerRef: newThread.composerRef,
    appendNewThreadAttachment: newThread.appendAttachment,
  });

  useEffect(() => {
    const sessionExtensionUiBySession = snapshot?.sessionExtensionUiBySession;
    if (!sessionExtensionUiBySession) {
      setDockExpandedBySession((current) => (Object.keys(current).length > 0 ? {} : current));
      return;
    }

    setDockExpandedBySession((current) => {
      let next: Record<string, boolean> | undefined;
      for (const [sessionKey, expanded] of Object.entries(current)) {
        if (!expanded && sessionExtensionUiBySession[sessionKey]) {
          continue;
        }
        if (hasExtensionDockContent(sessionExtensionUiBySession[sessionKey])) {
          continue;
        }
        if (!next) {
          next = { ...current };
        }
        delete next[sessionKey];
      }
      return next ?? current;
    });
  }, [snapshot?.sessionExtensionUiBySession]);

  useEffect(() => {
    if (rootWorkspaceOptions.length === 0) {
      setSettingsWorkspaceId("");
      setSkillsWorkspaceId("");
      setExtensionsWorkspaceId("");
      return;
    }
    setSettingsWorkspaceId((current) =>
      rootWorkspaceOptions.some((workspace) => workspace.id === current) ? current : (current || rootWorkspaceOptions[0]?.id || ""),
    );
    setSkillsWorkspaceId((current) =>
      rootWorkspaceOptions.some((workspace) => workspace.id === current) ? current : (current || rootWorkspaceOptions[0]?.id || ""),
    );
    setExtensionsWorkspaceId((current) =>
      rootWorkspaceOptions.some((workspace) => workspace.id === current) ? current : (current || rootWorkspaceOptions[0]?.id || ""),
    );
  }, [rootWorkspaceOptions]);

  const primarySidebarToggleVisible = canTogglePrimarySidebar(snapshot?.activeView);
  const handleTogglePrimarySidebar = useCallback(() => {
    const sidebarState = sidebarToggleStateRef.current;
    const sidebarApi = sidebarState.api;
    if (!sidebarApi || !canTogglePrimarySidebar(sidebarState.activeView)) {
      return false;
    }
    void updateSnapshot(sidebarApi, setSnapshot, () => sidebarApi.setSidebarCollapsed(!sidebarState.sidebarCollapsed));
    return true;
  }, []);
  const sidebarToggleShortcutLabel = api ? getDesktopShortcutLabel(api.platform, "B") : "";

  useEffect(() => {
    const handleCommand = (command: PiDesktopCommand): boolean => {
      if (command === desktopCommands.openSettings) {
        openSettings(selectedWorkspace?.rootWorkspaceId ?? selectedWorkspace?.id);
        return true;
      } else if (command === desktopCommands.openNewThread) {
        newThread.openSurface(selectedWorkspace?.rootWorkspaceId ?? selectedWorkspace?.id);
        return true;
      } else if (command === desktopCommands.toggleTerminal) {
        toggleTerminal();
        return true;
      } else if (command === desktopCommands.toggleSidebar) {
        return handleTogglePrimarySidebar();
      }
      return false;
    };

    const removeCommandListener = window.piApp?.onCommand?.(handleCommand);
    const removeWorkspacePickedListener = window.piApp?.onWorkspacePicked?.((workspaceId) => {
      newThread.setPendingWorkspaceId(workspaceId);
      newThread.resetSurface();
    });
    const removeClipboardImageListener = window.piApp?.onClipboardImagePasted?.(handlePastedClipboardImage);
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (isEventInsideTerminal(event)) {
        const command = getDesktopCommandFromShortcut({
          modifier: event.metaKey || event.ctrlKey,
          shift: event.shiftKey,
          key: event.key,
          code: event.code,
        });
        if (command === desktopCommands.toggleTerminal) {
          event.preventDefault();
          handleCommand(command);
        }
        return;
      }
      // Cmd+F toggles thread search
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f" && !event.shiftKey) {
        event.preventDefault();
        if (threadSearch.isOpen) {
          threadSearch.close();
        } else {
          threadSearch.open();
        }
        return;
      }
      // Cmd+D toggles diff panel
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "d" && !event.shiftKey) {
        event.preventDefault();
        toggleChangesPanel();
        return;
      }
      const command = getDesktopCommandFromShortcut({
        modifier: event.metaKey || event.ctrlKey,
        shift: event.shiftKey,
        key: event.key,
        code: event.code,
      });
      if (command && handleCommand(command)) {
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      removeCommandListener?.();
      removeWorkspacePickedListener?.();
      removeClipboardImageListener?.();
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [
    selectedWorkspace?.id,
    selectedWorkspace?.rootWorkspaceId,
    threadSearch,
    api,
    toggleChangesPanel,
    toggleTerminal,
    handleTogglePrimarySidebar,
    newThread,
  ]);

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
  }, [selectedSession, selectedWorkspace?.id, snapshot]);

  const sidePanelAvailable = snapshot?.activeView === "threads" && Boolean(selectedWorkspace && selectedSession);
  useEffect(() => {
    if (!sidePanelAvailable) {
      setSidePanelMode(null);
    }
  }, [sidePanelAvailable, selectedSessionKey]);

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

  const showTerminalTakeover = isTerminalVisibleForSelectedThread && isTerminalTakeoverForSelectedThread && Boolean(selectedWorkspace);
  const secondarySurfaceView =
    snapshot.activeView === "settings" || snapshot.activeView === "skills" || snapshot.activeView === "extensions"
      ? snapshot.activeView
      : null;
  const mainClassName = [
    "main",
    sidePanelMode ? "main--with-side-panel" : "",
    sidePanelMode ? "main--with-diff" : "",
    isTerminalVisibleForSelectedThread ? "main--with-terminal" : "",
    showTerminalTakeover ? "main--terminal-takeover" : "",
    snapshot.startupDiagnostics.length > 0 ? "main--with-startup-diagnostics" : "",
  ].filter(Boolean).join(" ");
  const terminalPanel = isTerminalVisibleForSelectedThread && selectedWorkspace ? (
    <TerminalPanel
      workspace={selectedWorkspace}
      sessionId={selectedSession?.id ?? ""}
      height={terminalHeight}
      isTakeover={isTerminalTakeoverForSelectedThread}
      onHeightChange={(nextHeight) => {
        setTerminalHeight(nextHeight);
        setTakeoverTerminalSessionKey((current) => (current === selectedSessionKey ? "" : current));
      }}
      onToggleTakeover={() => {
        setTakeoverTerminalSessionKey((current) => (current === selectedSessionKey ? "" : selectedSessionKey));
      }}
      onHide={() => {
        setOpenTerminalSessionKey((current) => (current === selectedSessionKey ? "" : current));
        setTakeoverTerminalSessionKey((current) => (current === selectedSessionKey ? "" : current));
        focusComposer();
      }}
    />
  ) : null;

  const setActiveView = (view: AppView) => {
    void updateSnapshot(api, setSnapshot, () => api.setActiveView(view));
  };

  const openSkills = (workspaceId?: string) => {
    const nextWorkspaceId =
      workspaceId && rootWorkspaceOptions.some((workspace) => workspace.id === workspaceId)
        ? workspaceId
        : skillsWorkspaceId || rootWorkspaceOptions[0]?.id || "";
    if (nextWorkspaceId) {
      setSkillsWorkspaceId(nextWorkspaceId);
    }
    setActiveView("skills");
  };

  const openExtensions = (workspaceId?: string) => {
    const nextWorkspaceId =
      workspaceId && rootWorkspaceOptions.some((workspace) => workspace.id === workspaceId)
        ? workspaceId
        : extensionsWorkspaceId || rootWorkspaceOptions[0]?.id || "";
    if (nextWorkspaceId) {
      setExtensionsWorkspaceId(nextWorkspaceId);
    }
    setActiveView("extensions");
  };

  const handleSetSessionModel = (provider: string, modelId: string) => {
    if (!selectedWorkspace || !selectedSession) {
      return;
    }
    void updateSnapshot(api, setSnapshot, () =>
      api.setSessionModel(selectedWorkspace.id, selectedSession.id, provider, modelId),
    );
  };

  const handleSetSessionThinking = (level: string) => {
    if (!selectedWorkspace || !selectedSession) {
      return;
    }
    void updateSnapshot(api, setSnapshot, () =>
      api.setSessionThinkingLevel(
        selectedWorkspace.id,
        selectedSession.id,
        level as NonNullable<RuntimeSnapshot["settings"]["defaultThinkingLevel"]>,
      ),
    );
  };

  const handleTrySkill = (command: string) => {
    void updateSnapshot(api, setSnapshot, () => api.setActiveView("threads"));
    slashMenu.fillComposerFromSlash(command);
  };

  const handleArchiveSession = (target: { workspaceId: string; sessionId: string }) => {
    void updateSnapshot(api, setSnapshot, () => api.archiveSession(target));
  };

  const handleSelectSession = (target: { workspaceId: string; sessionId: string }) => {
    // Flush any debounced draft write before the active session changes, otherwise the pending
    // write for the current session is lost (and would land on the wrong session if deferred).
    flushComposerDraft();
    saveCurrentTimelineScrollState();
    setOpenTerminalSessionKey("");
    setTakeoverTerminalSessionKey("");
    void updateSnapshot(api, setSnapshot, () => api.selectSession(target)).then(() => {
      focusComposer();
    });
  };

  const handleRespondToExtensionDialog = (
    response:
      | { readonly requestId: string; readonly value: string }
      | { readonly requestId: string; readonly confirmed: boolean }
      | { readonly requestId: string; readonly cancelled: true },
  ) => {
    if (!selectedWorkspace || !selectedSession) {
      return;
    }

    void updateSnapshot(api, setSnapshot, () =>
      api.respondToHostUiRequest(selectedWorkspace.id, selectedSession.id, response),
    ).then(() => {
      focusComposer();
    });
  };

  const handleToggleExtensionDock = () => {
    if (!selectedExtensionDock) {
      return;
    }

    setDockExpandedBySession((current) => ({
      ...current,
      [selectedSessionKey]: !(current[selectedSessionKey] ?? false),
    }));
  };

  const handleUnarchiveSession = (target: { workspaceId: string; sessionId: string }) => {
    void updateSnapshot(api, setSnapshot, () => api.unarchiveSession(target));
  };

  const handleSetSessionPinned = (target: { workspaceId: string; sessionId: string }, pinned: boolean) => {
    void updateSnapshot(api, setSnapshot, () => api.setSessionPinned(target, pinned));
  };

  if (secondarySurfaceView) {
    return (
      <SecondarySurfaces
        api={api}
        snapshot={snapshot}
        setSnapshot={setSnapshot}
        activeView={secondarySurfaceView}
        rootWorkspaceOptions={rootWorkspaceOptions}
        settingsSection={settingsSection}
        onSelectSettingsSection={setSettingsSection}
        settingsWorkspaceId={settingsWorkspaceId}
        onSelectSettingsWorkspace={setSettingsWorkspaceId}
        skillsWorkspaceId={skillsWorkspaceId}
        onSelectSkillsWorkspace={setSkillsWorkspaceId}
        extensionsWorkspaceId={extensionsWorkspaceId}
        onSelectExtensionsWorkspace={setExtensionsWorkspaceId}
        onBack={() => setActiveView("threads")}
        onTrySkill={handleTrySkill}
      />
    );
  }

  const shellClassName = `shell${snapshot.sidebarCollapsed ? " shell--sidebar-collapsed" : ""}`;

  return (
    <div className={shellClassName}>
      {primarySidebarToggleVisible ? (
        <SidebarToggleButton
          collapsed={snapshot.sidebarCollapsed}
          shortcutLabel={sidebarToggleShortcutLabel}
          onToggle={handleTogglePrimarySidebar}
        />
      ) : null}
      {!snapshot.sidebarCollapsed ? (
        <Sidebar
          activeView={snapshot.activeView}
          selectedWorkspace={selectedWorkspace}
          selectedSession={selectedSession}
          visibleWorkspaces={visibleWorkspaces}
          threadGroups={threadGroups}
          pinnedSessionOrder={snapshot.pinnedSessionOrder}
          linkedWorktreeByWorkspaceId={linkedWorktreeByWorkspaceId}
          wsMenu={wsMenu}
          api={api}
          setSnapshot={setSnapshot}
          updateSnapshot={updateSnapshot}
          onNewThread={() => newThread.openSurface(selectedWorkspace?.rootWorkspaceId ?? selectedWorkspace?.id)}
          onSetActiveView={setActiveView}
          onOpenSkills={openSkills}
          onOpenExtensions={openExtensions}
          onOpenSettings={openSettings}
          onArchiveSession={handleArchiveSession}
          onSelectSession={handleSelectSession}
          onSetSessionPinned={handleSetSessionPinned}
          onUnarchiveSession={handleUnarchiveSession}
        />
      ) : null}

      <main className={mainClassName}>
        <Topbar
          activeView={snapshot.activeView}
          rootWorkspace={rootWorkspace}
          selectedWorkspace={selectedWorkspace}
          selectedSession={selectedSession}
          selectedSessionTitle={displayedSessionTitle || selectedSession?.title}
          selectedWorktree={selectedWorktree}
          activeWorktrees={activeWorktrees}
          workspaces={snapshot.workspaces}
          wsMenu={wsMenu}
          api={api}
          terminalAvailable={Boolean(selectedSessionKey)}
          terminalVisible={isTerminalVisibleForSelectedThread}
          onToggleTerminal={toggleTerminal}
          panelAvailable={sidePanelAvailable}
          changesVisible={sidePanelMode === "changes"}
          onToggleChanges={toggleChangesPanel}
          filesVisible={sidePanelMode === "files"}
          onToggleFiles={toggleFilesPanel}
          promptRailVisible={promptRailVisible}
          onTogglePromptRail={togglePromptRail}
        />

        {snapshot.startupDiagnostics.length > 0 ? (
          <div className="startup-diagnostics" role="status" data-testid="startup-diagnostics">
            <strong>Some saved workspaces could not be refreshed.</strong>
            <span>
              {snapshot.startupDiagnostics
                .map((diagnostic) => {
                  const workspaceName = diagnostic.workspacePath?.split(/[\\/]/).filter(Boolean).at(-1);
                  return workspaceName ? `${workspaceName} is unavailable.` : diagnostic.message;
                })
                .join(" ")}
            </span>
          </div>
        ) : null}

        {showTerminalTakeover ? (
          terminalPanel
        ) : (
          <>
        {snapshot.activeView === "dashboard" ? (
          <DashboardView
            workspaces={snapshot.workspaces}
            onOpenSession={(workspaceId, sessionId) => {
              void updateSnapshot(api, setSnapshot, () => api.selectSession({ workspaceId, sessionId }));
              setActiveView("threads");
            }}
          />
        ) : snapshot.activeView === "new-thread" ? (
          rootWorkspaceOptions.length > 0 ? (
            <NewThreadView
              workspaces={rootWorkspaceOptions}
              selectedWorkspaceId={newThread.rootWorkspaceId || rootWorkspaceOptions[0]?.id || ""}
              runtime={newThread.runtime}
              environment={newThread.environment}
              prompt={newThread.prompt}
              attachments={newThread.attachments}
              lastError={newThread.composerError}
              provider={newThread.resolvedProvider}
              modelId={newThread.resolvedModelId}
              thinkingLevel={newThread.resolvedThinkingLevel}
              modelOnboarding={newThread.modelOnboarding}
              composerRef={newThread.composerRef}
              activeSlashCommand={newThread.slashMenu.activeSlashFlow?.command}
              activeSlashCommandMeta={newThread.slashMenu.activeSlashFlow?.command?.description}
              slashSections={newThread.slashMenu.slashSections}
              slashOptions={newThread.slashMenu.slashOptions}
              selectedSlashCommand={newThread.slashMenu.activeSlashOptionCommand ?? newThread.slashMenu.selectedSlashCommand}
              selectedSlashOption={newThread.slashMenu.selectedSlashOption}
              showSlashMenu={newThread.slashMenu.showSlashMenu}
              showSlashOptionMenu={newThread.slashMenu.showSlashOptionMenu}
              slashOptionEmptyState={newThread.slashMenu.slashOptionEmptyState}
              showMentionMenu={newThread.mentionMenu.showMentionMenu}
              mentionOptions={newThread.mentionMenu.mentionOptions}
              selectedMentionIndex={newThread.mentionMenu.selectedIndex}
              onChangePrompt={newThread.setPrompt}
              onSelectEnvironment={newThread.setEnvironment}
              onSelectWorkspace={newThread.selectWorkspace}
              onSetModel={(provider, modelId) => { newThread.setProvider(provider); newThread.setModelId(modelId); }}
              onSetThinking={newThread.setThinkingLevel}
              onOpenModelSettings={(section) => openSettings(newThread.workspace?.id, section)}
              onComposerKeyDown={newThread.handleComposerKeyDown}
              onComposerPaste={newThread.handleComposerPaste}
              onComposerDrop={newThread.handleComposerDrop}
              onClearSlashCommand={newThread.slashMenu.resetSlashUi}
              onSelectSlashCommand={(command) => {
                newThread.slashMenu.applySlashCommandSelection(command, "click");
              }}
              onSelectSlashOption={(option) => {
                newThread.slashMenu.applySlashOptionSelection(option);
              }}
              onSelectMention={newThread.mentionMenu.insertMention}
              onEnableMentionExtension={newThread.mentionMenu.enableMentionExtension}
              onAddAttachments={newThread.addAttachments}
              onRemoveAttachment={newThread.removeAttachment}
              onSubmit={newThread.startThread}
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
            <section className="canvas canvas--thread">
              <div className="conversation conversation--thread">
                <div className="chat-header">
                  <div className="chat-header__eyebrow">
                    {selectedWorkspace.kind === "worktree"
                      ? `${rootWorkspace?.name ?? selectedWorkspace.name} · ${selectedWorktree?.name ?? selectedWorkspace.branchName ?? "Worktree"}`
                      : `${selectedWorkspace.name} · Local`}
                  </div>
                  <div className="chat-header__row">
                    <h1 className="chat-header__title">{displayedSessionTitle}</h1>
                    <div className="chat-header__status">
                      {selectedSession.status === "running" ? runningLabel : formatRelativeTime(selectedSession.updatedAt)}
                    </div>
                  </div>
                </div>

                {showSchemaSkewNotice ? (
                  <div className="schema-skew-notice" role="status" data-testid="schema-skew-notice">
                    <span className="schema-skew-notice__text">
                      This session was written by a newer version of pi — some content may not display. Update pi-gui
                      (or open it with the pi CLI) to see everything.
                    </span>
                    <button
                      type="button"
                      className="schema-skew-notice__dismiss"
                      aria-label="Dismiss notice"
                      onClick={() => dismissSchemaSkewNotice(selectedSessionKey)}
                    >
                      Dismiss
                    </button>
                  </div>
                ) : null}

                <ConversationTimeline
                  transcript={activeTranscript}
                  isTranscriptLoading={isTranscriptLoading}
                  timelinePaneRef={timelinePaneRef}
                  timelinePaneElementRef={setTimelinePaneElement}
                  disableVirtualization={disableTimelineVirtualization}
                  onDisableVirtualizationReady={finalizeTimelineVirtualizationDisable}
                  onTimelineScroll={handleTimelineScroll}
                  onTimelineScrollIntent={handleTimelineScrollIntent}
                  threadSearch={threadSearch}
                  showJumpToLatest={showJumpToLatest}
                  onJumpToLatest={jumpToLatest}
                  onContentHeightChange={handleTimelineContentHeightChange}
                  onViewFileInDiff={handleViewFileInDiff}
                  onForkFromMessage={selectedSession.status === "running" ? undefined : openForkModal}
                  promptRailVisible={promptRailVisible}
                />
              </div>
            </section>
            <ComposerPanel
              key={selectedSessionKey}
              activeSlashCommand={slashMenu.activeSlashFlow?.command}
              activeSlashCommandMeta={slashMenu.activeSlashFlow?.command?.description}
              attachments={composerAttachments}
              queuedMessages={queuedComposerMessages}
              editingQueuedMessageId={editingQueuedMessageId}
              composerDraft={composerDraft}
              composerRef={composerRef}
              runtime={selectedModelRuntime}
              provider={resolvedSessionProvider}
              modelId={resolvedSessionModelId}
              thinkingLevel={resolvedSessionThinkingLevel}
              onClearSlashCommand={slashMenu.resetSlashUi}
              onComposerKeyDown={handleComposerKeyDown}
              onComposerPaste={handleComposerPaste}
              onComposerDrop={handleComposerDrop}
              onPickAttachments={handlePickAttachments}
              onRemoveAttachment={handleRemoveAttachment}
              onEditQueuedMessage={handleEditQueuedMessage}
              onCancelQueuedEdit={handleCancelQueuedEdit}
              onRemoveQueuedMessage={handleRemoveQueuedMessage}
              onSteerQueuedMessage={handleSteerQueuedMessage}
              onSelectSlashCommand={(command) => {
                slashMenu.applySlashCommandSelection(command, "click");
              }}
              onSelectSlashOption={(option) => {
                slashMenu.applySlashOptionSelection(option);
              }}
              onSetModel={handleSetSessionModel}
              onSetThinking={handleSetSessionThinking}
              modelOnboarding={selectedSessionModelOnboarding}
              onOpenModelSettings={(section) =>
                openSettings(selectedWorkspace?.rootWorkspaceId ?? selectedWorkspace?.id, section)
              }
              onSubmit={submitComposerDraft}
              runningLabel={runningLabel}
              selectedSession={selectedSession}
              lastError={snapshot.lastError}
              selectedSlashCommand={slashMenu.activeSlashOptionCommand ?? slashMenu.selectedSlashCommand}
              selectedSlashOption={slashMenu.selectedSlashOption}
              slashOptionEmptyState={slashMenu.slashOptionEmptyState}
              setComposerDraft={setComposerDraft}
              showSlashOptionMenu={slashMenu.showSlashOptionMenu}
              showSlashMenu={slashMenu.showSlashMenu}
              slashOptions={slashMenu.slashOptions}
              slashSections={slashMenu.slashSections}
              showMentionMenu={mentionMenu.showMentionMenu}
              mentionOptions={mentionMenu.mentionOptions}
              selectedMentionIndex={mentionMenu.selectedIndex}
              onSelectMention={mentionMenu.insertMention}
              onEnableMentionExtension={mentionMenu.enableMentionExtension}
              extensionDock={selectedExtensionDock}
              extensionDockExpanded={isSelectedExtensionDockExpanded}
              onToggleExtensionDock={handleToggleExtensionDock}
            />
            {activeExtensionDialog ? (
              <ExtensionDialog dialog={activeExtensionDialog} onRespond={handleRespondToExtensionDialog} />
            ) : null}
            {treeModalState.open ? (
              <TreeModal
                error={treeModalState.error}
                loading={treeModalState.loading}
                submitting={treeModalState.submitting}
                tree={treeModalState.tree}
                onClose={closeTreeModal}
                onNavigate={navigateTreeSelection}
              />
            ) : null}
            {forkModalState.open ? (
              <ForkModal
                error={forkModalState.error}
                submitting={forkModalState.submitting}
                messagePreview={forkModalState.messagePreview}
                canUseWorktree={canUseWorktree}
                onClose={closeForkModal}
                onSubmit={handleForkSubmit}
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
                  onClick={() => newThread.openSurface(selectedWorkspace?.rootWorkspaceId ?? selectedWorkspace?.id)}
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

        {terminalPanel}
          </>
        )}
        {sidePanelMode && selectedWorkspace && selectedSession ? (
          <DiffPanel
            key={sidePanelMode}
            panelMode={sidePanelMode}
            workspaceId={selectedWorkspace.id}
            sessionId={selectedSession.id}
            api={api}
            sessionStatus={selectedSession.status}
            fileRequest={diffFileRequest}
            contexts={fileWorkbenchContexts}
          />
        ) : null}
      </main>
    </div>
  );
}
