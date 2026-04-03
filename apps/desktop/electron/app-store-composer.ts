import { sessionKey } from "@pi-gui/pi-sdk-driver";
import type { SessionConfig, SessionRef } from "@pi-gui/session-driver";
import type { ComposerAttachment, DesktopAppState, WorkspaceSessionTarget } from "../src/desktop-state";
import { toSessionRef } from "./app-store-utils";
import {
  formatSessionConfigStatus,
  hasRuntimeSlashCommand,
  incompleteComposerCommandMessage,
  parseComposerCommand,
  resolveRuntimeSlashCommand,
} from "../src/composer-commands";
import { appendUserMessage, clearActiveAssistantMessage } from "./app-store-timeline";
import {
  cloneComposerAttachments,
  makeActivityItem,
  previewFromTranscript,
  toSessionAttachments,
  toTranscriptAttachments,
} from "./app-store-utils";
import type { AppStoreInternals } from "./app-store-internals";

/* ── Public methods ─────────────────────────────────────── */

export async function updateComposerDraft(
  store: AppStoreInternals,
  composerDraft: string,
): Promise<DesktopAppState> {
  await store.initialize();
  const sessionRef = store.selectedSessionRef();
  if (sessionRef) {
    const key = sessionKey(sessionRef);
    if (composerDraft) {
      store.sessionState.composerDraftsBySession.set(key, composerDraft);
    } else {
      store.sessionState.composerDraftsBySession.delete(key);
    }
  }
  store.state = {
    ...store.state,
    composerDraft,
    lastError: undefined,
    revision: store.state.revision + 1,
  };
  await store.persistUiState();
  return store.emit();
}

export async function addComposerAttachments(
  store: AppStoreInternals,
  attachments: readonly ComposerAttachment[],
): Promise<DesktopAppState> {
  await store.initialize();
  const sessionRef = store.selectedSessionRef();
  if (!sessionRef || attachments.length === 0) {
    return store.emit();
  }

  const key = sessionKey(sessionRef);
  const existing = store.sessionState.composerAttachmentsBySession.get(key) ?? [];
  const next = [...existing, ...attachments];
  store.sessionState.composerAttachmentsBySession.set(key, next);
  store.state = {
    ...store.state,
    composerAttachments: cloneComposerAttachments(next),
    revision: store.state.revision + 1,
  };
  await store.persistComposerAttachments(key, next);
  return store.emit();
}

export async function removeComposerAttachment(
  store: AppStoreInternals,
  attachmentId: string,
): Promise<DesktopAppState> {
  await store.initialize();
  const sessionRef = store.selectedSessionRef();
  if (!sessionRef) {
    return store.emit();
  }

  const key = sessionKey(sessionRef);
  const existing = store.sessionState.composerAttachmentsBySession.get(key) ?? [];
  const next = existing.filter((attachment) => attachment.id !== attachmentId);
  if (next.length > 0) {
    store.sessionState.composerAttachmentsBySession.set(key, next);
  } else {
    store.sessionState.composerAttachmentsBySession.delete(key);
  }
  store.state = {
    ...store.state,
    composerAttachments: cloneComposerAttachments(next),
    revision: store.state.revision + 1,
  };
  await store.persistComposerAttachments(key, next);
  return store.emit();
}

export async function submitComposer(store: AppStoreInternals, textInput: string): Promise<DesktopAppState> {
  await store.initialize();
  const text = textInput.trim();
  const sessionRef = store.selectedSessionRef();
  const attachments = sessionRef
    ? store.sessionState.composerAttachmentsBySession.get(sessionKey(sessionRef)) ?? []
    : [];
  if (!text && attachments.length === 0) {
    return store.emit();
  }
  if (!sessionRef) {
    return store.withError("Create or select a session before sending a message.");
  }

  const runtime = store.runtimeByWorkspace.get(sessionRef.workspaceId);
  const sessionCommands = store.sessionState.sessionCommandsBySession.get(sessionKey(sessionRef)) ?? [];
  const runtimeSlashCommand = hasRuntimeSlashCommand(text, runtime, sessionCommands);
  const resolvedRuntimeSlashCommand = runtimeSlashCommand
    ? resolveRuntimeSlashCommand(text, runtime, sessionCommands)
    : undefined;

  if (text.startsWith("/") && !runtimeSlashCommand) {
    const handled = await runComposerCommand(store, sessionRef, text);
    if (handled) {
      return handled;
    }
  }

  const key = sessionKey(sessionRef);
  try {
    if (resolvedRuntimeSlashCommand) {
      const learnedCompatibility = store.getLearnedRuntimeCommandCompatibility(sessionRef.workspaceId, resolvedRuntimeSlashCommand);
      if (learnedCompatibility?.status === "terminal-only") {
        store.sessionState.composerDraftsBySession.set(key, textInput);
        if (attachments.length > 0) {
          store.sessionState.composerAttachmentsBySession.set(key, cloneComposerAttachments(attachments));
          await store.persistComposerAttachments(key, attachments);
        }
        store.state = {
          ...store.state,
          composerDraft: textInput,
          composerAttachments: cloneComposerAttachments(attachments),
          revision: store.state.revision + 1,
        };
        return store.withError(learnedCompatibility.message);
      }

      store.beginRuntimeCommandExecution(sessionRef, resolvedRuntimeSlashCommand);
    }
    await sendMessageToSession(store, sessionRef, text, attachments);
    const runtimeCommandOutcome = resolvedRuntimeSlashCommand
      ? store.finishRuntimeCommandExecution(sessionRef)
      : undefined;
    if (runtimeSlashCommand) {
      await store.refreshSessionCommandsFor(sessionRef);
    }
    return store.refreshState({
      clearLastError: !runtimeCommandOutcome?.blockedMessage,
      markSelectedSessionViewed: false,
    });
  } catch (error) {
    if (resolvedRuntimeSlashCommand) {
      store.finishRuntimeCommandExecution(sessionRef);
    }
    if (textInput) {
      store.sessionState.composerDraftsBySession.set(key, textInput);
    }
    if (attachments.length > 0) {
      store.sessionState.composerAttachmentsBySession.set(key, cloneComposerAttachments(attachments));
      await store.persistComposerAttachments(key, attachments);
    }
    return store.withError(error);
  }
}

export async function setSessionModel(
  store: AppStoreInternals,
  target: WorkspaceSessionTarget,
  provider: string,
  modelId: string,
): Promise<DesktopAppState> {
  await store.initialize();
  const sessionRef = toSessionRef(target);
  const key = sessionKey(sessionRef);

  return store.withErrorHandling(async () => {
    await store.driver.setSessionModel(sessionRef, { provider, modelId });
    syncSessionConfig(store, key, { provider, modelId });
    return finishComposerCommand(store, sessionRef, key, `Model set to ${provider}:${modelId}`);
  });
}

export async function setSessionThinkingLevel(
  store: AppStoreInternals,
  sessionRef: SessionRef,
  thinkingLevel: string,
): Promise<DesktopAppState> {
  await store.initialize();
  const key = sessionKey(sessionRef);
  return store.withErrorHandling(async () => {
    await store.driver.setSessionThinkingLevel(sessionRef, thinkingLevel);
    syncSessionConfig(store, key, { thinkingLevel });
    return finishComposerCommand(store, sessionRef, key, `Thinking set to ${thinkingLevel}`);
  });
}

export async function cancelCurrentRun(store: AppStoreInternals): Promise<DesktopAppState> {
  await store.initialize();
  const sessionRef = store.selectedSessionRef();
  if (!sessionRef) {
    return store.emit();
  }

  return store.withErrorHandling(async () => {
    await store.driver.cancelCurrentRun(sessionRef);
    clearActiveAssistantMessage(store.sessionState.activeAssistantMessageBySession, sessionRef);
    store.sessionState.sessionErrorsBySession.delete(sessionKey(sessionRef));
    store.state = {
      ...store.state,
      lastError: undefined,
      revision: store.state.revision + 1,
    };
    store.schedulePersistUiState();
    return store.emit();
  });
}

/* ── Internal helpers ───────────────────────────────────── */

export async function sendMessageToSession(
  store: AppStoreInternals,
  sessionRef: SessionRef,
  text: string,
  attachments: readonly ComposerAttachment[],
  options: {
    readonly rollbackOptimisticMessageOnError?: boolean;
  } = {},
): Promise<void> {
  const key = sessionKey(sessionRef);
  const rollbackOptimisticMessageOnError = options.rollbackOptimisticMessageOnError ?? true;
  if (!store.sessionState.loadedTranscriptKeys.has(key)) {
    await store.ensureSessionReady(sessionRef);
  }
  if (store.sessionFromState(sessionRef)?.archivedAt) {
    await store.driver.unarchiveSession(sessionRef);
  }
  appendUserMessage(
    store.sessionState.transcriptCache,
    sessionRef,
    text,
    toTranscriptAttachments(attachments),
  );
  store.publishSelectedTranscriptFor(sessionRef);
  store.persistTranscriptCacheForSession(sessionRef);
  clearActiveAssistantMessage(store.sessionState.activeAssistantMessageBySession, sessionRef);
  store.sessionState.sessionErrorsBySession.delete(key);
  store.sessionState.composerDraftsBySession.delete(key);
  store.sessionState.composerAttachmentsBySession.delete(key);
  await store.persistComposerAttachments(key, []);
  try {
    await store.driver.sendUserMessage(sessionRef, {
      text,
      attachments: toSessionAttachments(attachments),
    });
  } catch (error) {
    if (rollbackOptimisticMessageOnError) {
      const transcript = store.sessionState.transcriptCache.get(key) ?? [];
      store.sessionState.transcriptCache.set(key, transcript.slice(0, -1));
      store.publishSelectedTranscriptFor(sessionRef);
      store.persistTranscriptCacheForSession(sessionRef);
    }
    throw error;
  }
}

/** Eagerly merge config fields so finishComposerCommand sees them before the async sessionUpdated event arrives. */
function syncSessionConfig(store: AppStoreInternals, key: string, patch: Partial<SessionConfig>): void {
  const current = store.sessionState.sessionConfigBySession.get(key) ?? {};
  store.sessionState.sessionConfigBySession.set(key, { ...current, ...patch });
}

async function runComposerCommand(
  store: AppStoreInternals,
  sessionRef: SessionRef,
  commandText: string,
): Promise<DesktopAppState | undefined> {
  const parsed = parseComposerCommand(commandText);
  if (!parsed) {
    const message = incompleteComposerCommandMessage(commandText);
    if (message) {
      return store.withError(message);
    }
    return undefined;
  }

  const key = sessionKey(sessionRef);

  if (parsed.type === "model") {
    await store.driver.setSessionModel(sessionRef, {
      provider: parsed.provider,
      modelId: parsed.modelId,
    });
    syncSessionConfig(store, key, { provider: parsed.provider, modelId: parsed.modelId });
    return finishComposerCommand(store, sessionRef, key, `Model set to ${parsed.provider}:${parsed.modelId}`);
  }

  if (parsed.type === "thinking") {
    await store.driver.setSessionThinkingLevel(sessionRef, parsed.thinkingLevel);
    syncSessionConfig(store, key, { thinkingLevel: parsed.thinkingLevel });
    return finishComposerCommand(store, sessionRef, key, `Thinking set to ${parsed.thinkingLevel}`);
  }

  if (parsed.type === "status") {
    return finishComposerCommand(
      store,
      sessionRef,
      key,
      formatSessionConfigStatus(store.sessionState.sessionConfigBySession.get(key)),
    );
  }

  if (parsed.type === "session") {
    const workspace = store.state.workspaces.find((entry) => entry.id === sessionRef.workspaceId);
    const session = workspace?.sessions.find((entry) => entry.id === sessionRef.sessionId);
    const parts = [
      `Session ${session?.title ?? sessionRef.sessionId}`,
      `ID ${sessionRef.sessionId}`,
      workspace ? `Workspace ${workspace.name}` : undefined,
      session ? `Status ${session.status}` : undefined,
    ].filter(Boolean);
    return finishComposerCommand(store, sessionRef, key, parts.join(" · "));
  }

  if (parsed.type === "name") {
    store.clearPendingAutoTitle(sessionRef);
    await store.driver.renameSession(sessionRef, parsed.title);
    return finishComposerCommand(store, sessionRef, key, `Session renamed to ${parsed.title}`);
  }

  if (parsed.type === "compact") {
    await store.driver.compactSession(sessionRef, parsed.customInstructions);
    await store.reloadTranscriptFromDriver(sessionRef);
    return finishComposerCommand(store, sessionRef, key, "Compacted session context");
  }

  if (parsed.type === "reload") {
    store.clearExtensionUiForSession(sessionRef);
    await store.driver.reloadSession(sessionRef);
    await store.refreshSessionCommandsFor(sessionRef);
    return finishComposerCommand(store, sessionRef, key, "Reloaded session resources");
  }

  return store.withError(`Unsupported slash command: ${commandText}`);
}

function appendLocalActivity(store: AppStoreInternals, sessionRef: SessionRef, label: string): void {
  const key = sessionKey(sessionRef);
  const transcript = [...(store.sessionState.transcriptCache.get(key) ?? [])];
  transcript.push(makeActivityItem(label));
  store.sessionState.transcriptCache.set(key, transcript);
  store.persistTranscriptCacheForSession(sessionRef);
}

function finishComposerCommand(
  store: AppStoreInternals,
  sessionRef: SessionRef,
  key: string,
  label: string,
): DesktopAppState {
  store.sessionState.composerDraftsBySession.delete(key);
  store.sessionState.composerAttachmentsBySession.delete(key);
  appendLocalActivity(store, sessionRef, label);
  const transcript = store.sessionState.transcriptCache.get(key) ?? [];
  const preview = previewFromTranscript(transcript);
  store.state = {
    ...store.state,
    workspaces: store.state.workspaces.map((workspace) =>
      workspace.id === sessionRef.workspaceId
        ? {
            ...workspace,
            sessions: workspace.sessions.map((session) =>
              session.id === sessionRef.sessionId
                ? {
                    ...session,
                    preview: preview ?? session.preview,
                    config: store.sessionState.sessionConfigBySession.get(key),
                  }
                : session,
            ),
          }
        : workspace,
    ),
    composerDraft: "",
    composerAttachments: [],
    lastError: undefined,
    revision: store.state.revision + 1,
  };
  store.schedulePersistUiState();
  const snapshot = store.emit();
  store.publishSelectedTranscriptFor(sessionRef);
  return snapshot;
}
