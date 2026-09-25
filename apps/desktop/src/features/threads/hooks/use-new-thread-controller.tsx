import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type Dispatch,
  type DragEvent,
  type KeyboardEvent,
  type SetStateAction,
} from "react";
import {
  type AppView,
  type ComposerAttachment,
  type DesktopAppState,
  type NewThreadEnvironment,
  type StartThreadInput,
  type WorkspaceRecord,
} from "../../../../contracts/desktop-state";
import { acceptComposerAttachments } from "../../../../contracts/composer-attachments";
import { updateSnapshot } from "../../../app/desktop-app-state";
import {
  extractFilesFromDataTransfer,
  extractImageFilesFromClipboardData,
  handleClipboardImageShortcut,
  readComposerAttachmentsFromFiles,
} from "../../conversation/composer-attachments";
import { buildModelOptions, parseTreeComposerCommand } from "../../conversation/composer-commands";
import type { PiDesktopApi } from "../../../../contracts/ipc";
import { deriveModelOnboardingState } from "../../settings/model-onboarding";
import { getEffectiveModelRuntime } from "../../settings/model-settings";
import type { SettingsSection } from "../../settings/settings-view";
import { useMentionMenu } from "../../conversation/hooks/use-mention-menu";
import { useSlashMenu } from "../../conversation/hooks/use-slash-menu";
import { resolveRepoWorkspaceId } from "../../../../contracts/workspace-roots";

interface UseNewThreadControllerParams {
  readonly api: PiDesktopApi | undefined;
  readonly snapshot: DesktopAppState | null;
  readonly setSnapshot: Dispatch<SetStateAction<DesktopAppState | null>>;
  readonly rootWorkspace: WorkspaceRecord | undefined;
  readonly rootWorkspaceOptions: readonly WorkspaceRecord[];
  readonly visibleWorkspaces: readonly WorkspaceRecord[];
  readonly selectedWorkspace: WorkspaceRecord | undefined;
  readonly openSettings: (workspaceId?: string, section?: SettingsSection) => void;
  readonly flushComposerDraft: () => void;
}

export function useNewThreadController(params: UseNewThreadControllerParams) {
  const {
    api,
    snapshot,
    setSnapshot,
    rootWorkspace,
    rootWorkspaceOptions,
    visibleWorkspaces,
    selectedWorkspace,
    openSettings,
    flushComposerDraft,
  } = params;

  const [pendingWorkspaceId, setPendingWorkspaceId] = useState("");
  const [rootWorkspaceId, setRootWorkspaceId] = useState("");
  const [environment, setEnvironment] = useState<NewThreadEnvironment>("local");
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState<readonly ComposerAttachment[]>([]);
  const [provider, setProvider] = useState<string | undefined>();
  const [modelId, setModelId] = useState<string | undefined>();
  const [thinkingLevel, setThinkingLevel] = useState<string | undefined>();
  const [composerError, setComposerError] = useState<string | undefined>();
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const previousActiveViewRef = useRef<AppView | null>(null);

  const workspace =
    rootWorkspaceOptions.find((entry) => entry.id === rootWorkspaceId) ?? rootWorkspaceOptions[0];
  const runtime = snapshot ? getEffectiveModelRuntime(snapshot, workspace) : undefined;
  const defaultEnabled = buildModelOptions(runtime).some(
    (m) =>
      m.providerId === runtime?.settings.defaultProvider &&
      m.modelId === runtime?.settings.defaultModelId,
  );
  const resolvedProvider =
    provider ?? (defaultEnabled ? runtime?.settings.defaultProvider : undefined);
  const resolvedModelId =
    modelId ?? (defaultEnabled ? runtime?.settings.defaultModelId : undefined);
  const resolvedThinkingLevel = thinkingLevel ?? runtime?.settings.defaultThinkingLevel;
  const modelOnboarding = deriveModelOnboardingState(runtime, {
    provider: resolvedProvider,
    modelId: resolvedModelId,
  });

  const focusComposer = useCallback(() => {
    window.requestAnimationFrame(() => {
      composerRef.current?.focus();
    });
  }, []);

  const updatePrompt = useCallback((value: SetStateAction<string>) => {
    setComposerError(undefined);
    setPrompt(value);
  }, []);

  const addAttachments = useCallback(
    (files: File[]) => {
      void readComposerAttachmentsFromFiles(files, attachments)
        .then((added) => {
          if (added.length === 0) {
            return;
          }
          setAttachments((current) => {
            const accepted = acceptComposerAttachments(current, added);
            if (!accepted.ok) {
              setComposerError(accepted.error.message);
              return current;
            }
            setComposerError(undefined);
            return [...current, ...accepted.attachments];
          });
        })
        .catch((error: unknown) => {
          setComposerError(error instanceof Error ? error.message : String(error));
        });
    },
    [attachments],
  );

  const removeAttachment = useCallback((attachmentId: string) => {
    setAttachments((current) => current.filter((attachment) => attachment.id !== attachmentId));
  }, []);

  const appendAttachment = useCallback((attachment: ComposerAttachment) => {
    setAttachments((current) => {
      const accepted = acceptComposerAttachments(current, [attachment]);
      if (!accepted.ok) {
        setComposerError(accepted.error.message);
        return current;
      }
      setComposerError(undefined);
      return [...current, ...accepted.attachments];
    });
  }, []);

  // Each fresh New thread surface gets a generation, so a start still in flight from an
  // earlier surface neither blocks nor clears what the user types into this one.
  const surfaceGenerationRef = useRef(0);
  const startingGenerationRef = useRef<number | undefined>(undefined);
  const resetSurface = useCallback(
    (workspaceId?: string) => {
      surfaceGenerationRef.current += 1;
      const nextWorkspaceId =
        (workspaceId &&
          (rootWorkspaceOptions.find((w) => w.id === workspaceId)?.id ||
            (snapshot ? resolveRepoWorkspaceId(snapshot.workspaces, workspaceId) : undefined))) ||
        rootWorkspace?.id ||
        visibleWorkspaces[0]?.id ||
        "";
      if (nextWorkspaceId) {
        setRootWorkspaceId(nextWorkspaceId);
      }
      setEnvironment("local");
      setPrompt("");
      setAttachments([]);
      setProvider(undefined);
      setModelId(undefined);
      setThinkingLevel(undefined);
      setComposerError(undefined);
    },
    [rootWorkspace?.id, rootWorkspaceOptions, snapshot, visibleWorkspaces],
  );

  const openSurface = useCallback(
    (workspaceId?: string) => {
      // Save the outgoing conversation before the new-thread flow can change its selection.
      flushComposerDraft();
      setPendingWorkspaceId("");
      resetSurface(workspaceId);
      if (api) {
        void updateSnapshot(setSnapshot, () => api.setActiveView("new-thread")).catch(
          (error: unknown) => {
            console.error("[renderer] setActiveView failed", error);
          },
        );
      }
    },
    [api, flushComposerDraft, resetSurface, setSnapshot],
  );

  const selectWorkspace = useCallback((workspaceId: string) => {
    setPendingWorkspaceId("");
    setRootWorkspaceId(workspaceId);
    setAttachments([]);
    setProvider(undefined);
    setModelId(undefined);
    setThinkingLevel(undefined);
    setComposerError(undefined);
  }, []);

  const slashMenu = useSlashMenu({
    composerDraft: prompt,
    setComposerDraft: updatePrompt,
    selectedRuntime: runtime,
    selectedModelRuntime: runtime,
    sessionCommands: [],
    commandCompatibility: [],
    selectedSessionKey: `new-thread:${workspace?.id ?? ""}`,
    selectedSession: undefined,
    selectedWorkspace: workspace,
    isRunning: false,
    api,
    setSnapshot,
    focusComposer,
    openSettings,
    updateSnapshot,
    allowTreeCommand: false,
    immediateCommandMode: "prefill",
    onSelectModelOption: (nextProvider, nextModelId) => {
      setProvider(nextProvider);
      setModelId(nextModelId);
    },
    onSelectThinkingOption: setThinkingLevel,
    onSelectLoginProvider: (providerId) => {
      if (!api || !workspace) {
        return;
      }
      void updateSnapshot(setSnapshot, () => api.loginProvider(workspace.id, providerId)).catch(
        (error: unknown) => {
          console.error("[renderer] loginProvider failed", error);
        },
      );
    },
    onSelectLogoutProvider: (providerId) => {
      if (!api || !workspace) {
        return;
      }
      void updateSnapshot(setSnapshot, () => api.logoutProvider(workspace.id, providerId)).catch(
        (error: unknown) => {
          console.error("[renderer] logoutProvider failed", error);
        },
      );
    },
  });

  const enableMentionExtension = useCallback(
    (filePath: string) => {
      if (!api || !workspace) {
        return Promise.resolve();
      }
      return updateSnapshot(setSnapshot, () =>
        api.setExtensionEnabled(workspace.id, filePath, true),
      ).then(() => undefined);
    },
    [api, setSnapshot, workspace],
  );

  const mentionMenu = useMentionMenu({
    composerDraft: prompt,
    setComposerDraft: setPrompt,
    composerRef,
    workspaceId: workspace?.id,
    runtime,
    api,
    onEnableExtension: enableMentionExtension,
  });

  const startThread = useCallback(() => {
    // The prompt clears only once the thread exists, so a second Enter or click before
    // then would otherwise start the same thread again (a worktree start takes seconds).
    const generation = surfaceGenerationRef.current;
    if (!api || startingGenerationRef.current === generation) {
      return;
    }
    if (!rootWorkspaceId || (!prompt.trim() && attachments.length === 0)) {
      return;
    }
    if (modelOnboarding.requiresModelSelection) {
      return;
    }
    const treeCommand = parseTreeComposerCommand(prompt);
    if (treeCommand?.type === "error") {
      setComposerError(treeCommand.message);
      return;
    }
    if (treeCommand?.type === "tree") {
      setComposerError("/tree is only available inside an existing session.");
      return;
    }
    const input: StartThreadInput = {
      rootWorkspaceId,
      environment,
      prompt,
      attachments,
      provider: resolvedProvider,
      modelId: resolvedModelId,
      thinkingLevel: resolvedThinkingLevel,
    };
    startingGenerationRef.current = generation;
    void updateSnapshot(setSnapshot, () => api.startThread(input))
      .then(() => {
        if (surfaceGenerationRef.current !== generation) {
          return;
        }
        setPrompt("");
        setAttachments([]);
        setProvider(undefined);
        setModelId(undefined);
        setThinkingLevel(undefined);
        setEnvironment("local");
      })
      .catch((error: unknown) => {
        setComposerError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (startingGenerationRef.current === generation) {
          startingGenerationRef.current = undefined;
        }
      });
  }, [
    api,
    attachments,
    environment,
    modelOnboarding.requiresModelSelection,
    prompt,
    resolvedModelId,
    resolvedProvider,
    resolvedThinkingLevel,
    rootWorkspaceId,
    setSnapshot,
  ]);

  const handleComposerPaste = useCallback(
    (event: ClipboardEvent<HTMLDivElement>) => {
      const files = extractImageFilesFromClipboardData(event.clipboardData);
      if (files.length === 0) {
        return;
      }
      event.preventDefault();
      addAttachments(files);
    },
    [addAttachments],
  );

  const handleComposerDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      const files = extractFilesFromDataTransfer(event.dataTransfer);
      if (files.length === 0) {
        return;
      }
      addAttachments(files);
    },
    [addAttachments],
  );

  const handleComposerKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (
        handleClipboardImageShortcut(
          event,
          api?.readClipboardImage,
          appendAttachment,
          setComposerError,
        )
      ) {
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
      if (!prompt.trim() && attachments.length === 0) {
        return;
      }
      if (modelOnboarding.requiresModelSelection) {
        return;
      }

      startThread();
    },
    [
      api,
      appendAttachment,
      attachments.length,
      mentionMenu,
      modelOnboarding.requiresModelSelection,
      prompt,
      slashMenu,
      startThread,
    ],
  );

  useEffect(() => {
    if (rootWorkspaceOptions.length === 0) {
      setPendingWorkspaceId("");
      setRootWorkspaceId("");
      setEnvironment("local");
      setAttachments([]);
      return;
    }
    setRootWorkspaceId((current) =>
      rootWorkspaceOptions.some((w) => w.id === current)
        ? current
        : current || rootWorkspaceOptions[0]?.id || "",
    );
  }, [rootWorkspaceOptions]);

  useEffect(() => {
    if (!snapshot || !pendingWorkspaceId) {
      return;
    }
    const nextRootWorkspaceId = resolveRepoWorkspaceId(snapshot.workspaces, pendingWorkspaceId);
    if (!nextRootWorkspaceId || !rootWorkspaceOptions.some((w) => w.id === nextRootWorkspaceId)) {
      return;
    }
    setRootWorkspaceId(nextRootWorkspaceId);
    setPendingWorkspaceId("");
  }, [pendingWorkspaceId, rootWorkspaceOptions, snapshot]);

  useEffect(() => {
    if (!snapshot) {
      return;
    }
    if (snapshot.activeView === "new-thread" && previousActiveViewRef.current !== "new-thread") {
      const nextRootWorkspaceId = resolveRepoWorkspaceId(
        snapshot.workspaces,
        selectedWorkspace?.id,
      );
      if (nextRootWorkspaceId) {
        setRootWorkspaceId(nextRootWorkspaceId);
      }
    }
    previousActiveViewRef.current = snapshot.activeView;
  }, [selectedWorkspace?.id, snapshot]);

  return useMemo(
    () => ({
      composerRef,
      workspace,
      runtime,
      rootWorkspaceId,
      environment,
      prompt,
      attachments,
      composerError,
      resolvedProvider,
      resolvedModelId,
      resolvedThinkingLevel,
      modelOnboarding,
      slashMenu,
      mentionMenu,
      setPrompt,
      setEnvironment,
      setProvider,
      setModelId,
      setThinkingLevel,
      setPendingWorkspaceId,
      selectWorkspace,
      addAttachments,
      removeAttachment,
      appendAttachment,
      handleComposerPaste,
      handleComposerDrop,
      handleComposerKeyDown,
      startThread,
      openSurface,
      resetSurface,
      setComposerError,
    }),
    [
      workspace,
      runtime,
      rootWorkspaceId,
      environment,
      prompt,
      attachments,
      composerError,
      resolvedProvider,
      resolvedModelId,
      resolvedThinkingLevel,
      modelOnboarding,
      slashMenu,
      mentionMenu,
      selectWorkspace,
      addAttachments,
      removeAttachment,
      appendAttachment,
      handleComposerPaste,
      handleComposerDrop,
      handleComposerKeyDown,
      startThread,
      openSurface,
      resetSurface,
    ],
  );
}
