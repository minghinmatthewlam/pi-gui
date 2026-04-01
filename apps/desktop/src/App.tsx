import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type Dispatch, type DragEvent, type KeyboardEvent, type SetStateAction } from "react";
import type { RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import {
  getSelectedSession,
  getSelectedWorkspace,
  type AppView,
  type ComposerImageAttachment,
  type DesktopAppState,
  type NewThreadEnvironment,
  type SelectedTranscriptRecord,
  type StartThreadInput,
  type WorktreeRecord,
  type WorkspaceRecord,
} from "./desktop-state";
import { formatRelativeTime } from "./string-utils";
import { ComposerPanel } from "./composer-panel";
import { DiffPanel } from "./diff-panel";
import { buildModelOptions } from "./composer-commands";
import { desktopCommands, getDesktopCommandFromShortcut, type PiDesktopCommand } from "./ipc";
import { SkillsView } from "./skills-view";
import { ExtensionsView } from "./extensions-view";
import { SettingsView, type SettingsSection } from "./settings-view";
import { TimelineItem } from "./timeline-item";
import { SecondarySurface } from "./secondary-surface";
import { NewThreadView } from "./new-thread-view";
import { buildThreadGroups } from "./thread-groups";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";
import { ThreadSearchBar } from "./thread-search";
import { useSlashMenu } from "./hooks/use-slash-menu";
import { useMentionMenu } from "./hooks/use-mention-menu";
import { useThreadSearch } from "./hooks/use-thread-search";
import { useWorkspaceMenu } from "./hooks/use-workspace-menu";
import { buildExtensionDockModel, ExtensionDialog, hasExtensionDockContent } from "./extension-session-ui";
import { getEffectiveModelRuntime } from "./model-settings";
import { resolveRepoWorkspaceId } from "./workspace-roots";
import {
  extractImageFilesFromClipboardData,
  extractImageFilesFromDataTransfer,
  readComposerAttachmentsFromFiles,
} from "./composer-images";

function useDesktopAppState() {
  const [snapshot, setSnapshot] = useState<DesktopAppState | null>(null);
  const [selectedTranscript, setSelectedTranscript] = useState<SelectedTranscriptRecord | null>(null);

  useEffect(() => {
    let active = true;
    const api = window.piApp;
    if (!api) {
      return undefined;
    }

    void Promise.all([api.getState(), api.getSelectedTranscript()]).then(([state, transcript]) => {
      if (!active) {
        return;
      }
      setSnapshot(state);
      setSelectedTranscript(transcript);
    });

    const unsubscribeState = api.onStateChanged((state) => {
      if (active) {
        setSnapshot(state);
      }
    });
    const unsubscribeTranscript = api.onSelectedTranscriptChanged((payload) => {
      if (active) {
        setSelectedTranscript(payload);
      }
    });

    return () => {
      active = false;
      unsubscribeState();
      unsubscribeTranscript();
    };
  }, []);

  return [snapshot, setSnapshot, selectedTranscript] as const;
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
  const [snapshot, setSnapshot, selectedTranscript] = useDesktopAppState();
  const [composerDraft, setComposerDraft] = useState("");
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const [settingsWorkspaceId, setSettingsWorkspaceId] = useState("");
  const [skillsWorkspaceId, setSkillsWorkspaceId] = useState("");
  const [extensionsWorkspaceId, setExtensionsWorkspaceId] = useState("");
  const [newThreadRootWorkspaceId, setNewThreadRootWorkspaceId] = useState("");
  const [newThreadEnvironment, setNewThreadEnvironment] = useState<NewThreadEnvironment>("local");
  const [newThreadPrompt, setNewThreadPrompt] = useState("");
  const [newThreadAttachments, setNewThreadAttachments] = useState<readonly ComposerImageAttachment[]>([]);
  const [newThreadProvider, setNewThreadProvider] = useState<string | undefined>();
  const [newThreadModelId, setNewThreadModelId] = useState<string | undefined>();
  const [newThreadThinkingLevel, setNewThreadThinkingLevel] = useState<string | undefined>();
  const [themeMode, setThemeMode] = useState<"system" | "light" | "dark">("system");
  const [dockExpandedBySession, setDockExpandedBySession] = useState<Record<string, boolean>>({});
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const newThreadComposerRef = useRef<HTMLTextAreaElement | null>(null);
  const timelinePaneRef = useRef<HTMLDivElement | null>(null);
  const lastTranscriptMarkerRef = useRef("");
  const pinnedToBottomRef = useRef(true);
  const previousActiveViewRef = useRef<AppView | null>(null);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [showDiffPanel, setShowDiffPanel] = useState(false);
  const threadSearch = useThreadSearch(timelinePaneRef);
  const api = window.piApp;

  useEffect(() => {
    const piApi = window.piApp;
    if (!piApi) return;

    void piApi.getResolvedTheme().then((theme) => {
      document.documentElement.classList.toggle("dark", theme === "dark");
    });

    void piApi.getThemeMode().then((mode) => {
      setThemeMode(mode);
    });

    const unsub = piApi.onThemeChanged((theme) => {
      document.documentElement.classList.toggle("dark", theme === "dark");
    });

    return unsub;
  }, []);

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
    const nextRootWorkspaceId = resolveRepoWorkspaceId(snapshot.workspaces, selectedWorkspace?.id);
    const nextRootWorkspace =
      (nextRootWorkspaceId ? snapshot.workspaces.find((workspace) => workspace.id === nextRootWorkspaceId) : undefined)
      ?? selectedWorkspace;
    const nextRootWorkspaceOptions = [...new Set(snapshot.workspaces.map((workspace) => resolveRepoWorkspaceId(snapshot.workspaces, workspace.id) ?? workspace.id))]
      .map((workspaceId) => snapshot.workspaces.find((workspace) => workspace.id === workspaceId))
      .filter((workspace): workspace is WorkspaceRecord => Boolean(workspace));

    return {
      activeWorktrees: nextRootWorkspace ? snapshot.worktreesByWorkspace[nextRootWorkspace.id] ?? [] : [],
      linkedWorktreeByWorkspaceId: nextLinkedWorktreeByWorkspaceId,
      rootWorkspace: nextRootWorkspace,
      rootWorkspaceOptions: nextRootWorkspaceOptions,
      visibleWorkspaces: nextVisibleWorkspaces,
    };
  }, [selectedWorkspace, snapshot]);
  const selectedRuntime = selectedWorkspace ? snapshot?.runtimeByWorkspace[selectedWorkspace.id] : undefined;
  const selectedModelRuntime = snapshot ? getEffectiveModelRuntime(snapshot, selectedWorkspace) : undefined;
  const selectedWorktree = selectedWorkspace ? linkedWorktreeByWorkspaceId.get(selectedWorkspace.id) : undefined;
  const settingsWorkspace = settingsWorkspaceId
    ? rootWorkspaceOptions.find((workspace) => workspace.id === settingsWorkspaceId)
    : undefined;
  const skillsWorkspace = skillsWorkspaceId
    ? rootWorkspaceOptions.find((workspace) => workspace.id === skillsWorkspaceId)
    : undefined;
  const extensionsWorkspace = extensionsWorkspaceId
    ? rootWorkspaceOptions.find((workspace) => workspace.id === extensionsWorkspaceId)
    : undefined;
  const settingsRuntime = settingsWorkspace ? snapshot?.runtimeByWorkspace[settingsWorkspace.id] : undefined;
  const settingsModelRuntime = snapshot ? getEffectiveModelRuntime(snapshot, settingsWorkspace) : undefined;
  const skillsRuntime = skillsWorkspace ? snapshot?.runtimeByWorkspace[skillsWorkspace.id] : undefined;
  const extensionsRuntime = extensionsWorkspace ? snapshot?.runtimeByWorkspace[extensionsWorkspace.id] : undefined;
  const extensionsCommandCompatibility = extensionsWorkspace
    ? snapshot?.extensionCommandCompatibilityByWorkspace[extensionsWorkspace.id] ?? []
    : [];
  const newThreadWorkspace =
    rootWorkspaceOptions.find((entry) => entry.id === newThreadRootWorkspaceId) ?? rootWorkspaceOptions[0];
  const newThreadRuntime = snapshot ? getEffectiveModelRuntime(snapshot, newThreadWorkspace) : undefined;
  const newThreadDefaultEnabled = buildModelOptions(newThreadRuntime).some(
    (m) => m.providerId === newThreadRuntime?.settings.defaultProvider && m.modelId === newThreadRuntime?.settings.defaultModelId,
  );
  const resolvedNewThreadProvider = newThreadProvider ?? (newThreadDefaultEnabled ? newThreadRuntime?.settings.defaultProvider : undefined);
  const resolvedNewThreadModelId = newThreadModelId ?? (newThreadDefaultEnabled ? newThreadRuntime?.settings.defaultModelId : undefined);
  const resolvedNewThreadThinkingLevel = newThreadThinkingLevel ?? newThreadRuntime?.settings.defaultThinkingLevel;
  const [attachmentsClearedOnSubmit, setAttachmentsClearedOnSubmit] = useState(false);
  const composerAttachments = attachmentsClearedOnSubmit ? [] : (snapshot?.composerAttachments ?? []);
  const runningLabel = useRunningLabel(selectedSession?.status === "running" ? selectedSession.runningSince : undefined);
  const selectedSessionKey = `${selectedWorkspace?.id ?? ""}:${selectedSession?.id ?? ""}`;
  const activeTranscript =
    selectedTranscript &&
    selectedWorkspace &&
    selectedSession &&
    selectedTranscript.workspaceId === selectedWorkspace.id &&
    selectedTranscript.sessionId === selectedSession.id
      ? selectedTranscript.transcript
      : [];
  const isTranscriptLoading = Boolean(selectedSession) && activeTranscript.length === 0 && (
    !selectedTranscript ||
    selectedTranscript.workspaceId !== selectedWorkspace?.id ||
    selectedTranscript.sessionId !== selectedSession?.id
  );
  const selectedSessionCommands = selectedSession ? snapshot?.sessionCommandsBySession[selectedSessionKey] ?? [] : [];
  const selectedExtensionUi = selectedSession ? snapshot?.sessionExtensionUiBySession[selectedSessionKey] : undefined;
  const selectedWorkspaceCommandCompatibility = selectedWorkspace
    ? snapshot?.extensionCommandCompatibilityByWorkspace[selectedWorkspace.id] ?? []
    : [];
  const selectedExtensionDock = useMemo(() => buildExtensionDockModel(selectedExtensionUi), [selectedExtensionUi]);
  const displayedSessionTitle = selectedExtensionUi?.title ?? selectedSession?.title ?? "";
  const activeExtensionDialog = selectedExtensionUi?.pendingDialogs[0];
  const isSelectedExtensionDockExpanded = dockExpandedBySession[selectedSessionKey] ?? false;
  const persistedComposerDraft = snapshot?.composerDraft ?? "";
  const threadGroups = useMemo(
    () => (snapshot ? buildThreadGroups(snapshot) : []),
    [snapshot?.workspaces, snapshot?.worktreesByWorkspace, snapshot?.workspaceOrder],
  );
  const focusComposer = () => {
    window.requestAnimationFrame(() => {
      composerRef.current?.focus();
    });
  };
  const focusNewThreadComposer = () => {
    window.requestAnimationFrame(() => {
      newThreadComposerRef.current?.focus();
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
  });

  const mentionMenu = useMentionMenu({
    composerDraft,
    setComposerDraft,
    composerRef,
    workspaceId: selectedWorkspace?.id,
    api,
  });

  const newThreadSlashMenu = useSlashMenu({
    composerDraft: newThreadPrompt,
    setComposerDraft: setNewThreadPrompt,
    selectedRuntime: newThreadRuntime,
    selectedModelRuntime: newThreadRuntime,
    sessionCommands: [],
    commandCompatibility: [],
    selectedSessionKey: `new-thread:${newThreadWorkspace?.id ?? ""}`,
    selectedSession: undefined,
    selectedWorkspace: newThreadWorkspace,
    isRunning: false,
    api,
    setSnapshot,
    focusComposer: focusNewThreadComposer,
    openSettings,
    updateSnapshot,
    immediateCommandMode: "prefill",
    onSelectModelOption: (provider, modelId) => {
      setNewThreadProvider(provider);
      setNewThreadModelId(modelId);
    },
    onSelectThinkingOption: setNewThreadThinkingLevel,
    onSelectLoginProvider: (providerId) => {
      if (!api || !newThreadWorkspace) {
        return;
      }
      void updateSnapshot(api, setSnapshot, () => api.loginProvider(newThreadWorkspace.id, providerId));
    },
    onSelectLogoutProvider: (providerId) => {
      if (!api || !newThreadWorkspace) {
        return;
      }
      void updateSnapshot(api, setSnapshot, () => api.logoutProvider(newThreadWorkspace.id, providerId));
    },
  });

  const newThreadMentionMenu = useMentionMenu({
    composerDraft: newThreadPrompt,
    setComposerDraft: setNewThreadPrompt,
    composerRef: newThreadComposerRef,
    workspaceId: newThreadWorkspace?.id,
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
  }, [persistedComposerDraft, selectedSessionKey]);

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
      setNewThreadRootWorkspaceId("");
      setNewThreadEnvironment("local");
      setNewThreadAttachments([]);
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
  }, [selectedWorkspace?.id, selectedWorkspace?.rootWorkspaceId, threadSearch]);

  useEffect(() => {
    setShowJumpToLatest(false);
    lastTranscriptMarkerRef.current = "";
    pinnedToBottomRef.current = true;
  }, [selectedSessionKey]);

  useEffect(() => {
    if (!snapshot) {
      return;
    }

    if (snapshot.activeView === "new-thread" && previousActiveViewRef.current !== "new-thread") {
      const nextRootWorkspaceId = resolveRepoWorkspaceId(snapshot.workspaces, selectedWorkspace?.id);
      if (nextRootWorkspaceId) {
        setNewThreadRootWorkspaceId(nextRootWorkspaceId);
      }
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

    const marker = `${selectedSessionKey}:${activeTranscript.length}:${activeTranscript.at(-1)?.id ?? ""}`;
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
  }, [activeTranscript, selectedSession, selectedSessionKey]);

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

  const openExtensions = (workspaceId?: string) => {
    const nextWorkspaceId =
      workspaceId && rootWorkspaceOptions.some((workspace) => workspace.id === workspaceId)
        ? workspaceId
        : extensionsWorkspace?.id || rootWorkspaceOptions[0]?.id || "";
    if (nextWorkspaceId) {
      setExtensionsWorkspaceId(nextWorkspaceId);
    }
    setActiveView("extensions");
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
    setNewThreadAttachments([]);
    setNewThreadProvider(undefined);
    setNewThreadModelId(undefined);
    setNewThreadThinkingLevel(undefined);
    setActiveView("new-thread");
  };

  const handleSelectNewThreadWorkspace = (workspaceId: string) => {
    setNewThreadRootWorkspaceId(workspaceId);
    setNewThreadAttachments([]);
    setNewThreadProvider(undefined);
    setNewThreadModelId(undefined);
    setNewThreadThinkingLevel(undefined);
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
    setAttachmentsClearedOnSubmit(true);
    void (async () => {
      const nextState = await updateSnapshot(api, setSnapshot, () => api.submitComposer(previousDraft));
      setComposerDraft(nextState.composerDraft);
      setAttachmentsClearedOnSubmit(false);
    })().catch(() => {
      setComposerDraft(previousDraft);
      setAttachmentsClearedOnSubmit(false);
    });
  };

  const handlePickImages = () => {
    void updateSnapshot(api, setSnapshot, () => api.pickComposerImages());
  };

  const handleRemoveImage = (attachmentId: string) => {
    void updateSnapshot(api, setSnapshot, () => api.removeComposerImage(attachmentId));
  };

  const handleNewThreadAddImages = (files: File[]) => {
    void readComposerAttachmentsFromFiles(files).then((attachments) => {
      if (attachments.length === 0) {
        return;
      }
      setNewThreadAttachments((current) => [...current, ...attachments]);
    });
  };

  const handleNewThreadRemoveImage = (attachmentId: string) => {
    setNewThreadAttachments((current) => current.filter((attachment) => attachment.id !== attachmentId));
  };

  const handleImagePaste = (event: ClipboardEvent<HTMLDivElement>, onFiles: (files: File[]) => void) => {
    const files = extractImageFilesFromClipboardData(event.clipboardData);
    if (files.length === 0) {
      return;
    }
    event.preventDefault();
    onFiles(files);
  };

  const handleImageDrop = (event: DragEvent<HTMLDivElement>, onFiles: (files: File[]) => void) => {
    event.preventDefault();
    const files = extractImageFilesFromDataTransfer(event.dataTransfer);
    if (files.length === 0) {
      return;
    }
    onFiles(files);
  };

  const handleComposerPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    handleImagePaste(event, (files) => {
      void addImagesToSessionComposer(files);
    });
  };

  const handleNewThreadComposerPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    handleImagePaste(event, handleNewThreadAddImages);
  };

  const handleComposerDrop = (event: DragEvent<HTMLDivElement>) => {
    handleImageDrop(event, (files) => {
      void addImagesToSessionComposer(files);
    });
  };

  const handleNewThreadComposerDrop = (event: DragEvent<HTMLDivElement>) => {
    handleImageDrop(event, handleNewThreadAddImages);
  };

  async function addImagesToSessionComposer(files: File[]) {
    if (!api) {
      return;
    }
    const valid = await readComposerAttachmentsFromFiles(files);
    if (valid.length === 0) {
      return;
    }
    void updateSnapshot(api, setSnapshot, () => api.addComposerImages(valid));
  }

  const handleClipboardImageShortcut = (
    event: KeyboardEvent<HTMLTextAreaElement>,
    onImage: (attachment: ComposerImageAttachment) => void,
  ): boolean => {
    if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.key.toLowerCase() !== "v") {
      return false;
    }

    const clipboardImage = api?.readClipboardImage();
    if (!clipboardImage) {
      return false;
    }

    event.preventDefault();
    onImage(clipboardImage);
    return true;
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

  const handleSetModelSettingsScopeMode = (mode: "app-global" | "per-repo") => {
    if (!api) {
      return;
    }
    void updateSnapshot(api, setSnapshot, () => api.setModelSettingsScopeMode(mode));
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

  const handleToggleExtension = (filePath: string, enabled: boolean) => {
    if (!extensionsWorkspace) {
      return;
    }
    void updateSnapshot(api, setSnapshot, () => api.setExtensionEnabled(extensionsWorkspace.id, filePath, enabled));
  };

  const handleOpenExtensionFolder = (filePath: string) => {
    if (!extensionsWorkspace) {
      return;
    }
    void api.openExtensionInFinder(extensionsWorkspace.id, filePath);
  };

  const handleTrySkill = (command: string) => {
    void updateSnapshot(api, setSnapshot, () => api.setActiveView("threads"));
    slashMenu.fillComposerFromSlash(command);
  };

  const handleSetThemeMode = (mode: "system" | "light" | "dark") => {
    if (!api) return;
    setThemeMode(mode);
    void api.setThemeMode(mode);
  };

  const handleSetNotificationPreferences = (preferences: Partial<DesktopAppState["notificationPreferences"]>) => {
    void updateSnapshot(api, setSnapshot, () => api.setNotificationPreferences(preferences));
  };

  const handleArchiveSession = (target: { workspaceId: string; sessionId: string }) => {
    void updateSnapshot(api, setSnapshot, () => api.archiveSession(target));
  };

  const handleSelectSession = (target: { workspaceId: string; sessionId: string }) => {
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

  const handleStartThread = () => {
    if (!newThreadRootWorkspaceId || (!newThreadPrompt.trim() && newThreadAttachments.length === 0)) {
      return;
    }
    const modelConfig = {
      prompt: newThreadPrompt,
      attachments: newThreadAttachments,
      provider: resolvedNewThreadProvider,
      modelId: resolvedNewThreadModelId,
      thinkingLevel: resolvedNewThreadThinkingLevel,
    };
    const input: StartThreadInput = {
      rootWorkspaceId: newThreadRootWorkspaceId,
      environment: newThreadEnvironment,
      ...modelConfig,
    };
    wsMenu.expandWorkspace(newThreadRootWorkspaceId);
    void updateSnapshot(api, setSnapshot, () =>
      api.startThread(input),
    ).then(() => {
      setNewThreadPrompt("");
      setNewThreadAttachments([]);
      setNewThreadProvider(undefined);
      setNewThreadModelId(undefined);
      setNewThreadThinkingLevel(undefined);
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
    if (handleClipboardImageShortcut(event, (clipboardImage) => {
      void updateSnapshot(api, setSnapshot, () => api.addComposerImages([clipboardImage]));
    })) {
      return;
    }

    if (mentionMenu.handleMentionKeyDown(event)) {
      return;
    }

    if (slashMenu.handleSlashKeyDown(event)) {
      return;
    }

    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && selectedSession?.status === "running") {
      event.preventDefault();
      submitComposerDraft();
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

  const handleNewThreadComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (handleClipboardImageShortcut(event, (clipboardImage) => {
      setNewThreadAttachments((current) => [...current, clipboardImage]);
    })) {
      return;
    }

    if (newThreadMentionMenu.handleMentionKeyDown(event)) {
      return;
    }

    if (newThreadSlashMenu.handleSlashKeyDown(event)) {
      return;
    }

    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }

    event.preventDefault();
    if (!newThreadPrompt.trim() && newThreadAttachments.length === 0) {
      return;
    }

    handleStartThread();
  };

  const settingsNav = [
    { id: "appearance", label: "Appearance" },
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
        {settingsSection === "providers" || (settingsSection === "models" && snapshot.modelSettingsScopeMode === "per-repo") ? (
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
          runtime={settingsSection === "models" ? settingsModelRuntime : settingsRuntime}
          section={settingsSection}
          notificationPreferences={snapshot.notificationPreferences}
          modelSettingsScopeMode={snapshot.modelSettingsScopeMode}
          themeMode={themeMode}
          onLoginProvider={handleLoginProvider}
          onLogoutProvider={handleLogoutProvider}
          onRefresh={handleRefreshRuntime}
          onSetModelSettingsScopeMode={handleSetModelSettingsScopeMode}
          onSetDefaultModel={handleSetDefaultModel}
          onSetNotificationPreferences={handleSetNotificationPreferences}
          onSetScopedModelPatterns={handleSetScopedModelPatterns}
          onSetThemeMode={handleSetThemeMode}
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

  if (snapshot.activeView === "extensions") {
    return (
      <SecondarySurface onBack={() => setActiveView("threads")} testId="extensions-surface" title="Extensions">
        <div className="surface-toolbar">
          <label className="surface-toolbar__field">
            <span>Workspace</span>
            <select
              value={extensionsWorkspace?.id ?? ""}
              onChange={(event) => setExtensionsWorkspaceId(event.target.value)}
            >
              {rootWorkspaceOptions.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <ExtensionsView
          workspace={extensionsWorkspace}
          runtime={extensionsRuntime}
          commandCompatibility={extensionsCommandCompatibility}
          onOpenExtensionFolder={handleOpenExtensionFolder}
          onRefresh={() => {
            if (!extensionsWorkspace) {
              return;
            }
            void updateSnapshot(api, setSnapshot, () => api.refreshRuntime(extensionsWorkspace.id));
          }}
          onToggleExtension={handleToggleExtension}
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
        onNewThread={() => openNewThreadSurface(selectedWorkspace?.rootWorkspaceId ?? selectedWorkspace?.id)}
        onSetActiveView={setActiveView}
        onOpenSkills={openSkills}
        onOpenExtensions={openExtensions}
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
          selectedSessionTitle={displayedSessionTitle || selectedSession?.title}
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
              runtime={newThreadRuntime}
              environment={newThreadEnvironment}
              prompt={newThreadPrompt}
              attachments={newThreadAttachments}
              provider={resolvedNewThreadProvider}
              modelId={resolvedNewThreadModelId}
              thinkingLevel={resolvedNewThreadThinkingLevel}
              composerRef={newThreadComposerRef}
              activeSlashCommand={newThreadSlashMenu.activeSlashFlow?.command}
              activeSlashCommandMeta={newThreadSlashMenu.activeSlashFlow?.command?.description}
              slashSections={newThreadSlashMenu.slashSections}
              slashOptions={newThreadSlashMenu.slashOptions}
              selectedSlashCommand={newThreadSlashMenu.activeSlashOptionCommand ?? newThreadSlashMenu.selectedSlashCommand}
              selectedSlashOption={newThreadSlashMenu.selectedSlashOption}
              showSlashMenu={newThreadSlashMenu.showSlashMenu}
              showSlashOptionMenu={newThreadSlashMenu.showSlashOptionMenu}
              slashOptionEmptyState={newThreadSlashMenu.slashOptionEmptyState}
              showMentionMenu={newThreadMentionMenu.showMentionMenu}
              mentionOptions={newThreadMentionMenu.mentionOptions}
              selectedMentionIndex={newThreadMentionMenu.selectedIndex}
              onChangePrompt={setNewThreadPrompt}
              onSelectEnvironment={setNewThreadEnvironment}
              onSelectWorkspace={handleSelectNewThreadWorkspace}
              onSetModel={(provider, modelId) => { setNewThreadProvider(provider); setNewThreadModelId(modelId); }}
              onSetThinking={setNewThreadThinkingLevel}
              onComposerKeyDown={handleNewThreadComposerKeyDown}
              onComposerPaste={handleNewThreadComposerPaste}
              onComposerDrop={handleNewThreadComposerDrop}
              onClearSlashCommand={newThreadSlashMenu.resetSlashUi}
              onSelectSlashCommand={(command) => {
                newThreadSlashMenu.applySlashCommandSelection(command, "click");
              }}
              onSelectSlashOption={(option) => {
                newThreadSlashMenu.applySlashOptionSelection(option);
              }}
              onSelectMention={newThreadMentionMenu.insertMention}
              onAddImages={handleNewThreadAddImages}
              onRemoveImage={handleNewThreadRemoveImage}
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
                    <h1 className="chat-header__title">{displayedSessionTitle}</h1>
                    <div className="chat-header__status">
                      {selectedSession.status === "running" ? runningLabel : formatRelativeTime(selectedSession.updatedAt)}
                    </div>
                  </div>
                </div>

                <div className="timeline-pane" ref={timelinePaneRef} onScroll={handleTimelineScroll}>
                  {threadSearch.isOpen ? (
                    <ThreadSearchBar
                      query={threadSearch.query}
                      matchCount={threadSearch.matchCount}
                      activeIndex={threadSearch.activeIndex}
                      inputRef={threadSearch.inputRef}
                      onSearch={threadSearch.search}
                      onNext={() => threadSearch.goToMatch(1)}
                      onPrev={() => threadSearch.goToMatch(-1)}
                      onClose={threadSearch.close}
                    />
                  ) : null}
                  <div className="timeline" data-testid="transcript">
                    {isTranscriptLoading ? (
                      <div className="timeline-empty">Loading transcript…</div>
                    ) : activeTranscript.length === 0 ? (
                      <div className="timeline-empty">Send a prompt to start the session.</div>
                    ) : (
                      activeTranscript.map((item) => (
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
              key={selectedSessionKey}
              activeSlashCommand={slashMenu.activeSlashFlow?.command}
              activeSlashCommandMeta={slashMenu.activeSlashFlow?.command?.description}
              attachments={composerAttachments}
              composerDraft={composerDraft}
              composerRef={composerRef}
              runtime={selectedModelRuntime}
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
              onSetModel={handleSetSessionModel}
              onSetThinking={handleSetSessionThinking}
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
              extensionDock={selectedExtensionDock}
              extensionDockExpanded={isSelectedExtensionDockExpanded}
              onToggleExtensionDock={handleToggleExtensionDock}
            />
            {activeExtensionDialog ? (
              <ExtensionDialog dialog={activeExtensionDialog} onRespond={handleRespondToExtensionDialog} />
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
                  onClick={() => openNewThreadSurface(selectedWorkspace?.rootWorkspaceId ?? selectedWorkspace?.id)}
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

        {showDiffPanel && selectedWorkspace ? (
          <DiffPanel
            workspaceId={selectedWorkspace.id}
            api={api}
            sessionStatus={selectedSession?.status}
          />
        ) : null}
      </main>
    </div>
  );
}

function isNearBottom(element: HTMLDivElement): boolean {
  const remaining = element.scrollHeight - element.scrollTop - element.clientHeight;
  return remaining < 32;
}
