import { useEffect, useMemo, useRef, useState, type Dispatch, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type SetStateAction } from "react";
import type { RuntimeSnapshot } from "@pi-app/session-driver/runtime-types";
import {
  getSelectedSession,
  getSelectedWorkspace,
  type AppView,
  type DesktopAppState,
  type WorktreeRecord,
  type WorkspaceRecord,
} from "./desktop-state";
import { ArchiveIcon, ChevronDownIcon, FolderIcon, PlusIcon, RestoreIcon, SettingsIcon, SkillIcon } from "./icons";
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
import { SettingsView, type SettingsSection } from "./settings-view";
import { TimelineItem } from "./timeline-item";
import { SecondarySurface } from "./secondary-surface";
import { NewThreadView } from "./new-thread-view";
import { buildThreadGroups, type ThreadListEntry } from "./thread-groups";

interface ActiveSlashFlow {
  readonly command: ComposerSlashCommand;
}

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
  const [activeSlashFlow, setActiveSlashFlow] = useState<ActiveSlashFlow | undefined>();
  const [slashMenuSuppressedDraft, setSlashMenuSuppressedDraft] = useState("");
  const [workspaceMenuId, setWorkspaceMenuId] = useState<string | null>(null);
  const [workspaceRenameId, setWorkspaceRenameId] = useState<string | null>(null);
  const [workspaceRenameDraft, setWorkspaceRenameDraft] = useState("");
  const [expandedArchivedByWorkspace, setExpandedArchivedByWorkspace] = useState<Record<string, boolean>>({});
  const [environmentMenuOpen, setEnvironmentMenuOpen] = useState(false);
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
  const workspaceMenuWrapRef = useRef<HTMLSpanElement | null>(null);
  const workspaceRenamePanelRef = useRef<HTMLFormElement | null>(null);
  const workspaceRenameInputRef = useRef<HTMLInputElement | null>(null);
  const environmentMenuRef = useRef<HTMLDivElement | null>(null);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
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
  const slashQuery = composerDraft.trimStart();
  const slashSections =
    slashQuery.startsWith("/")
      ? findSlashSuggestions(slashQuery, selectedRuntime)
      : [];
  const slashSuggestions = flattenSlashSections(slashSections);
  const exactSlashCommand = findExactSlashCommand(slashQuery, selectedRuntime);
  const activeSlashOptionCommand =
    activeSlashFlow?.command ?? (exactSlashCommand?.submitMode === "pick-option" ? exactSlashCommand : undefined);
  const showSlashMenu =
    selectedSession?.status !== "running" &&
    slashQuery.startsWith("/") &&
    !slashQuery.includes("\n") &&
    !activeSlashOptionCommand &&
    slashQuery !== slashMenuSuppressedDraft &&
    slashSuggestions.length > 0;
  const selectedSlashCommand = showSlashMenu ? slashSuggestions[slashIndex % slashSuggestions.length] : undefined;
  const slashOptions =
    activeSlashOptionCommand?.kind === "model"
      ? buildModelOptions(selectedRuntime)
      : slashOptionsForCommand(activeSlashOptionCommand, selectedRuntime);
  const showSlashOptionMenu =
    selectedSession?.status !== "running" &&
    Boolean(activeSlashOptionCommand) &&
    slashOptions.length > 0;
  const selectedSlashOption = showSlashOptionMenu ? slashOptions[slashOptionIndex % slashOptions.length] : undefined;
  const threadGroups = useMemo(
    () => (snapshot ? buildThreadGroups(snapshot) : []),
    [snapshot],
  );

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
    const handler = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === ",") {
        event.preventDefault();
        openSettings(selectedWorkspace?.rootWorkspaceId ?? selectedWorkspace?.id);
      }
    };
    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
    };
  }, [selectedWorkspace?.id, selectedWorkspace?.rootWorkspaceId]);

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
      if (!slashQuery && activeSlashFlow) {
        return;
      }
      setActiveSlashFlow(undefined);
      setSlashOptionIndex(0);
      return;
    }

    if (activeSlashFlow?.command && slashQuery.trim().length > activeSlashFlow.command.command.length) {
      setActiveSlashFlow(undefined);
      setSlashOptionIndex(0);
    }
  }, [activeSlashFlow, slashQuery]);

  useEffect(() => {
    setShowJumpToLatest(false);
    lastTranscriptMarkerRef.current = "";
    pinnedToBottomRef.current = true;
    setActiveSlashFlow(undefined);
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
      const environmentMenuContains = environmentMenuRef.current?.contains(target) ?? false;
      if (!menuContains && !renamePanelContains && !environmentMenuContains) {
        setWorkspaceMenuId(null);
        setWorkspaceRenameId(null);
        setEnvironmentMenuOpen(false);
      }
    };

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setWorkspaceMenuId(null);
        setWorkspaceRenameId(null);
        setEnvironmentMenuOpen(false);
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

  const openSettings = (workspaceId?: string, section?: SettingsSection) => {
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
    setActiveView("settings");
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

  const handleCreateWorktree = (workspaceId: string, fromSessionWorkspaceId?: string, fromSessionId?: string) => {
    setWorkspaceMenuId(null);
    setEnvironmentMenuOpen(false);
    void updateSnapshot(api, setSnapshot, () =>
      api.createWorktree({ workspaceId, fromSessionWorkspaceId, fromSessionId }),
    );
  };

  const handleRemoveWorktree = (workspaceId: string, worktree: WorktreeRecord) => {
    const confirmed = window.confirm(`Remove worktree ${worktree.name}? This removes the git worktree from disk.`);
    setEnvironmentMenuOpen(false);
    if (!confirmed) {
      return;
    }
    void updateSnapshot(api, setSnapshot, () =>
      api.removeWorktree({ workspaceId, worktreeId: worktree.id }),
    );
  };

  const handleSelectWorkspace = (workspaceId: string) => {
    setEnvironmentMenuOpen(false);
    void updateSnapshot(api, setSnapshot, () => api.selectWorkspace(workspaceId));
  };

  const setArchivedSectionOpen = (workspaceId: string, open: boolean) => {
    setExpandedArchivedByWorkspace((current) => ({ ...current, [workspaceId]: open }));
  };

  const handleArchiveSession = (rootWorkspaceId: string, target: { workspaceId: string; sessionId: string }) => {
    setArchivedSectionOpen(rootWorkspaceId, true);
    void updateSnapshot(api, setSnapshot, () => api.archiveSession(target));
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

  const focusComposer = () => {
    window.requestAnimationFrame(() => {
      composerRef.current?.focus();
    });
  };

  const closeSlashOptionMenu = () => {
    setActiveSlashFlow(undefined);
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
    setActiveSlashFlow({ command });
    setSlashOptionIndex(0);
    setComposerDraft("");
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
      openSettings(
        selectedWorkspace?.rootWorkspaceId ?? selectedWorkspace?.id,
        command.kind === "scoped-models" ? "models" : undefined,
      );
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

    if (activeSlashOptionCommand.kind === "model") {
      if (!selectedSession) {
        return;
      }
      resetSlashUi();
      setComposerDraft("");
      const modelOption = option as Extract<ComposerSlashOption, { value: string }> & { providerId?: string };
      const providerId = modelOption.providerId;
      if (!providerId) {
        return;
      }
      void updateSnapshot(api, setSnapshot, () =>
        api.setSessionModel(selectedWorkspace.id, selectedSession.id, providerId, option.value),
      ).then((state) => {
        setComposerDraft(state.composerDraft);
      });
      return;
    }

    if (activeSlashOptionCommand.kind === "thinking") {
      if (!selectedSession) {
        return;
      }
      resetSlashUi();
      setComposerDraft("");
      void updateSnapshot(api, setSnapshot, () =>
        api.setSessionThinkingLevel(
          selectedWorkspace.id,
          selectedSession.id,
          option.value as NonNullable<RuntimeSnapshot["settings"]["defaultThinkingLevel"]>,
        ),
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
      <SecondarySurface onBack={() => setActiveView("threads")} title="Skills">
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
      <aside className="sidebar">
        <div className="sidebar__top">
          <button
            className="sidebar__new"
            type="button"
            disabled={!selectedWorkspace}
            onClick={() => openNewThreadSurface()}
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
            className="sidebar__nav-item"
            type="button"
            onClick={() => openSkills(selectedWorkspace?.rootWorkspaceId ?? selectedWorkspace?.id)}
          >
              <SkillIcon />
              <span>Skills</span>
            </button>
          <button
            className="sidebar__nav-item"
            type="button"
            onClick={() => openSettings(selectedWorkspace?.rootWorkspaceId ?? selectedWorkspace?.id)}
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

          {visibleWorkspaces.length === 0 ? (
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
              {threadGroups.map(({ rootWorkspace, threads, archivedThreads }) => {
                const workspaceActive =
                  rootWorkspace.id === selectedWorkspace?.id ||
                  rootWorkspace.id === selectedWorkspace?.rootWorkspaceId;
                const linkedWorktree = linkedWorktreeByWorkspaceId.get(rootWorkspace.id);
                const archivedSectionOpen = expandedArchivedByWorkspace[rootWorkspace.id] ?? false;
                return (
                  <section key={rootWorkspace.id} className="workspace-group">
                    <div className={`workspace-row ${workspaceActive ? "workspace-row--active" : ""}`}>
                      <button
                        className="workspace-row__select"
                        onClick={() => handleSelectWorkspace(rootWorkspace.id)}
                        type="button"
                      >
                        <span className="workspace-row__icon" aria-hidden="true">
                          <FolderIcon />
                        </span>
                        <span className="workspace-row__name">{rootWorkspace.name}</span>
                        <span className="workspace-row__time">{formatRelativeTime(rootWorkspace.lastOpenedAt)}</span>
                      </button>
                      <span
                        className="workspace-row__menu-wrap"
                        ref={workspaceMenuId === rootWorkspace.id ? workspaceMenuWrapRef : undefined}
                      >
                        <button
                          aria-label={`Workspace actions for ${rootWorkspace.name}`}
                          aria-haspopup="menu"
                          className="icon-button workspace-row__menu-button"
                          aria-expanded={workspaceMenuId === rootWorkspace.id}
                          type="button"
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            setWorkspaceMenuId((current) => (current === rootWorkspace.id ? null : rootWorkspace.id));
                          }}
                        >
                          …
                        </button>
                        {workspaceMenuId === rootWorkspace.id ? (
                          <div className="workspace-menu">
                            <button
                              className="workspace-menu__item"
                              type="button"
                              onClick={(event) =>
                                runWorkspaceMenuAction(event, () => {
                                  void api.openWorkspaceInFinder(rootWorkspace.id);
                                })
                              }
                            >
                              Open in Finder
                            </button>
                            {linkedWorktree ? (
                              <button
                                className="workspace-menu__item workspace-menu__item--danger"
                                type="button"
                                onClick={(event) =>
                                  runWorkspaceMenuAction(event, () =>
                                    handleRemoveWorktree(linkedWorktree.rootWorkspaceId || rootWorkspace.id, linkedWorktree),
                                  )
                                }
                              >
                                Remove worktree
                              </button>
                            ) : (
                              <button
                                className="workspace-menu__item"
                                type="button"
                                onClick={(event) =>
                                  runWorkspaceMenuAction(event, () => handleCreateWorktree(rootWorkspace.id))
                                }
                              >
                                Create permanent worktree
                              </button>
                            )}
                            <button
                              className="workspace-menu__item"
                              type="button"
                              onClick={(event) => runWorkspaceMenuAction(event, () => handleWorkspaceRenameStart(rootWorkspace))}
                            >
                              Edit name
                            </button>
                            <button
                              className="workspace-menu__item workspace-menu__item--danger"
                              type="button"
                              onClick={(event) => runWorkspaceMenuAction(event, () => handleWorkspaceRemove(rootWorkspace))}
                            >
                              Remove
                            </button>
                          </div>
                        ) : null}
                      </span>
                    </div>
                    {workspaceRenameId === rootWorkspace.id ? (
                      <form
                        className="workspace-rename"
                        ref={workspaceRenamePanelRef}
                        onSubmit={(event) => {
                          event.preventDefault();
                          handleWorkspaceRenameSubmit(rootWorkspace);
                        }}
                      >
                        <input
                          aria-label={`Rename ${rootWorkspace.name}`}
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
                      {threads.map((thread) => {
                        const active = thread.workspaceId === selectedWorkspace?.id && thread.session.id === selectedSession?.id;
                        return (
                          <ThreadSessionRow
                            key={`${thread.workspaceId}:${thread.session.id}`}
                            active={active}
                            thread={thread}
                            onAction={() =>
                              handleArchiveSession(rootWorkspace.id, {
                                workspaceId: thread.workspaceId,
                                sessionId: thread.session.id,
                              })
                            }
                            onSelect={() => {
                              void updateSnapshot(api, setSnapshot, () =>
                                api.selectSession({ workspaceId: thread.workspaceId, sessionId: thread.session.id }),
                              );
                            }}
                          />
                        );
                      })}
                    </div>
                    {archivedThreads.length > 0 ? (
                      <div className="archived-thread-group">
                        <button
                          aria-expanded={archivedSectionOpen}
                          className="archived-thread-group__toggle"
                          type="button"
                          onClick={() => setArchivedSectionOpen(rootWorkspace.id, !archivedSectionOpen)}
                        >
                          <span
                            aria-hidden="true"
                            className={`archived-thread-group__chevron ${archivedSectionOpen ? "archived-thread-group__chevron--open" : ""}`}
                          >
                            <ChevronDownIcon />
                          </span>
                          <span>Archived</span>
                          <span className="archived-thread-group__count">{archivedThreads.length}</span>
                        </button>
                        {archivedSectionOpen ? (
                          <div className="session-list session-list--archived">
                            {archivedThreads.map((thread) => {
                              const active =
                                thread.workspaceId === selectedWorkspace?.id && thread.session.id === selectedSession?.id;
                              return (
                                <ThreadSessionRow
                                  key={`${thread.workspaceId}:${thread.session.id}`}
                                  active={active}
                                  archived
                                  thread={thread}
                                  onAction={() =>
                                    handleUnarchiveSession({
                                      workspaceId: thread.workspaceId,
                                      sessionId: thread.session.id,
                                    })
                                  }
                                  onSelect={() => {
                                    void updateSnapshot(api, setSnapshot, () =>
                                      api.selectSession({ workspaceId: thread.workspaceId, sessionId: thread.session.id }),
                                    );
                                  }}
                                />
                              );
                            })}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
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
              {rootWorkspace ? rootWorkspace.name : "Open a folder to begin"}
            </span>
            {selectedWorkspace && snapshot.activeView === "threads" ? (
              <>
                <span className="topbar__separator">/</span>
                <div className="environment-picker" ref={environmentMenuRef}>
                  <button
                    aria-expanded={environmentMenuOpen}
                    aria-haspopup="menu"
                    className="environment-picker__button"
                    type="button"
                    onClick={() => setEnvironmentMenuOpen((current) => !current)}
                  >
                    {selectedWorkspace.kind === "worktree" ? selectedWorktree?.name ?? selectedWorkspace.name : "Local"}
                  </button>
                  {environmentMenuOpen && rootWorkspace ? (
                    <div className="workspace-menu environment-picker__menu">
                      <button
                        className="workspace-menu__item"
                        type="button"
                        onClick={() => handleSelectWorkspace(rootWorkspace.id)}
                      >
                        Local
                      </button>
                      {activeWorktrees.map((worktree) => {
                        const linkedWorkspace = snapshot.workspaces.find(
                          (workspace) => workspace.id === worktree.linkedWorkspaceId,
                        );
                        const worktreeSelectable = Boolean(linkedWorkspace) && worktree.status === "ready";
                        return (
                          <button
                            className="workspace-menu__item"
                            key={worktree.id}
                            type="button"
                            disabled={!worktreeSelectable}
                            onClick={() => {
                              if (worktreeSelectable && linkedWorkspace) {
                                handleSelectWorkspace(linkedWorkspace.id);
                              }
                            }}
                          >
                            {worktree.name}
                            {!worktreeSelectable ? ` (${worktree.status !== "ready" ? worktree.status : "unavailable"})` : ""}
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              </>
            ) : null}
            {selectedWorkspace && snapshot.activeView === "threads" && selectedSession ? (
              <>
                <span className="topbar__separator">/</span>
                <span className="topbar__session">{selectedSession.title}</span>
              </>
            ) : snapshot.activeView === "new-thread" && rootWorkspace ? (
              <>
                <span className="topbar__separator">/</span>
                <span className="topbar__session">New thread</span>
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
              activeSlashCommand={activeSlashFlow?.command}
              activeSlashCommandMeta={describeActiveSlashFlow(activeSlashFlow?.command)}
              attachments={composerAttachments}
              composerDraft={composerDraft}
              composerRef={composerRef}
              onClearSlashCommand={resetSlashUi}
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

function ThreadSessionRow({
  active,
  archived = false,
  thread,
  onAction,
  onSelect,
}: {
  readonly active: boolean;
  readonly archived?: boolean;
  readonly thread: ThreadListEntry;
  readonly onAction: () => void;
  readonly onSelect: () => void;
}) {
  return (
    <div className={`session-row ${active ? "session-row--active" : ""}`}>
      <button className="session-row__select" onClick={onSelect} type="button">
        <span className={`session-row__status session-row__status--${thread.session.status}`} />
        <span className="session-row__body">
          <span className="session-row__title-line">
            <span className="session-row__title">{thread.session.title}</span>
          </span>
          {thread.session.preview ? <span className="session-row__preview">{thread.session.preview}</span> : null}
          <span className={`session-row__environment session-row__environment--${thread.environment.kind}`}>
            {thread.environment.kind === "local"
              ? "Local"
              : thread.environment.branchName
                ? `Worktree · ${thread.environment.branchName}`
                : "Worktree · Detached"}
          </span>
        </span>
      </button>
      <span className="session-row__trailing">
        <span className="session-row__time">{formatRelativeTime(thread.session.updatedAt)}</span>
        <button
          aria-label={`${archived ? "Restore" : "Archive"} ${thread.session.title}`}
          className="icon-button session-row__action"
          type="button"
          onClick={onAction}
        >
          {archived ? <RestoreIcon /> : <ArchiveIcon />}
        </button>
      </span>
    </div>
  );
}
