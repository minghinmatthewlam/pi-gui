import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import type { SessionRef } from "@pi-gui/session-driver/types";
import {
  getSelectedSession,
  getSelectedWorkspace,
  type AppView,
  type CreateScheduledTaskInput,
} from "../../contracts/desktop-state";
import {
  nonCompletedBindingForSession,
  scheduledOriginsByMessageId,
} from "../../contracts/scheduled-tasks";
import { updateSnapshot, useDesktopAppState } from "./desktop-app-state";
import { DesktopStartupSurface, toStartupSurfaceState } from "./desktop-recovery";
import { buildFileWorkbenchContexts } from "./file-workbench-contexts";
import {
  canTogglePrimarySidebar,
  closableSurfaceFromTarget,
  isEventInsideTerminal,
} from "./app-shell-utils";
import { useRunningLabel } from "../features/conversation/hooks/use-running-label";
import { useTimelineViewport } from "../features/conversation/hooks/use-timeline-viewport";
import { buildDisplayTimelineItems } from "../features/conversation/timeline-turns";
import { formatRelativeTime } from "../lib/string-utils";
import { restoreTopmostDialogFocus } from "../ui/dialog-focus";
import { ComposerPanel } from "../features/conversation/composer-panel";
import { DiffPanel } from "../features/workbench/diff-panel";
import type { DiffPanelFileRequest } from "../features/workbench/diff-panel-types";
import { FileWorkbench } from "../features/workbench/file-workbench";
import { useWorkbench } from "../features/workbench/use-workbench";
import {
  ExtensionViewPanel,
  type ExtensionViewTheme,
} from "../features/extensions/extension-view-panel";
import { useExtensionViews } from "../features/extensions/use-extension-views";
import { Workbench } from "../features/workbench/workbench";
import { useWorkbenchWidth } from "../features/workbench/use-workbench-width";
import { WorktreesPanel } from "../features/workbench/worktrees-panel";
import type { WorkspaceFileLine } from "../features/conversation/workspace-file-line";
import { buildModelOptions } from "../features/conversation/composer-commands";
import {
  createChordToggleGate,
  CHANGES_TOGGLE_DEDUPE_MS,
  desktopCommands,
  earlyModifierChords,
  getDesktopCommandFromShortcut,
  isCloseFocusedSurfaceShortcut,
  getDesktopShortcutLabel,
  recentThreadShortcutIndex,
  type PiDesktopCommand,
} from "../../contracts/ipc";
import { deriveModelOnboardingState } from "../features/settings/model-onboarding";
import type { SettingsSection } from "../features/settings/settings-view";
import { SecondarySurfaces } from "./secondary-surfaces";
import { NewThreadView } from "../features/threads/new-thread-view";
import {
  buildThreadSidebarModel,
  visibleThreadShortcutOrder,
  type ThreadListEntry,
} from "../features/threads/thread-groups";
import { Sidebar } from "../features/threads/sidebar";
import { SidebarToggleButton } from "../features/threads/sidebar-toggle-button";
import { Topbar } from "./topbar";
import { TerminalPanel } from "../features/workbench/terminal-panel";
import { ConversationTimeline } from "../features/conversation/conversation-timeline";
import { ScheduledTasksView } from "../features/scheduled-tasks/scheduled-tasks-view";
import {
  ScheduledTaskEditor,
  type ScheduledEditorState,
} from "../features/scheduled-tasks/scheduled-task-editor";
import { ScheduledTaskChip } from "../features/scheduled-tasks/scheduled-task-chip";
import { useSlashMenu } from "../features/conversation/hooks/use-slash-menu";
import { useMentionMenu } from "../features/conversation/hooks/use-mention-menu";
import { useThreadSearch } from "../features/conversation/hooks/use-thread-search";
import { useWorkspaceMenu } from "../features/threads/hooks/use-workspace-menu";
import { useNewThreadController } from "../features/threads/hooks/use-new-thread-controller";
import {
  buildExtensionDockModel,
  ExtensionDialog,
  hasExtensionDockContent,
} from "../features/extensions/extension-session-ui";
import { TreeModal } from "../features/conversation/tree-modal";
import { ForkModal } from "../features/conversation/fork-modal";
import { getEffectiveModelRuntime } from "../features/settings/model-settings";
import { applyThemePresetToRoot } from "../features/settings/theme-presets";
import { deriveWorkspaceContext } from "./workspace-context";
import { useTreeForkModals } from "../features/conversation/hooks/use-tree-fork-modals";
import { useComposerDraftSync } from "../features/conversation/hooks/use-composer-draft-sync";
import { useSessionComposer } from "../features/conversation/hooks/use-session-composer";

export default function App() {
  const desktop = useDesktopAppState();
  const workbenchWidth = useWorkbenchWidth();
  const snapshot = desktop.snapshot;
  const setSnapshot = desktop.setSnapshot;
  const selectedTranscript = desktop.selectedTranscript;
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const [settingsWorkspaceId, setSettingsWorkspaceId] = useState("");
  const [skillsWorkspaceId, setSkillsWorkspaceId] = useState("");
  const [extensionsWorkspaceId, setExtensionsWorkspaceId] = useState("");
  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">("light");
  const [extensionViewTheme, setExtensionViewTheme] = useState<ExtensionViewTheme>({
    mode: "light",
    background: "#ffffff",
    foreground: "#171717",
    accent: "#6554a4",
  });
  const [extensionFileError, setExtensionFileError] = useState<{
    readonly target: SessionRef;
    readonly message: string;
  } | null>(null);
  const [preparingExtensionDrafts, setPreparingExtensionDrafts] = useState<
    ReadonlyMap<string, SessionRef>
  >(() => new Map());
  const [dockExpandedBySession, setDockExpandedBySession] = useState<Record<string, string>>({});
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const timelinePaneRef = useRef<HTMLDivElement | null>(null);
  const [dismissedSchemaSkewSessionKeys, setDismissedSchemaSkewSessionKeys] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [diffFileRequest, setDiffFileRequest] = useState<{
    readonly sessionKey: string;
    readonly request: DiffPanelFileRequest;
  } | null>(null);
  const [scheduledEditor, setScheduledEditor] = useState<ScheduledEditorState | null>(null);
  const [threadMenuOpen, setThreadMenuOpen] = useState(false);
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

    void piApi
      .getResolvedTheme()
      .then((theme) => {
        setResolvedTheme(theme);
        document.documentElement.classList.toggle("dark", theme === "dark");
      })
      .catch((error: unknown) => {
        console.error("[renderer] getResolvedTheme failed", error);
      });

    const unsub = piApi.onThemeChanged((theme) => {
      setResolvedTheme(theme);
      document.documentElement.classList.toggle("dark", theme === "dark");
    });

    return unsub;
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    applyThemePresetToRoot(root, snapshot?.themePresetId ?? "default", resolvedTheme);
    root.classList.toggle("enable-transparency", snapshot?.enableTransparency ?? false);
    const style = getComputedStyle(root);
    setExtensionViewTheme({
      mode: resolvedTheme,
      background: style.getPropertyValue("--main").trim(),
      foreground: style.getPropertyValue("--text").trim(),
      accent: style.getPropertyValue("--accent").trim(),
    });
  }, [resolvedTheme, snapshot?.themePresetId, snapshot?.enableTransparency]);

  const {
    activeWorktrees,
    linkedWorktreeByWorkspaceId,
    rootWorkspace,
    rootWorkspaceOptions,
    selectedWorkspace,
    visibleWorkspaces,
  } = useMemo(() => deriveWorkspaceContext(snapshot), [snapshot]);
  const selectedSession = snapshot
    ? (getSelectedSession(snapshot) ?? selectedWorkspace?.sessions[0])
    : undefined;
  const selectedRuntime = selectedWorkspace
    ? snapshot?.runtimeByWorkspace[selectedWorkspace.id]
    : undefined;
  const selectedModelRuntime = snapshot
    ? getEffectiveModelRuntime(snapshot, selectedWorkspace)
    : undefined;
  const selectedWorktree = selectedWorkspace
    ? linkedWorktreeByWorkspaceId.get(selectedWorkspace.id)
    : undefined;
  const selectedDefaultEnabled = buildModelOptions(selectedModelRuntime).some(
    (m) =>
      m.providerId === selectedModelRuntime?.settings.defaultProvider &&
      m.modelId === selectedModelRuntime?.settings.defaultModelId,
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
  const runningLabel = useRunningLabel(
    selectedSession?.status === "running" ? selectedSession.runningSince : undefined,
  );
  const selectedSessionKey =
    selectedWorkspace && selectedSession ? `${selectedWorkspace.id}:${selectedSession.id}` : "";
  const {
    composerDraft,
    setComposerDraft,
    composerDraftRef,
    flushComposerDraft,
    flushComposerDraftAsync,
  } = useComposerDraftSync({
    api,
    snapshot,
    selectedSessionKey,
  });
  const workbenchTarget = useMemo(
    () =>
      selectedWorkspace && selectedSession
        ? { workspaceId: selectedWorkspace.id, sessionId: selectedSession.id }
        : null,
    [selectedWorkspace?.id, selectedSession?.id],
  );
  const extensionViews = useExtensionViews({ api, target: workbenchTarget });
  const workbench = useWorkbench({ api, target: workbenchTarget });
  const workbenchTargetRef = useRef(workbenchTarget);
  workbenchTargetRef.current = workbenchTarget;
  const beforePrepareTaskDraft = useCallback(async () => {
    const target = workbenchTarget;
    if (!target || workbenchTargetRef.current !== target)
      throw new Error("Return to the extension's task to create a task draft.");
    await flushComposerDraftAsync(target);
    if (workbenchTargetRef.current !== target)
      throw new Error("The task changed before its draft could be saved.");
  }, [flushComposerDraftAsync, workbenchTarget]);
  const handlePrepareTaskDraftPendingChange = useCallback(
    (pending: boolean, requestKey: string) => {
      setPreparingExtensionDrafts((current) => {
        if (pending && !workbenchTarget) return current;
        if (!pending && !current.has(requestKey)) return current;
        const next = new Map(current);
        if (pending && workbenchTarget) next.set(requestKey, workbenchTarget);
        else next.delete(requestKey);
        return next;
      });
    },
    [workbenchTarget],
  );
  const activeTool = workbench.activeTool;
  const activeExtensionView =
    activeTool?.kind === "extension"
      ? extensionViews.views.find(
          (view) => view.extensionId === activeTool.extensionId && view.id === activeTool.viewId,
        )
      : undefined;
  const workbenchRef = useRef(workbench);
  workbenchRef.current = workbench;
  const extensionFileRequestRef = useRef(0);
  useEffect(() => {
    setExtensionFileError(null);
  }, [workbenchTarget, workbench.view.selection]);
  useEffect(
    () =>
      api?.onExtensionViewOpenFile((event) => {
        const target = workbenchTargetRef.current;
        if (
          target?.workspaceId !== event.target.workspaceId ||
          target.sessionId !== event.target.sessionId
        )
          return;
        const request = ++extensionFileRequestRef.current;
        setExtensionFileError(null);
        void workbenchRef.current
          .openFile({ workspaceId: event.target.workspaceId, path: event.path, line: event.line })
          .catch((error: unknown) => {
            if (
              workbenchTargetRef.current !== target ||
              extensionFileRequestRef.current !== request
            )
              return;
            setExtensionFileError({
              target,
              message: `Couldn't open ${event.path}. ${error instanceof Error ? error.message : "Try opening the file again."}`,
            });
          });
      }),
    [api],
  );
  const selectedToolId =
    workbench.view.selection.kind === "tool" ? workbench.view.selection.toolId : null;
  const sidePanelAvailable = snapshot?.activeView === "threads" && Boolean(workbenchTarget);
  const sidePanelVisible = sidePanelAvailable && workbench.view.visibility === "visible";
  const selectedTranscriptForSession =
    selectedTranscript &&
    selectedWorkspace &&
    selectedSession &&
    selectedTranscript.workspaceId === selectedWorkspace.id &&
    selectedTranscript.sessionId === selectedSession.id
      ? selectedTranscript
      : null;
  const activeTranscript = selectedTranscriptForSession?.transcript ?? [];
  const scheduledOrigins = useMemo(() => {
    if (!snapshot || !selectedWorkspace || !selectedSession) {
      return new Map();
    }
    return scheduledOriginsByMessageId(
      snapshot.scheduledTasks,
      selectedWorkspace.id,
      selectedSession.id,
      activeTranscript,
    );
  }, [activeTranscript, selectedSession, selectedWorkspace, snapshot]);
  const scheduledBinding = selectedSession
    ? nonCompletedBindingForSession(snapshot?.scheduledTasks ?? [], selectedSession.id)
    : undefined;
  const transcriptHydration = desktop.view.kind === "ready" ? desktop.view.transcript : undefined;
  const transcriptFailed = transcriptHydration?.kind === "failed" ? transcriptHydration : null;
  const isTranscriptLoading =
    Boolean(selectedSession) && !selectedTranscriptForSession && !transcriptFailed;
  const timelineRows = useMemo(
    () => buildDisplayTimelineItems(activeTranscript),
    [activeTranscript],
  );
  const viewport = useTimelineViewport({
    sessionKey: selectedSessionKey,
    rows: timelineRows,
    active: snapshot?.activeView === "threads" && Boolean(selectedSession),
    transcriptReady: !isTranscriptLoading && !transcriptFailed,
    paneRef: timelinePaneRef,
  });
  const threadSearch = useThreadSearch(
    timelinePaneRef,
    viewport.navigateToElement,
    viewport.setSearchMode,
  );
  const showSchemaSkewNotice =
    selectedTranscriptForSession?.schemaInfo?.writtenByNewerRuntime === true &&
    Boolean(selectedSessionKey) &&
    !dismissedSchemaSkewSessionKeys.has(selectedSessionKey);
  const selectedSessionCommands = selectedSession
    ? (snapshot?.sessionCommandsBySession[selectedSessionKey] ?? [])
    : [];
  const selectedExtensionUi = selectedSession
    ? snapshot?.sessionExtensionUiBySession[selectedSessionKey]
    : undefined;
  const selectedWorkspaceCommandCompatibility = selectedWorkspace
    ? (snapshot?.extensionCommandCompatibilityByWorkspace[selectedWorkspace.id] ?? [])
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
  const selectedExtensionDock = useMemo(
    () => buildExtensionDockModel(selectedExtensionUi),
    [selectedExtensionUi],
  );
  const displayedSessionTitle = selectedExtensionUi?.title ?? selectedSession?.title ?? "";
  const activeExtensionDialog = selectedExtensionUi?.pendingDialogs[0];
  const selectedExtensionUiInstance =
    snapshot?.sessionExtensionUiBySession[selectedSessionKey]?.instanceId;
  const isSelectedExtensionDockExpanded =
    selectedExtensionUiInstance !== undefined &&
    dockExpandedBySession[selectedSessionKey] === selectedExtensionUiInstance;
  const threadSidebarModel = useMemo(
    () => (snapshot ? buildThreadSidebarModel(snapshot) : undefined),
    [snapshot],
  );
  const threadSidebarModelRef = useRef(threadSidebarModel);
  threadSidebarModelRef.current = threadSidebarModel;
  const threadGroupingRef = useRef(snapshot?.threadGrouping ?? "time");
  threadGroupingRef.current = snapshot?.threadGrouping ?? "time";
  const threadShortcutOrderRef = useRef<readonly ThreadListEntry[] | null>(null);
  const threadSearchGate = useRef(createChordToggleGate());
  const changesToggleGate = useRef(createChordToggleGate(CHANGES_TOGGLE_DEDUPE_MS));
  const handleCommandRef = useRef<(command: PiDesktopCommand) => boolean>(() => false);
  const handleRendererKeyDownRef = useRef<(event: globalThis.KeyboardEvent) => void>(() => {});
  const toggleThreadSearchRef = useRef<() => void>(() => {});
  const focusComposer = () => {
    window.requestAnimationFrame(() => {
      if (restoreTopmostDialogFocus()) {
        return;
      }
      composerRef.current?.focus();
    });
  };
  const toggleTerminal = useCallback(() => {
    if (!sidePanelAvailable) return;
    if (sidePanelVisible && selectedToolId === "terminal") workbench.setVisibility("hidden");
    else workbench.openTool({ kind: "terminal" });
  }, [sidePanelAvailable, sidePanelVisible, selectedToolId, workbench]);
  const closeFocusedSurface = useCallback(() => {
    if (!closableSurfaceFromTarget(document.activeElement)) return;
    const current = workbenchRef.current;
    if (current.view.selection.kind === "tool") current.closeTool(current.view.selection.toolId);
    else current.setVisibility("hidden");
    window.requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(
          '#task-workbench [role="tab"][aria-selected="true"], #task-workbench [data-testid="workbench-add-tab"]',
        )
        ?.focus();
    });
  }, []);
  const handleViewFileInDiff = useCallback((path: string) => {
    const workspace = selectedWorkspaceRef.current;
    if (!workspace) return;
    const current = workbenchRef.current;
    current.setChanges({
      workspaceId: workspace.id,
      selectedPath: path,
      scope: { kind: "uncommitted" },
    });
    current.openTool({ kind: "changes" });
    setDiffFileRequest({
      sessionKey: selectedSessionKeyRef.current,
      request: { workspaceId: workspace.id, path, nonce: Date.now() },
    });
  }, []);
  const reviewTurnRequestRef = useRef(0);
  const handleReviewTurn = useCallback(
    async (messageId: string) => {
      const target = workbenchTargetRef.current;
      if (!api || !target) return;
      const request = ++reviewTurnRequestRef.current;
      const stillSelected = () =>
        workbenchTargetRef.current === target && reviewTurnRequestRef.current === request;
      try {
        const result = await api.resolveTurnReview({ target, messageId });
        if (!stillSelected()) return;
        if (result.state !== "available") throw new Error(result.message);
        workbenchRef.current.setChanges({
          workspaceId: target.workspaceId,
          selectedPath: null,
          scope: { kind: "turn", checkpointId: result.checkpointId },
        });
        workbenchRef.current.openTool({ kind: "changes" });
        setDiffFileRequest(null);
      } catch (error) {
        if (stillSelected()) throw error;
      }
    },
    [api],
  );
  const selectedSessionKeyRef = useRef(selectedSessionKey);
  selectedSessionKeyRef.current = selectedSessionKey;
  const selectedWorkspaceRef = useRef(selectedWorkspace);
  selectedWorkspaceRef.current = selectedWorkspace;
  // Snapshot ticks replace selectedWorkspace. A new callback identity reparses every
  // visible assistant message and drops stick-to-bottom while a reply is streaming.
  const handleOpenWorkspaceFileLine = useCallback(
    (target: WorkspaceFileLine) => {
      const workspace = selectedWorkspaceRef.current;
      if (!api || !workspace) {
        return;
      }
      void workbenchRef.current
        .openFile({
          workspaceId: workspace.id,
          path: target.path,
          line: target.line,
          endLine: target.endLine,
        })
        .catch(() => {
          // Missing, unreadable, or outside the workspace: leave the panel unchanged.
        });
    },
    [api],
  );

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

  const toggleSidePanel = useCallback(() => {
    if (sidePanelAvailable) workbench.toggleVisibility();
  }, [sidePanelAvailable, workbench]);

  const toggleChangesPanel = useCallback(() => {
    if (!sidePanelAvailable) return;
    if (sidePanelVisible && selectedToolId === "changes") workbench.setVisibility("hidden");
    else workbench.openTool({ kind: "changes" });
  }, [sidePanelAvailable, sidePanelVisible, selectedToolId, workbench]);

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
    void updateSnapshot(setSnapshot, () => api.setActiveView("settings")).catch(
      (error: unknown) => {
        console.error("[renderer] setActiveView failed", error);
      },
    );
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
      return updateSnapshot(setSnapshot, () =>
        api.setExtensionEnabled(selectedWorkspace.id, filePath, true),
      ).then(() => undefined);
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
    openSettings,
    flushComposerDraft,
  });

  const {
    composerAttachments,
    submitComposerDraft,
    stopCurrentRun,
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
    onNewThreadComposerError: newThread.setComposerError,
  });

  useEffect(() => {
    const sessionExtensionUiBySession = snapshot?.sessionExtensionUiBySession;
    if (!sessionExtensionUiBySession) {
      setDockExpandedBySession((current) => (Object.keys(current).length > 0 ? {} : current));
      return;
    }

    setDockExpandedBySession((current) => {
      let next: Record<string, string> | undefined;
      for (const [sessionKey, instanceId] of Object.entries(current)) {
        if (
          sessionExtensionUiBySession[sessionKey]?.instanceId === instanceId &&
          hasExtensionDockContent(sessionExtensionUiBySession[sessionKey])
        ) {
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
      rootWorkspaceOptions.some((workspace) => workspace.id === current)
        ? current
        : current || rootWorkspaceOptions[0]?.id || "",
    );
    setSkillsWorkspaceId((current) =>
      rootWorkspaceOptions.some((workspace) => workspace.id === current)
        ? current
        : current || rootWorkspaceOptions[0]?.id || "",
    );
    setExtensionsWorkspaceId((current) =>
      rootWorkspaceOptions.some((workspace) => workspace.id === current)
        ? current
        : current || rootWorkspaceOptions[0]?.id || "",
    );
  }, [rootWorkspaceOptions]);

  const primarySidebarToggleVisible = canTogglePrimarySidebar(snapshot?.activeView);
  const handleTogglePrimarySidebar = useCallback(() => {
    const sidebarState = sidebarToggleStateRef.current;
    const sidebarApi = sidebarState.api;
    if (!sidebarApi || !canTogglePrimarySidebar(sidebarState.activeView)) {
      return false;
    }
    void updateSnapshot(setSnapshot, () =>
      sidebarApi.setSidebarCollapsed(!sidebarState.sidebarCollapsed),
    ).catch((error: unknown) => {
      console.error("[renderer] updateSnapshot failed", error);
    });
    return true;
  }, []);
  const sidebarToggleShortcutLabel = api ? getDesktopShortcutLabel(api.platform, "B") : "";

  const handleCommand = (command: PiDesktopCommand): boolean => {
    if (command === desktopCommands.openSettings) {
      openSettings(selectedWorkspace?.rootWorkspaceId ?? selectedWorkspace?.id);
      return true;
    }
    if (command === desktopCommands.openNewThread) {
      newThread.openSurface(selectedWorkspace?.rootWorkspaceId ?? selectedWorkspace?.id);
      return true;
    }
    if (command === desktopCommands.toggleTerminal) {
      toggleTerminal();
      return true;
    }
    if (command === desktopCommands.toggleSidePanel) {
      toggleSidePanel();
      return true;
    }
    if (command === desktopCommands.toggleChanges) {
      // IPC and the renderer can both see one Cmd+D. Collapse that same-tick
      // pair while preserving a deliberate second press.
      if (!changesToggleGate.current(performance.now())) return true;
      toggleChangesPanel();
      return true;
    }
    if (command === desktopCommands.closeFocusedSurface) {
      closeFocusedSurface();
      return true;
    }
    if (command === desktopCommands.toggleSidebar) {
      return handleTogglePrimarySidebar();
    }
    const recentIndex = recentThreadShortcutIndex(command);
    if (recentIndex !== undefined) {
      const model = threadSidebarModelRef.current;
      const threads =
        threadShortcutOrderRef.current ??
        (model
          ? visibleThreadShortcutOrder({
              grouping: threadGroupingRef.current,
              model,
            })
          : []);
      const thread = threads[recentIndex];
      if (!thread || !api) {
        return true;
      }
      void updateSnapshot(setSnapshot, () =>
        api.selectSession({
          workspaceId: thread.workspaceId,
          sessionId: thread.session.id,
        }),
      ).catch((error: unknown) => {
        console.error("[renderer] selectSession failed", error);
      });
      return true;
    }
    return false;
  };
  handleCommandRef.current = handleCommand;
  toggleThreadSearchRef.current = () => {
    if (!threadSearchGate.current(performance.now())) return;
    if (threadSearch.isOpen) threadSearch.close();
    else threadSearch.open();
  };
  handleRendererKeyDownRef.current = (event: globalThis.KeyboardEvent) => {
    const closeSurfaceShortcut = isCloseFocusedSurfaceShortcut({
      meta: event.metaKey,
      control: event.ctrlKey,
      alt: event.altKey,
      shift: event.shiftKey,
      key: event.key,
      code: event.code,
      platform: api?.platform ?? "linux",
    });
    if (closeSurfaceShortcut && closableSurfaceFromTarget(event.target)) {
      event.preventDefault();
      closeFocusedSurface();
      return;
    }
    if (isEventInsideTerminal(event)) {
      const command = getDesktopCommandFromShortcut({
        modifier: event.metaKey || event.ctrlKey,
        alt: event.altKey,
        shift: event.shiftKey,
        key: event.key,
        code: event.code,
      });
      if (
        command === desktopCommands.toggleTerminal ||
        command === desktopCommands.toggleSidePanel
      ) {
        event.preventDefault();
        handleCommandRef.current(command);
      }
      return;
    }
    if (
      (event.metaKey || event.ctrlKey) &&
      !event.shiftKey &&
      !event.repeat &&
      (event.key.toLowerCase() === "f" || event.code === "KeyF")
    ) {
      event.preventDefault();
      toggleThreadSearchRef.current();
      return;
    }
    const command = getDesktopCommandFromShortcut({
      modifier: event.metaKey || event.ctrlKey,
      alt: event.altKey,
      shift: event.shiftKey,
      key: event.key,
      code: event.code,
    });
    if (command && handleCommandRef.current(command)) {
      event.preventDefault();
    }
  };

  useEffect(() => {
    // Bind once. Re-subscribing when session or search identity changes drops
    // Cmd+D and 1-9 in the gap after a thread switch or relaunch.
    const dispatch = (command: PiDesktopCommand) => {
      handleCommandRef.current(command);
    };
    const removeCommandListener = window.piApp?.onCommand?.(dispatch);
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      handleRendererKeyDownRef.current(event);
    };
    for (const chord of earlyModifierChords.arm()) {
      const key = chord.key.toLowerCase();
      if (key === "f" || chord.code === "KeyF") {
        toggleThreadSearchRef.current();
        continue;
      }
      const command = getDesktopCommandFromShortcut({
        modifier: true,
        shift: false,
        key: chord.key,
        code: chord.code,
      });
      if (command) dispatch(command);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      removeCommandListener?.();
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  useEffect(() => {
    const removeWorkspacePickedListener = window.piApp?.onWorkspacePicked?.((workspaceId) => {
      newThread.setPendingWorkspaceId(workspaceId);
      newThread.resetSurface();
    });
    const removeClipboardImageListener = window.piApp?.onClipboardImagePasted?.(
      handlePastedClipboardImage,
    );
    return () => {
      removeWorkspacePickedListener?.();
      removeClipboardImageListener?.();
    };
  }, [handlePastedClipboardImage, newThread]);

  useEffect(() => {
    // The composer is keyed by session: focus only after its new node commits.
    // An IPC completion can precede that commit and focus the outgoing node.
    if (snapshot?.activeView !== "threads" || !selectedSessionKey) return;
    if (!restoreTopmostDialogFocus()) composerRef.current?.focus();
  }, [selectedSessionKey, snapshot?.activeView]);

  useEffect(() => {
    const desktopApi = window.piApp;
    if (!desktopApi) {
      return undefined;
    }
    let armed = false;
    const sync = () => {
      const surface = closableSurfaceFromTarget(document.activeElement);
      const next = surface !== null && surface !== "terminal";
      if (next === armed) {
        return;
      }
      armed = next;
      desktopApi.setSidePanelFocused(next).catch((error: unknown) => {
        console.error("[renderer] setSidePanelFocused failed", error);
      });
    };
    document.addEventListener("focusin", sync);
    sync();
    return () => {
      document.removeEventListener("focusin", sync);
      if (armed) {
        desktopApi.setSidePanelFocused(false).catch((error: unknown) => {
          console.error("[renderer] setSidePanelFocused failed", error);
        });
      }
    };
  }, []);
  if (!api || desktop.view.kind !== "ready" || !snapshot) {
    return (
      <DesktopStartupSurface
        state={toStartupSurfaceState(desktop.view)}
        onRetry={desktop.retry}
        onRelaunch={desktop.canRelaunch ? desktop.relaunch : undefined}
      />
    );
  }

  const secondarySurfaceView =
    snapshot.activeView === "settings" ||
    snapshot.activeView === "skills" ||
    snapshot.activeView === "extensions"
      ? snapshot.activeView
      : null;
  const filesWorkspace = snapshot.workspaces.find(
    (workspace) => workspace.id === workbench.view.files.workspaceId,
  );
  const filesWorktree = filesWorkspace
    ? linkedWorktreeByWorkspaceId.get(filesWorkspace.id)
    : undefined;
  const mainClassName = [
    "main",
    sidePanelVisible ? "main--with-side-panel" : "",
    snapshot.startupDiagnostics.length > 0 ? "main--with-startup-diagnostics" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const setActiveView = (view: AppView) => {
    void updateSnapshot(setSnapshot, () => api.setActiveView(view)).catch((error: unknown) => {
      console.error("[renderer] setActiveView failed", error);
    });
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
    void updateSnapshot(setSnapshot, () =>
      api.setSessionModel(selectedWorkspace.id, selectedSession.id, provider, modelId),
    ).catch((error: unknown) => {
      console.error("[renderer] updateSnapshot failed", error);
    });
  };

  const handleSetSessionThinking = (level: string) => {
    if (!selectedWorkspace || !selectedSession) {
      return;
    }
    void updateSnapshot(setSnapshot, () =>
      api.setSessionThinkingLevel(
        selectedWorkspace.id,
        selectedSession.id,
        level as NonNullable<RuntimeSnapshot["settings"]["defaultThinkingLevel"]>,
      ),
    ).catch((error: unknown) => {
      console.error("[renderer] updateSnapshot failed", error);
    });
  };

  const handleTrySkill = (command: string) => {
    void updateSnapshot(setSnapshot, () => api.setActiveView("threads")).catch((error: unknown) => {
      console.error("[renderer] setActiveView failed", error);
    });
    slashMenu.fillComposerFromSlash(command);
  };

  const handleArchiveSession = (target: { workspaceId: string; sessionId: string }) => {
    void updateSnapshot(setSnapshot, () => api.archiveSession(target)).catch((error: unknown) => {
      console.error("[renderer] archiveSession failed", error);
    });
  };

  const handleSelectSession = (target: { workspaceId: string; sessionId: string }) => {
    // Flush any debounced draft write before the active session changes, otherwise the pending
    // write for the current session is lost (and would land on the wrong session if deferred).
    flushComposerDraft();
    viewport.savePosition();
    if (target.workspaceId === selectedWorkspace?.id && target.sessionId === selectedSession?.id)
      focusComposer();
    void updateSnapshot(setSnapshot, () => api.selectSession(target)).catch((error: unknown) => {
      console.error("[renderer] selectSession failed", error);
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

    void updateSnapshot(setSnapshot, () =>
      api.respondToHostUiRequest(selectedWorkspace.id, selectedSession.id, response),
    )
      .then(() => {
        focusComposer();
      })
      .catch((error: unknown) => {
        console.error("[renderer] updateSnapshot failed", error);
      });
  };

  const handleToggleExtensionDock = () => {
    if (!selectedExtensionDock || !selectedExtensionUiInstance) {
      return;
    }

    setDockExpandedBySession((current) => {
      const next = { ...current };
      if (current[selectedSessionKey] === selectedExtensionUiInstance)
        delete next[selectedSessionKey];
      else next[selectedSessionKey] = selectedExtensionUiInstance;
      return next;
    });
  };

  const handleUnarchiveSession = (target: { workspaceId: string; sessionId: string }) => {
    void updateSnapshot(setSnapshot, () => api.unarchiveSession(target)).catch((error: unknown) => {
      console.error("[renderer] unarchiveSession failed", error);
    });
  };

  const handleSetSessionPinned = (
    target: { workspaceId: string; sessionId: string },
    pinned: boolean,
  ) => {
    void updateSnapshot(setSnapshot, () => api.setSessionPinned(target, pinned)).catch(
      (error: unknown) => {
        console.error("[renderer] setSessionPinned failed", error);
      },
    );
  };

  const handleCreateScheduledTaskWithPi = () => {
    void updateSnapshot(setSnapshot, () => api.beginScheduledTaskInterview()).catch(
      (error: unknown) => {
        console.error("[renderer] beginScheduledTaskInterview failed", error);
      },
    );
  };

  const handleSubmitScheduledTask = (input: CreateScheduledTaskInput) => {
    const action =
      scheduledEditor?.mode === "edit"
        ? () => api.updateScheduledTask(scheduledEditor.taskId, input)
        : () => api.createScheduledTask(input);
    void updateSnapshot(setSnapshot, action)
      .then((state) => {
        if (!state.lastError) {
          setScheduledEditor(null);
        }
      })
      .catch((error: unknown) => {
        console.error("[renderer] save scheduled task failed", error);
      });
  };

  const handleOpenScheduledChat = (target: { workspaceId: string; sessionId: string }) => {
    setScheduledEditor(null);
    handleSelectSession(target);
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
          threadSidebarModel={threadSidebarModel ?? buildThreadSidebarModel(snapshot)}
          threadShortcutOrderRef={threadShortcutOrderRef}
          threadGrouping={snapshot.threadGrouping}
          linkedWorktreeByWorkspaceId={linkedWorktreeByWorkspaceId}
          wsMenu={wsMenu}
          api={api}
          setSnapshot={setSnapshot}
          updateSnapshot={updateSnapshot}
          onNewThread={() =>
            newThread.openSurface(selectedWorkspace?.rootWorkspaceId ?? selectedWorkspace?.id)
          }
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

      <main className={mainClassName} style={workbenchWidth.style}>
        <Topbar
          activeView={snapshot.activeView}
          rootWorkspace={rootWorkspace}
          selectedWorkspace={selectedWorkspace}
          selectedWorktree={selectedWorktree}
          api={api}
          panelAvailable={sidePanelAvailable}
          panelVisible={sidePanelVisible}
          onTogglePanel={toggleSidePanel}
          sessionTitle={
            snapshot.activeView === "threads" && selectedSession ? displayedSessionTitle : undefined
          }
        >
          {snapshot.activeView === "threads" && selectedWorkspace && selectedSession ? (
            <>
              <div className="chat-header__status">
                {selectedSession.status === "running"
                  ? runningLabel
                  : formatRelativeTime(selectedSession.updatedAt)}
              </div>
              <div className="chat-header__menu-wrap">
                <button
                  aria-haspopup="menu"
                  aria-expanded={threadMenuOpen}
                  aria-label="Thread actions"
                  className="icon-button"
                  data-testid="thread-header-menu"
                  type="button"
                  onClick={() => setThreadMenuOpen((open) => !open)}
                >
                  …
                </button>
                {threadMenuOpen ? (
                  <div className="workspace-menu chat-header__menu" role="menu">
                    <button
                      className="workspace-menu__item"
                      data-testid="thread-add-scheduled-task"
                      type="button"
                      onClick={() => {
                        setThreadMenuOpen(false);
                        if (scheduledBinding) {
                          setScheduledEditor({
                            mode: "edit",
                            taskId: scheduledBinding.id,
                          });
                          return;
                        }
                        setScheduledEditor({
                          mode: "create",
                          prefill: {
                            target: {
                              kind: "existing-thread",
                              workspaceId: selectedWorkspace.id,
                              sessionId: selectedSession.id,
                            },
                          },
                        });
                      }}
                    >
                      {scheduledBinding ? "Edit scheduled task…" : "Add scheduled task…"}
                    </button>
                  </div>
                ) : null}
              </div>
            </>
          ) : null}
        </Topbar>

        {snapshot.startupDiagnostics.length > 0 ? (
          <div className="startup-diagnostics" role="status" data-testid="startup-diagnostics">
            <strong>Some saved workspaces could not be refreshed.</strong>
            <span>
              {snapshot.startupDiagnostics
                .map((diagnostic) => {
                  const workspaceName = diagnostic.workspacePath
                    ?.split(/[\\/]/)
                    .filter(Boolean)
                    .at(-1);
                  return workspaceName ? `${workspaceName} is unavailable.` : diagnostic.message;
                })
                .join(" ")}
            </span>
          </div>
        ) : null}

        <>
          {snapshot.activeView === "scheduled" ? (
            <ScheduledTasksView
              tasks={snapshot.scheduledTasks}
              lastError={snapshot.lastError}
              api={api}
              setSnapshot={setSnapshot}
              updateSnapshot={updateSnapshot}
              onCreateWithPi={handleCreateScheduledTaskWithPi}
              onOpenEditor={setScheduledEditor}
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
                selectedSlashCommand={
                  newThread.slashMenu.activeSlashOptionCommand ??
                  newThread.slashMenu.selectedSlashCommand
                }
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
                onSetModel={(provider, modelId) => {
                  newThread.setProvider(provider);
                  newThread.setModelId(modelId);
                }}
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
                  {showSchemaSkewNotice ? (
                    <div
                      className="schema-skew-notice"
                      role="status"
                      data-testid="schema-skew-notice"
                    >
                      <span className="schema-skew-notice__text">
                        This session was written by a newer version of pi — some content may not
                        display. Update pi-gui (or open it with the pi CLI) to see everything.
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
                    key={selectedSessionKey}
                    transcript={activeTranscript}
                    isTranscriptLoading={isTranscriptLoading}
                    transcriptFailed={transcriptFailed}
                    onRetryTranscript={desktop.retry}
                    viewport={viewport}
                    threadSearch={threadSearch}
                    onViewFileInDiff={handleViewFileInDiff}
                    onReviewTurn={handleReviewTurn}
                    onOpenWorkspaceFileLine={handleOpenWorkspaceFileLine}
                    workspacePath={selectedWorkspace.path}
                    onForkFromMessage={
                      selectedSession.status === "running" ? undefined : openForkModal
                    }
                    scheduledOrigins={scheduledOrigins}
                  />
                </div>
              </section>
              {scheduledBinding ? (
                <ScheduledTaskChip
                  task={scheduledBinding}
                  onOpen={() => setScheduledEditor({ mode: "edit", taskId: scheduledBinding.id })}
                />
              ) : null}
              <ComposerPanel
                key={selectedSessionKey}
                preparingTaskDraft={[...preparingExtensionDrafts.values()].some(
                  (target) =>
                    target.workspaceId === workbenchTarget?.workspaceId &&
                    target.sessionId === workbenchTarget.sessionId,
                )}
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
                onStop={stopCurrentRun}
                runningLabel={runningLabel}
                selectedSession={selectedSession}
                lastError={snapshot.lastError}
                selectedSlashCommand={
                  slashMenu.activeSlashOptionCommand ?? slashMenu.selectedSlashCommand
                }
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
                <ExtensionDialog
                  dialog={activeExtensionDialog}
                  onRespond={handleRespondToExtensionDialog}
                />
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
                    onClick={() =>
                      newThread.openSurface(
                        selectedWorkspace?.rootWorkspaceId ?? selectedWorkspace?.id,
                      )
                    }
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
                <p>
                  Add project folders, group sessions under them, and jump between threads from the
                  sidebar.
                </p>
              </div>
            </section>
          )}
        </>
        {sidePanelVisible && selectedWorkspace && selectedSession ? (
          <Workbench
            view={workbench.view}
            onResize={workbenchWidth.setWidth}
            onTogglePanel={toggleSidePanel}
            extensionViews={extensionViews.views}
            extensionViewsLoading={extensionViews.loading}
            extensionViewsError={extensionViews.error}
            onReloadExtensionViews={extensionViews.reload}
            onOpenTool={workbench.openTool}
            onActivateTool={workbench.activateTool}
            onCloseTool={workbench.closeTool}
            onShowChooser={workbench.showChooser}
            error={
              workbench.error ||
              (extensionFileError?.target === workbenchTarget
                ? extensionFileError.message
                : undefined)
            }
            loading={!workbench.ready}
            onRetryRestore={workbench.retryRestore}
          >
            {activeExtensionView?.state === "ready" && workbenchTarget && api ? (
              <ExtensionViewPanel
                api={api}
                target={workbenchTarget}
                view={activeExtensionView}
                theme={extensionViewTheme}
                onBeforePrepareTaskDraft={beforePrepareTaskDraft}
                onPrepareTaskDraftPendingChange={handlePrepareTaskDraftPendingChange}
              />
            ) : selectedToolId === "changes" ? (
              <DiffPanel
                key={selectedSessionKey}
                workspaceId={selectedWorkspace.id}
                sessionId={selectedSession.id}
                api={api}
                sessionStatus={selectedSession.status}
                selection={workbench.view.changes}
                onSelectionChange={workbench.setChanges}
                onOpenFile={workbench.openFile}
                fileRequest={
                  diffFileRequest?.sessionKey === selectedSessionKey
                    ? diffFileRequest.request
                    : null
                }
                contexts={fileWorkbenchContexts}
              />
            ) : selectedToolId === "files" ? (
              filesWorkspace ? (
                <FileWorkbench
                  key={selectedSessionKey}
                  api={api}
                  onTabsChange={workbench.setFiles}
                  sessionStatus={selectedSession.status}
                  tabs={workbench.view.files.tabs}
                  worktree={filesWorktree}
                  workspace={filesWorkspace}
                />
              ) : (
                <p className="workbench__unavailable" role="status">
                  This file checkout is unavailable.
                </p>
              )
            ) : selectedToolId === "terminal" ? (
              <TerminalPanel
                key={selectedSessionKey}
                workspace={selectedWorkspace}
                sessionId={selectedSession.id}
                onHide={() => workbench.closeTool("terminal")}
              />
            ) : selectedToolId === "worktrees" ? (
              <WorktreesPanel
                rootWorkspace={rootWorkspace ?? selectedWorkspace}
                selectedWorkspace={selectedWorkspace}
                activeWorktrees={activeWorktrees}
                workspaces={snapshot.workspaces}
                onOpenWorkspace={(workspaceId) => {
                  flushComposerDraft();
                  viewport.savePosition();
                  wsMenu.selectWorkspace(workspaceId);
                }}
                onNewWorktree={() => {
                  if (!rootWorkspace) return;
                  flushComposerDraft();
                  viewport.savePosition();
                  wsMenu.createWorktree(rootWorkspace.id);
                }}
              />
            ) : null}
          </Workbench>
        ) : null}
      </main>
      {scheduledEditor ? (
        <ScheduledTaskEditor
          editor={scheduledEditor}
          task={
            scheduledEditor.mode === "edit"
              ? snapshot.scheduledTasks.find((task) => task.id === scheduledEditor.taskId)
              : undefined
          }
          workspaces={snapshot.workspaces}
          selectedWorkspaceId={snapshot.selectedWorkspaceId}
          busy={false}
          error={snapshot.lastError}
          onClose={() => setScheduledEditor(null)}
          onSubmit={handleSubmitScheduledTask}
          onOpenChat={handleOpenScheduledChat}
        />
      ) : null}
    </div>
  );
}
