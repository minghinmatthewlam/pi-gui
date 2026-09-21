import { randomUUID } from "node:crypto";
import { sessionKey } from "@pi-gui/session-driver";
import type { SessionConfig, SessionQueuedMessage, SessionRef } from "@pi-gui/session-driver";
import type { PiSdkDriver } from "@pi-gui/pi-sdk-driver";
import type { RuntimeCommandRecord, RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import type {
  ComposerAttachment,
  DesktopAppState,
  ExtensionCommandCompatibilityRecord,
  QueuedComposerMessage,
  WorkspaceSessionTarget,
} from "../../contracts/desktop-state";
import { toSessionRef } from "../application/app-store-utils";
import { assertComposerAttachmentsAccepted } from "../../contracts/composer-attachments";
import {
  formatSessionConfigStatus,
  hasRuntimeSlashCommand,
  incompleteComposerCommandMessage,
  parseComposerCommand,
  resolveRuntimeSlashCommand,
} from "../../contracts/composer-commands";
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
} from "../application/app-store-utils";
import type { RefreshStateOptions } from "../application/refresh-state-options";
import type { PendingRuntimeCommandExecution } from "./extension-command-compatibility";
import type { QueuedComposerEditState, SessionStateMap } from "./session-state-map";

type ConversationMutableState = Pick<
  SessionStateMap,
  | "activeAssistantMessageBySession"
  | "composerAttachmentsBySession"
  | "composerDraftsBySession"
  | "loadedTranscriptKeys"
  | "sessionCommandsBySession"
  | "sessionConfigBySession"
  | "sessionErrorsBySession"
  | "transcriptCache"
>;

type ConversationDriver = Pick<
  PiSdkDriver,
  | "cancelCurrentRun"
  | "compactSession"
  | "reloadSession"
  | "renameSession"
  | "replaceQueuedMessages"
  | "sendUserMessage"
  | "setSessionModel"
  | "setSessionThinkingLevel"
  | "unarchiveSession"
>;

interface ConversationOwnerHost {
  readonly driver: ConversationDriver;
  readonly conversationState: ConversationMutableState;
  runtimeForWorkspace(workspaceId: string): RuntimeSnapshot | undefined;
  initialize(): Promise<void>;
  refreshState(options?: RefreshStateOptions): Promise<DesktopAppState>;
  emit(): DesktopAppState;
  withError(error: unknown): Promise<DesktopAppState>;
  withSessionError(sessionRef: SessionRef, error: unknown): Promise<DesktopAppState>;
  withErrorHandling(fn: () => Promise<DesktopAppState>): Promise<DesktopAppState>;
  sessionFromState(
    sessionRef: SessionRef,
  ):
    | { archivedAt?: string; updatedAt: string; title: string; status: string; preview?: string }
    | undefined;
  describeSession(
    sessionRef: SessionRef,
  ):
    { readonly workspaceName: string; readonly title: string; readonly status: string } | undefined;
  isSelectedSession(sessionRef: SessionRef): boolean;
  clearConversationError(): void;
  publishComposerAttachments(
    sessionRef: SessionRef,
    attachments: readonly ComposerAttachment[],
  ): void;
  finishLocalComposerCommand(
    sessionRef: SessionRef,
    update: {
      readonly title?: string;
      readonly preview?: string;
      readonly config?: SessionConfig;
    },
  ): void;
  setComposerDraftForSession(
    sessionRef: SessionRef,
    draft: string,
    source: "persist" | "command" | "extension-editor-text" | "queued-message-edit",
  ): void;
  ensureSessionReady(sessionRef: SessionRef): Promise<unknown>;
  refreshSessionCommandsFor(sessionRef: SessionRef): Promise<void>;
  getLearnedRuntimeCommandCompatibility(
    workspaceId: string,
    command: RuntimeCommandRecord,
  ): ExtensionCommandCompatibilityRecord | undefined;
  beginRuntimeCommandExecution(sessionRef: SessionRef, command: RuntimeCommandRecord): void;
  finishRuntimeCommandExecution(
    sessionRef: SessionRef,
    timestamp?: string,
  ): PendingRuntimeCommandExecution | undefined;
  clearExtensionUiForSession(sessionRef: SessionRef): void;
  persistComposerAttachments(
    key: string,
    attachments: readonly ComposerAttachment[],
  ): Promise<void>;
  schedulePersistUiState(): void;
  touchSessionInteraction(sessionRef: SessionRef): boolean;
  getQueuedComposerMessages(sessionRef: SessionRef): readonly QueuedComposerMessage[];
  setQueuedComposerEditState(
    sessionRef: SessionRef,
    editState: QueuedComposerEditState | undefined,
  ): void;
  getQueuedComposerEditState(sessionRef: SessionRef): QueuedComposerEditState | undefined;
  reloadTranscriptFromDriver(sessionRef: SessionRef): Promise<void>;
  publishSelectedTranscriptFor(sessionRef: SessionRef): void;
  clearPendingAutoTitle(sessionRef: SessionRef): void;
}

type ComposerStore = ConversationOwnerHost;

export interface ConversationOwner {
  updateComposerDraft(
    sessionRef: SessionRef | undefined,
    composerDraft: string,
  ): Promise<DesktopAppState>;
  addComposerAttachments(
    sessionRef: SessionRef | undefined,
    attachments: readonly ComposerAttachment[],
  ): Promise<DesktopAppState>;
  removeComposerAttachment(
    sessionRef: SessionRef | undefined,
    attachmentId: string,
  ): Promise<DesktopAppState>;
  editQueuedComposerMessage(
    sessionRef: SessionRef | undefined,
    messageId: string,
    currentDraft?: string,
  ): Promise<DesktopAppState>;
  cancelQueuedComposerEdit(sessionRef: SessionRef | undefined): Promise<DesktopAppState>;
  removeQueuedComposerMessage(
    sessionRef: SessionRef | undefined,
    messageId: string,
  ): Promise<DesktopAppState>;
  steerQueuedComposerMessage(
    sessionRef: SessionRef | undefined,
    messageId: string,
  ): Promise<DesktopAppState>;
  submitComposer(
    sessionRef: SessionRef | undefined,
    textInput: string,
    options?: { readonly deliverAs?: "steer" | "followUp" },
  ): Promise<DesktopAppState>;
  submitComposerToSession(
    sessionRef: SessionRef,
    textInput: string,
    attachments: readonly ComposerAttachment[],
    options?: { readonly deliverAs?: "steer" | "followUp"; readonly allowCommands?: boolean },
  ): Promise<DesktopAppState>;
  setSessionModel(
    target: WorkspaceSessionTarget,
    provider: string,
    modelId: string,
  ): Promise<DesktopAppState>;
  setSessionThinkingLevel(sessionRef: SessionRef, thinkingLevel: string): Promise<DesktopAppState>;
  cancelCurrentRun(sessionRef: SessionRef | undefined): Promise<DesktopAppState>;
  sendMessageToSession(
    sessionRef: SessionRef,
    text: string,
    attachments: readonly ComposerAttachment[],
    options?: { readonly rollbackOptimisticMessageOnError?: boolean },
  ): Promise<void>;
}

export function createConversationOwner(store: ConversationOwnerHost): ConversationOwner {
  return {
    updateComposerDraft: (sessionRef, draft) => updateComposerDraft(store, sessionRef, draft),
    addComposerAttachments: (sessionRef, attachments) =>
      addComposerAttachments(store, sessionRef, attachments),
    removeComposerAttachment: (sessionRef, attachmentId) =>
      removeComposerAttachment(store, sessionRef, attachmentId),
    editQueuedComposerMessage: (sessionRef, messageId, currentDraft) =>
      editQueuedComposerMessage(store, sessionRef, messageId, currentDraft),
    cancelQueuedComposerEdit: (sessionRef) => cancelQueuedComposerEdit(store, sessionRef),
    removeQueuedComposerMessage: (sessionRef, messageId) =>
      removeQueuedComposerMessage(store, sessionRef, messageId),
    steerQueuedComposerMessage: (sessionRef, messageId) =>
      steerQueuedComposerMessage(store, sessionRef, messageId),
    submitComposer: (sessionRef, text, options) => submitComposer(store, sessionRef, text, options),
    submitComposerToSession: (sessionRef, text, attachments, options) =>
      submitComposerToSession(store, sessionRef, text, attachments, options),
    setSessionModel: (target, provider, modelId) =>
      setSessionModel(store, target, provider, modelId),
    setSessionThinkingLevel: (sessionRef, thinkingLevel) =>
      setSessionThinkingLevel(store, sessionRef, thinkingLevel),
    cancelCurrentRun: (sessionRef) => cancelCurrentRun(store, sessionRef),
    sendMessageToSession: (sessionRef, text, attachments, options) =>
      sendMessageToSession(store, sessionRef, text, attachments, options),
  };
}

/* ── Public methods ─────────────────────────────────────── */

async function updateComposerDraft(
  store: ComposerStore,
  sessionRef: SessionRef | undefined,
  composerDraft: string,
): Promise<DesktopAppState> {
  await store.initialize();
  if (!sessionRef || !store.sessionFromState(sessionRef)) {
    return store.emit();
  }
  store.setComposerDraftForSession(sessionRef, composerDraft, "persist");
  store.clearConversationError();
  store.schedulePersistUiState();
  return store.emit();
}

async function addComposerAttachments(
  store: ComposerStore,
  sessionRef: SessionRef | undefined,
  attachments: readonly ComposerAttachment[],
): Promise<DesktopAppState> {
  await store.initialize();
  if (!sessionRef || !store.sessionFromState(sessionRef) || attachments.length === 0) {
    return store.emit();
  }

  const key = sessionKey(sessionRef);
  const existing = store.conversationState.composerAttachmentsBySession.get(key) ?? [];
  const accepted = assertComposerAttachmentsAccepted(existing, attachments);
  const next = [...existing, ...accepted];
  store.conversationState.composerAttachmentsBySession.set(key, next);
  store.clearConversationError();
  store.publishComposerAttachments(sessionRef, next);
  await store.persistComposerAttachments(key, next);
  return store.emit();
}

async function removeComposerAttachment(
  store: ComposerStore,
  sessionRef: SessionRef | undefined,
  attachmentId: string,
): Promise<DesktopAppState> {
  await store.initialize();
  if (!sessionRef || !store.sessionFromState(sessionRef)) {
    return store.emit();
  }

  const key = sessionKey(sessionRef);
  const existing = store.conversationState.composerAttachmentsBySession.get(key) ?? [];
  const next = existing.filter((attachment) => attachment.id !== attachmentId);
  if (next.length > 0) {
    store.conversationState.composerAttachmentsBySession.set(key, next);
  } else {
    store.conversationState.composerAttachmentsBySession.delete(key);
  }
  store.publishComposerAttachments(sessionRef, next);
  await store.persistComposerAttachments(key, next);
  return store.emit();
}

async function editQueuedComposerMessage(
  store: ComposerStore,
  sessionRef: SessionRef | undefined,
  messageId: string,
  currentDraft = "",
): Promise<DesktopAppState> {
  await store.initialize();
  if (!sessionRef || !store.sessionFromState(sessionRef)) {
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
    restoreDraft: currentDraft || store.conversationState.composerDraftsBySession.get(key) || "",
    restoreAttachments: cloneComposerAttachments(
      store.conversationState.composerAttachmentsBySession.get(key) ?? [],
    ),
  });
  store.setComposerDraftForSession(sessionRef, message.text, "queued-message-edit");
  store.conversationState.composerAttachmentsBySession.set(
    key,
    cloneComposerAttachments(message.attachments),
  );
  await store.persistComposerAttachments(key, message.attachments);

  return store.refreshState({
    clearLastError: true,
    markSelectedSessionViewed: false,
  });
}

async function cancelQueuedComposerEdit(
  store: ComposerStore,
  sessionRef: SessionRef | undefined,
): Promise<DesktopAppState> {
  await store.initialize();
  if (!sessionRef || !store.sessionFromState(sessionRef)) {
    return store.emit();
  }

  const editState = store.getQueuedComposerEditState(sessionRef);
  if (!editState) {
    return store.emit();
  }

  const key = sessionKey(sessionRef);
  store.setQueuedComposerEditState(sessionRef, undefined);
  store.setComposerDraftForSession(sessionRef, editState.restoreDraft, "queued-message-edit");
  if (editState.restoreAttachments.length > 0) {
    store.conversationState.composerAttachmentsBySession.set(
      key,
      cloneComposerAttachments(editState.restoreAttachments),
    );
  } else {
    store.conversationState.composerAttachmentsBySession.delete(key);
  }
  await store.persistComposerAttachments(key, editState.restoreAttachments);

  return store.refreshState({
    clearLastError: true,
    markSelectedSessionViewed: false,
  });
}

async function removeQueuedComposerMessage(
  store: ComposerStore,
  sessionRef: SessionRef | undefined,
  messageId: string,
): Promise<DesktopAppState> {
  await store.initialize();
  if (!sessionRef || !store.sessionFromState(sessionRef)) {
    return store.emit();
  }

  const current = store.getQueuedComposerMessages(sessionRef);
  const next = current.filter((message) => message.id !== messageId);
  const editState = store.getQueuedComposerEditState(sessionRef);
  const key = sessionKey(sessionRef);

  if (editState?.messageId === messageId) {
    store.setQueuedComposerEditState(sessionRef, undefined);
    store.setComposerDraftForSession(sessionRef, editState.restoreDraft, "queued-message-edit");
    if (editState.restoreAttachments.length > 0) {
      store.conversationState.composerAttachmentsBySession.set(
        key,
        cloneComposerAttachments(editState.restoreAttachments),
      );
    } else {
      store.conversationState.composerAttachmentsBySession.delete(key);
    }
    await store.persistComposerAttachments(key, editState.restoreAttachments);
  }

  await store.driver.replaceQueuedMessages(sessionRef, toSessionQueuedMessages(next));
  return store.refreshState({
    clearLastError: true,
    markSelectedSessionViewed: false,
  });
}

async function steerQueuedComposerMessage(
  store: ComposerStore,
  sessionRef: SessionRef | undefined,
  messageId: string,
): Promise<DesktopAppState> {
  await store.initialize();
  if (!sessionRef || !store.sessionFromState(sessionRef)) {
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
    appendQueuedUserMessage(
      store.conversationState.transcriptCache,
      sessionRef,
      optimisticSteerMessage,
    );
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

async function submitComposer(
  store: ComposerStore,
  sessionRef: SessionRef | undefined,
  textInput: string,
  options: {
    readonly deliverAs?: "steer" | "followUp";
    readonly allowCommands?: boolean;
  } = {},
): Promise<DesktopAppState> {
  await store.initialize();
  const text = textInput.trim();
  const attachments = sessionRef
    ? (store.conversationState.composerAttachmentsBySession.get(sessionKey(sessionRef)) ?? [])
    : [];
  if (!text && attachments.length === 0) {
    return store.emit();
  }
  if (!sessionRef || !store.sessionFromState(sessionRef)) {
    return store.withError("Create or select a session before sending a message.");
  }

  return submitComposerToSession(store, sessionRef, textInput, attachments, options);
}

async function submitComposerToSession(
  store: ComposerStore,
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
  const runtime = store.runtimeForWorkspace(sessionRef.workspaceId);
  const sessionCommands =
    store.conversationState.sessionCommandsBySession.get(sessionKey(sessionRef)) ?? [];
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
        if (attachments.length > 0) {
          store.conversationState.composerAttachmentsBySession.set(
            key,
            cloneComposerAttachments(attachments),
          );
          await store.persistComposerAttachments(key, attachments);
        }
        store.setComposerDraftForSession(sessionRef, textInput, "command");
        store.publishComposerAttachments(sessionRef, attachments);
        return store.withSessionError(sessionRef, learnedCompatibility.message);
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

      store.conversationState.composerDraftsBySession.delete(key);
      store.conversationState.composerAttachmentsBySession.delete(key);
      store.setQueuedComposerEditState(sessionRef, undefined);
      await store.persistComposerAttachments(key, []);
      const nextSessionQueuedMessages = toSessionQueuedMessages(nextQueuedMessages);
      optimisticSteerMessage =
        deliverAs === "steer"
          ? nextSessionQueuedMessages.find((message) => message.id === nextMessage.id)
          : undefined;
      if (optimisticSteerMessage) {
        appendQueuedUserMessage(
          store.conversationState.transcriptCache,
          sessionRef,
          optimisticSteerMessage,
        );
        store.publishSelectedTranscriptFor(sessionRef);
      }
      store.touchSessionInteraction(sessionRef);
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
      store.conversationState.composerDraftsBySession.set(key, textInput);
    }
    if (attachments.length > 0) {
      store.conversationState.composerAttachmentsBySession.set(
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

async function setSessionModel(
  store: ComposerStore,
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

async function setSessionThinkingLevel(
  store: ComposerStore,
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

async function cancelCurrentRun(
  store: ComposerStore,
  sessionRef: SessionRef | undefined,
): Promise<DesktopAppState> {
  await store.initialize();
  if (!sessionRef) {
    return store.emit();
  }

  try {
    await store.driver.cancelCurrentRun(sessionRef);
    clearActiveAssistantMessage(
      store.conversationState.activeAssistantMessageBySession,
      sessionRef,
    );
    store.conversationState.sessionErrorsBySession.delete(sessionKey(sessionRef));
    store.clearConversationError();
    store.schedulePersistUiState();
    return store.emit();
  } catch (error) {
    return store.withSessionError(sessionRef, error);
  }
}

/* ── Internal helpers ───────────────────────────────────── */

async function sendMessageToSession(
  store: ComposerStore,
  sessionRef: SessionRef,
  text: string,
  attachments: readonly ComposerAttachment[],
  options: {
    readonly rollbackOptimisticMessageOnError?: boolean;
  } = {},
): Promise<void> {
  const key = sessionKey(sessionRef);
  const rollbackOptimisticMessageOnError = options.rollbackOptimisticMessageOnError ?? true;
  if (!store.conversationState.loadedTranscriptKeys.has(key)) {
    await store.ensureSessionReady(sessionRef);
  }
  if (store.sessionFromState(sessionRef)?.archivedAt) {
    await store.driver.unarchiveSession(sessionRef);
  }
  store.touchSessionInteraction(sessionRef);
  const optimisticMessageId = appendUserMessage(
    store.conversationState.transcriptCache,
    sessionRef,
    text,
    toTranscriptAttachments(attachments),
  );
  store.publishSelectedTranscriptFor(sessionRef);
  clearActiveAssistantMessage(store.conversationState.activeAssistantMessageBySession, sessionRef);
  store.conversationState.sessionErrorsBySession.delete(key);
  store.conversationState.composerDraftsBySession.delete(key);
  store.conversationState.composerAttachmentsBySession.delete(key);
  await store.persistComposerAttachments(key, []);
  try {
    await store.driver.sendUserMessage(sessionRef, {
      text,
      attachments: toSessionAttachments(attachments),
    });
  } catch (error) {
    if (rollbackOptimisticMessageOnError) {
      const transcript = store.conversationState.transcriptCache.get(key) ?? [];
      store.conversationState.transcriptCache.set(
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
  store: ComposerStore,
  sessionRef: SessionRef,
  messageId: string,
): void {
  const key = sessionKey(sessionRef);
  const transcript = store.conversationState.transcriptCache.get(key) ?? [];
  store.conversationState.transcriptCache.set(
    key,
    transcript.filter((message) => message.id !== messageId),
  );
  store.publishSelectedTranscriptFor(sessionRef);
}

/** Eagerly merge config fields so finishComposerCommand sees them before the async sessionUpdated event arrives. */
function syncSessionConfig(store: ComposerStore, key: string, patch: Partial<SessionConfig>): void {
  const current = store.conversationState.sessionConfigBySession.get(key) ?? {};
  store.conversationState.sessionConfigBySession.set(key, { ...current, ...patch });
}

async function runComposerCommand(
  store: ComposerStore,
  sessionRef: SessionRef,
  commandText: string,
): Promise<DesktopAppState | undefined> {
  const parsed = parseComposerCommand(commandText);
  if (!parsed) {
    const message = incompleteComposerCommandMessage(commandText);
    if (message) {
      return store.withSessionError(sessionRef, message);
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
      formatSessionConfigStatus(store.conversationState.sessionConfigBySession.get(key)),
    );
  }

  if (parsed.type === "session") {
    const session = store.describeSession(sessionRef);
    const parts = [
      `Session ${session?.title ?? sessionRef.sessionId}`,
      `ID ${sessionRef.sessionId}`,
      session ? `Workspace ${session.workspaceName}` : undefined,
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

  return store.withSessionError(sessionRef, `Unsupported slash command: ${commandText}`);
}

function appendLocalActivity(store: ComposerStore, sessionRef: SessionRef, label: string): void {
  const key = sessionKey(sessionRef);
  const transcript = [...(store.conversationState.transcriptCache.get(key) ?? [])];
  transcript.push(makeActivityItem(label));
  store.conversationState.transcriptCache.set(key, transcript);
}

function finishComposerCommand(
  store: ComposerStore,
  sessionRef: SessionRef,
  key: string,
  label: string,
  options: { readonly sessionTitle?: string } = {},
): DesktopAppState {
  store.conversationState.composerAttachmentsBySession.delete(key);
  appendLocalActivity(store, sessionRef, label);
  const transcript = store.conversationState.transcriptCache.get(key) ?? [];
  const preview = previewFromTranscript(transcript);
  store.setComposerDraftForSession(sessionRef, "", "command");
  store.finishLocalComposerCommand(sessionRef, {
    ...(options.sessionTitle ? { title: options.sessionTitle } : {}),
    ...(preview ? { preview } : {}),
    config: store.conversationState.sessionConfigBySession.get(key),
  });
  store.schedulePersistUiState();
  const snapshot = store.emit();
  store.publishSelectedTranscriptFor(sessionRef);
  return snapshot;
}
