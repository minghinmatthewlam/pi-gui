import { randomUUID } from "node:crypto";
import { sessionKey } from "@pi-gui/pi-sdk-driver";
import type { SessionConfig, SessionQueuedMessage, SessionRef } from "@pi-gui/session-driver";
import type {
  ComposerAttachment,
  DesktopAppState,
  QueuedComposerMessage,
  WorkspaceSessionTarget,
} from "../src/desktop-state";
import { toSessionRef } from "./app-store-utils";
import {
  formatSessionConfigStatus,
  hasRuntimeSlashCommand,
  incompleteComposerCommandMessage,
  parseComposerCommand,
  resolveRuntimeSlashCommand,
} from "../src/composer-commands";
import {
  appendQueuedUserMessage,
  appendUserMessage,
  clearActiveAssistantMessage,
} from "./app-store-timeline";
import {
  cloneComposerAttachments,
  makeActivityItem,
  previewFromTranscript,
  toSessionAttachments,
  toSessionQueuedMessages,
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
    composerDraftSyncSource: "persist",
    composerDraftSyncNonce: store.allocateComposerDraftSyncNonce(),
    lastError: undefined,
    revision: store.state.revision + 1,
  };
  store.schedulePersistUiState();
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

export async function editQueuedComposerMessage(
  store: AppStoreInternals,
  messageId: string,
  currentDraft = "",
): Promise<DesktopAppState> {
  await store.initialize();
  const sessionRef = store.selectedSessionRef();
  if (!sessionRef) {
    return store.emit();
  }

  const key = sessionKey(sessionRef);
  const message = store
    .getQueuedComposerMessages(sessionRef)
    .find((entry) => entry.id === messageId);
  if (!message) {
    return store.emit();
  }

  store.setQueuedComposerEditState(sessionRef, {
    messageId,
    restoreDraft: currentDraft || store.sessionState.composerDraftsBySession.get(key) || "",
    restoreAttachments: cloneComposerAttachments(
      store.sessionState.composerAttachmentsBySession.get(key) ?? [],
    ),
  });
  store.sessionState.composerDraftsBySession.set(key, message.text);
  store.sessionState.composerAttachmentsBySession.set(
    key,
    cloneComposerAttachments(message.attachments),
  );
  await store.persistComposerAttachments(key, message.attachments);

  return store.refreshState({
    composerDraft: message.text,
    composerDraftSyncSource: "queued-message-edit",
    clearLastError: true,
    markSelectedSessionViewed: false,
  });
}

export async function cancelQueuedComposerEdit(store: AppStoreInternals): Promise<DesktopAppState> {
  await store.initialize();
  const sessionRef = store.selectedSessionRef();
  if (!sessionRef) {
    return store.emit();
  }

  const editState = store.getQueuedComposerEditState(sessionRef);
  if (!editState) {
    return store.emit();
  }

  const key = sessionKey(sessionRef);
  store.setQueuedComposerEditState(sessionRef, undefined);
  if (editState.restoreDraft) {
    store.sessionState.composerDraftsBySession.set(key, editState.restoreDraft);
  } else {
    store.sessionState.composerDraftsBySession.delete(key);
  }
  if (editState.restoreAttachments.length > 0) {
    store.sessionState.composerAttachmentsBySession.set(
      key,
      cloneComposerAttachments(editState.restoreAttachments),
    );
  } else {
    store.sessionState.composerAttachmentsBySession.delete(key);
  }
  await store.persistComposerAttachments(key, editState.restoreAttachments);

  return store.refreshState({
    composerDraft: editState.restoreDraft,
    composerDraftSyncSource: "queued-message-edit",
    clearLastError: true,
    markSelectedSessionViewed: false,
  });
}

export async function removeQueuedComposerMessage(
  store: AppStoreInternals,
  messageId: string,
): Promise<DesktopAppState> {
  await store.initialize();
  const sessionRef = store.selectedSessionRef();
  if (!sessionRef) {
    return store.emit();
  }

  const current = store.getQueuedComposerMessages(sessionRef);
  const next = current.filter((message) => message.id !== messageId);
  const editState = store.getQueuedComposerEditState(sessionRef);
  const key = sessionKey(sessionRef);

  if (editState?.messageId === messageId) {
    store.setQueuedComposerEditState(sessionRef, undefined);
    if (editState.restoreDraft) {
      store.sessionState.composerDraftsBySession.set(key, editState.restoreDraft);
    } else {
      store.sessionState.composerDraftsBySession.delete(key);
    }
    if (editState.restoreAttachments.length > 0) {
      store.sessionState.composerAttachmentsBySession.set(
        key,
        cloneComposerAttachments(editState.restoreAttachments),
      );
    } else {
      store.sessionState.composerAttachmentsBySession.delete(key);
    }
    await store.persistComposerAttachments(key, editState.restoreAttachments);
  }

  await store.driver.replaceQueuedMessages(sessionRef, toSessionQueuedMessages(next));
  return store.refreshState({
    ...(editState?.messageId === messageId
      ? {
          composerDraft: editState.restoreDraft,
          composerDraftSyncSource: "queued-message-edit" as const,
        }
      : {}),
    clearLastError: true,
    markSelectedSessionViewed: false,
  });
}

export async function steerQueuedComposerMessage(
  store: AppStoreInternals,
  messageId: string,
): Promise<DesktopAppState> {
  await store.initialize();
  const sessionRef = store.selectedSessionRef();
  if (!sessionRef) {
    return store.emit();
  }

  const current = store.getQueuedComposerMessages(sessionRef);
  const queuedMessage = current.find((message) => message.id === messageId);
  if (!queuedMessage) {
    return store.emit();
  }

  const steeredMessage = {
    ...queuedMessage,
    mode: "steer" as const,
    updatedAt: new Date().toISOString(),
  };
  const next = current.map((message) => (message.id === messageId ? steeredMessage : message));
  const nextSessionQueuedMessages = toSessionQueuedMessages(next);
  const optimisticSteerMessage = nextSessionQueuedMessages.find(
    (message) => message.id === messageId,
  );

  if (optimisticSteerMessage) {
    appendQueuedUserMessage(store.sessionState.transcriptCache, sessionRef, optimisticSteerMessage);
    store.publishSelectedTranscriptFor(sessionRef);
  }

  try {
    await store.driver.replaceQueuedMessages(sessionRef, nextSessionQueuedMessages);
    return store.refreshState({
      clearLastError: true,
      markSelectedSessionViewed: false,
    });
  } catch (error) {
    if (optimisticSteerMessage) {
      removeOptimisticQueuedUserMessage(store, sessionRef, optimisticSteerMessage.id);
    }
    return store.withSessionError(sessionRef, error);
  }
}

export async function submitComposer(
  store: AppStoreInternals,
  textInput: string,
  options: {
    readonly deliverAs?: "steer" | "followUp";
    readonly allowCommands?: boolean;
  } = {},
): Promise<DesktopAppState> {
  await store.initialize();
  const text = textInput.trim();
  const sessionRef = store.selectedSessionRef();
  const attachments = sessionRef
    ? (store.sessionState.composerAttachmentsBySession.get(sessionKey(sessionRef)) ?? [])
    : [];
  if (!text && attachments.length === 0) {
    return store.emit();
  }
  if (!sessionRef) {
    return store.withError("Create or select a session before sending a message.");
  }

  return submitComposerToSession(store, sessionRef, textInput, attachments, options);
}

export async function submitComposerToSession(
  store: AppStoreInternals,
  sessionRef: SessionRef,
  textInput: string,
  attachments: readonly ComposerAttachment[],
  options: {
    readonly deliverAs?: "steer" | "followUp";
    readonly allowCommands?: boolean;
  } = {},
): Promise<DesktopAppState> {
  const text = textInput.trim();
  const key = sessionKey(sessionRef);
  const runtime = store.runtimeByWorkspace.get(sessionRef.workspaceId);
  const sessionCommands =
    store.sessionState.sessionCommandsBySession.get(sessionKey(sessionRef)) ?? [];
  const allowCommands = options.allowCommands ?? true;
  const runtimeSlashCommand =
    allowCommands && hasRuntimeSlashCommand(text, runtime, sessionCommands);
  const resolvedRuntimeSlashCommand = runtimeSlashCommand
    ? resolveRuntimeSlashCommand(text, runtime, sessionCommands)
    : undefined;

  if (allowCommands && text.startsWith("/") && !runtimeSlashCommand) {
    const handled = await runComposerCommand(store, sessionRef, text);
    if (handled) {
      return handled;
    }
  }

  const selectedSession = store.sessionFromState(sessionRef);
  const isRunning = selectedSession?.status === "running";
  const editingState = store.getQueuedComposerEditState(sessionRef);
  let optimisticSteerMessage: SessionQueuedMessage | undefined;
  try {
    if (resolvedRuntimeSlashCommand) {
      const learnedCompatibility = store.getLearnedRuntimeCommandCompatibility(
        sessionRef.workspaceId,
        resolvedRuntimeSlashCommand,
      );
      if (learnedCompatibility?.status === "terminal-only") {
        store.sessionState.composerDraftsBySession.set(key, textInput);
        if (attachments.length > 0) {
          store.sessionState.composerAttachmentsBySession.set(
            key,
            cloneComposerAttachments(attachments),
          );
          await store.persistComposerAttachments(key, attachments);
        }
        store.state = {
          ...store.state,
          composerDraft: textInput,
          composerDraftSyncSource: "command",
          composerDraftSyncNonce: store.allocateComposerDraftSyncNonce(),
          composerAttachments: cloneComposerAttachments(attachments),
          revision: store.state.revision + 1,
        };
        return store.withError(learnedCompatibility.message);
      }

      store.beginRuntimeCommandExecution(sessionRef, resolvedRuntimeSlashCommand);
    }

    if (isRunning && !resolvedRuntimeSlashCommand) {
      const deliverAs = options.deliverAs ?? "followUp";
      const nextMessage = buildQueuedComposerMessage({
        existing: editingState
          ? store
              .getQueuedComposerMessages(sessionRef)
              .find((message) => message.id === editingState.messageId)
          : undefined,
        text,
        attachments,
        mode: deliverAs,
      });
      const nextQueuedMessages = editingState
        ? replaceQueuedComposerMessage(
            store.getQueuedComposerMessages(sessionRef),
            editingState.messageId,
            nextMessage,
          )
        : [...store.getQueuedComposerMessages(sessionRef), nextMessage];

      store.sessionState.composerDraftsBySession.delete(key);
      store.sessionState.composerAttachmentsBySession.delete(key);
      store.setQueuedComposerEditState(sessionRef, undefined);
      await store.persistComposerAttachments(key, []);
      const nextSessionQueuedMessages = toSessionQueuedMessages(nextQueuedMessages);
      optimisticSteerMessage =
        deliverAs === "steer"
          ? nextSessionQueuedMessages.find((message) => message.id === nextMessage.id)
          : undefined;
      if (optimisticSteerMessage) {
        appendQueuedUserMessage(
          store.sessionState.transcriptCache,
          sessionRef,
          optimisticSteerMessage,
        );
        store.publishSelectedTranscriptFor(sessionRef);
      }
      await store.driver.replaceQueuedMessages(sessionRef, nextSessionQueuedMessages);
      return store.refreshState({
        clearLastError: true,
        markSelectedSessionViewed: false,
      });
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
      store.sessionState.composerAttachmentsBySession.set(
        key,
        cloneComposerAttachments(attachments),
      );
      await store.persistComposerAttachments(key, attachments);
    }
    if (editingState) {
      store.setQueuedComposerEditState(sessionRef, editingState);
    }
    if (optimisticSteerMessage) {
      removeOptimisticQueuedUserMessage(store, sessionRef, optimisticSteerMessage.id);
    }
    return store.withSessionError(sessionRef, error);
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
  const optimisticMessageId = appendUserMessage(
    store.sessionState.transcriptCache,
    sessionRef,
    text,
    toTranscriptAttachments(attachments),
  );
  store.publishSelectedTranscriptFor(sessionRef);
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
      store.sessionState.transcriptCache.set(
        key,
        transcript.filter((message) => message.id !== optimisticMessageId),
      );
      store.publishSelectedTranscriptFor(sessionRef);
    }
    throw error;
  }
}

function buildQueuedComposerMessage(options: {
  readonly text: string;
  readonly attachments: readonly ComposerAttachment[];
  readonly mode: "steer" | "followUp";
  readonly existing?: QueuedComposerMessage;
}): QueuedComposerMessage {
  const timestamp = new Date().toISOString();
  return {
    id: options.existing?.id ?? randomUUID(),
    text: options.text,
    mode: options.mode,
    attachments: cloneComposerAttachments(options.attachments),
    createdAt: options.existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
}

function replaceQueuedComposerMessage(
  messages: readonly QueuedComposerMessage[],
  messageId: string,
  replacement: QueuedComposerMessage,
): QueuedComposerMessage[] {
  return messages.map((message) => (message.id === messageId ? replacement : message));
}

function removeOptimisticQueuedUserMessage(
  store: AppStoreInternals,
  sessionRef: SessionRef,
  messageId: string,
): void {
  const key = sessionKey(sessionRef);
  const transcript = store.sessionState.transcriptCache.get(key) ?? [];
  store.sessionState.transcriptCache.set(
    key,
    transcript.filter((message) => message.id !== messageId),
  );
  store.publishSelectedTranscriptFor(sessionRef);
}

/** Eagerly merge config fields so finishComposerCommand sees them before the async sessionUpdated event arrives. */
function syncSessionConfig(
  store: AppStoreInternals,
  key: string,
  patch: Partial<SessionConfig>,
): void {
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
    return finishComposerCommand(
      store,
      sessionRef,
      key,
      `Model set to ${parsed.provider}:${parsed.modelId}`,
    );
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
    return finishComposerCommand(store, sessionRef, key, `Session renamed to ${parsed.title}`, {
      sessionTitle: parsed.title,
    });
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

function appendLocalActivity(
  store: AppStoreInternals,
  sessionRef: SessionRef,
  label: string,
): void {
  const key = sessionKey(sessionRef);
  const transcript = [...(store.sessionState.transcriptCache.get(key) ?? [])];
  transcript.push(makeActivityItem(label));
  store.sessionState.transcriptCache.set(key, transcript);
}

function finishComposerCommand(
  store: AppStoreInternals,
  sessionRef: SessionRef,
  key: string,
  label: string,
  options: { readonly sessionTitle?: string } = {},
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
                    title: options.sessionTitle ?? session.title,
                    preview: preview ?? session.preview,
                    config: store.sessionState.sessionConfigBySession.get(key),
                  }
                : session,
            ),
          }
        : workspace,
    ),
    composerDraft: "",
    composerDraftSyncSource: "command",
    composerDraftSyncNonce: store.allocateComposerDraftSyncNonce(),
    composerAttachments: [],
    lastError: undefined,
    revision: store.state.revision + 1,
  };
  store.schedulePersistUiState();
  const snapshot = store.emit();
  store.publishSelectedTranscriptFor(sessionRef);
  return snapshot;
}
