import type { SessionConfig } from "@pi-gui/session-driver";
import { createEmptyExtensionUiState as createBaseExtensionUiState, type ExtensionUiState } from "@pi-gui/pi-sdk-driver";
import type { RuntimeCommandRecord } from "@pi-gui/session-driver/runtime-types";
import type {
  ComposerAttachment,
  QueuedComposerMessage,
  SessionExtensionDialogRecord,
  SessionExtensionUiStateRecord,
  TranscriptMessage,
} from "../src/desktop-state";
import type { RunMetrics } from "./app-store-timeline";

export interface MutableSessionExtensionUiState extends ExtensionUiState {
  pendingDialogs: SessionExtensionDialogRecord[];
}

export interface PendingAutoTitle {
  readonly requestToken: string;
  readonly cancel: () => void;
}

export interface QueuedComposerEditState {
  readonly messageId: string;
  readonly restoreDraft: string;
  readonly restoreAttachments: readonly ComposerAttachment[];
}

/**
 * Consolidates all per-session Maps (and one Set) that DesktopAppStore
 * maintains for runtime session state.  Having them in a single class
 * makes pruning and deletion consistent — every map is cleaned in one
 * place instead of manually repeating the list across call sites.
 */
export class SessionStateMap {
  readonly transcriptCache = new Map<string, TranscriptMessage[]>();
  readonly composerDraftsBySession = new Map<string, string>();
  readonly composerAttachmentsBySession = new Map<string, ComposerAttachment[]>();
  readonly queuedComposerMessagesBySession = new Map<string, QueuedComposerMessage[]>();
  readonly queuedComposerEditsBySession = new Map<string, QueuedComposerEditState>();
  readonly sessionConfigBySession = new Map<string, SessionConfig>();
  readonly lastViewedAtBySession = new Map<string, string>();
  readonly sessionErrorsBySession = new Map<string, string>();
  readonly sessionSubscriptions = new Map<string, () => void>();
  readonly activeAssistantMessageBySession = new Map<string, string>();
  readonly runningSinceBySession = new Map<string, string>();
  readonly runMetricsBySession = new Map<string, RunMetrics>();
  readonly activeWorkingActivityBySession = new Map<string, string>();
  readonly sessionCommandsBySession = new Map<string, RuntimeCommandRecord[]>();
  readonly extensionUiBySession = new Map<string, MutableSessionExtensionUiState>();
  readonly pendingAutoTitleBySession = new Map<string, PendingAutoTitle>();
  readonly reasoningStreamingMessageIdBySession = new Map<string, string | null>();
  readonly loadedTranscriptKeys = new Set<string>();

  /**
   * Remove entries for session keys that are no longer active.
   * Calls the unsubscribe callback for any stale subscription before deleting it.
   */
  prune(activeKeys: Set<string>): void {
    for (const [key, unsubscribe] of this.sessionSubscriptions) {
      if (!activeKeys.has(key)) {
        unsubscribe();
        this.deleteSession(key);
      }
    }
  }

  /** Remove all state for a single session key. */
  deleteSession(key: string): void {
    const pendingAutoTitle = this.pendingAutoTitleBySession.get(key);
    this.sessionSubscriptions.delete(key);
    this.activeAssistantMessageBySession.delete(key);
    this.runningSinceBySession.delete(key);
    this.runMetricsBySession.delete(key);
    this.activeWorkingActivityBySession.delete(key);
    this.composerDraftsBySession.delete(key);
    this.composerAttachmentsBySession.delete(key);
    this.queuedComposerMessagesBySession.delete(key);
    this.queuedComposerEditsBySession.delete(key);
    this.sessionConfigBySession.delete(key);
    this.lastViewedAtBySession.delete(key);
    this.sessionErrorsBySession.delete(key);
    this.sessionCommandsBySession.delete(key);
    this.extensionUiBySession.delete(key);
    this.pendingAutoTitleBySession.delete(key);
    this.reasoningStreamingMessageIdBySession.delete(key);
    pendingAutoTitle?.cancel();
    this.loadedTranscriptKeys.delete(key);
    this.transcriptCache.delete(key);
  }
}

export function createEmptyExtensionUiState(): MutableSessionExtensionUiState {
  return {
    ...createBaseExtensionUiState(),
    pendingDialogs: [],
  };
}

export function serializeExtensionUiState(state: MutableSessionExtensionUiState): SessionExtensionUiStateRecord {
  return {
    statuses: [...state.statuses.entries()].map(([key, text]) => ({ key, text })),
    widgets: [...state.widgets.values()],
    pendingDialogs: [...state.pendingDialogs],
    ...(state.title ? { title: state.title } : {}),
    ...(state.editorText ? { editorText: state.editorText } : {}),
  };
}
