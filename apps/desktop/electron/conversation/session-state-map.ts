import { randomUUID } from "node:crypto";
import type { SessionConfig } from "@pi-gui/session-driver";
import {
  createEmptyExtensionUiState as createBaseExtensionUiState,
  type ExtensionUiState,
} from "@pi-gui/pi-sdk-driver";
import type { RuntimeCommandRecord } from "@pi-gui/session-driver/runtime-types";
import type {
  ComposerAttachment,
  QueuedComposerMessage,
  SessionExtensionDialogRecord,
  SessionExtensionUiStateRecord,
  TranscriptMessage,
} from "../../contracts/desktop-state";
import type { RunMetrics } from "./app-store-timeline";

export interface MutableSessionExtensionUiState extends ExtensionUiState {
  readonly instanceId: string;
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
  readonly transcriptCache = new Map<string, readonly TranscriptMessage[]>();
  readonly composerDraftsBySession = new Map<string, string>();
  readonly composerAttachmentsBySession = new Map<string, ComposerAttachment[]>();
  readonly queuedComposerMessagesBySession = new Map<string, QueuedComposerMessage[]>();
  readonly queuedComposerEditsBySession = new Map<string, QueuedComposerEditState>();
  readonly sessionConfigBySession = new Map<string, SessionConfig>();
  readonly lastViewedAtBySession = new Map<string, string>();
  readonly lastInteractedAtBySession = new Map<string, string>();
  readonly pinnedAtBySession = new Map<string, string>();
  pinnedSessionOrder: string[] = [];
  readonly sessionErrorsBySession = new Map<string, string>();
  readonly sessionSubscriptions = new Map<string, () => void>();
  readonly activeAssistantMessageBySession = new Map<string, string>();
  readonly pendingAssistantMessageBySession = new Map<string, string>();
  readonly runningSinceBySession = new Map<string, string>();
  readonly runMetricsBySession = new Map<string, RunMetrics>();
  readonly activeWorkingActivityBySession = new Map<string, string>();
  readonly sessionCommandsBySession = new Map<string, RuntimeCommandRecord[]>();
  readonly extensionUiBySession = new Map<string, MutableSessionExtensionUiState>();
  readonly pendingAutoTitleBySession = new Map<string, PendingAutoTitle>();
  readonly loadedTranscriptKeys = new Set<string>();

  /**
   * Remove all per-session state for keys that are no longer active. Pruning is
   * authoritative against `activeKeys`: it sweeps every map/set, not just the
   * ones with a live subscription. A session closed before its workspace is
   * removed drops its subscription first, so keying off subscriptions alone
   * leaked its transcript cache (and other caches) forever.
   * Calls the unsubscribe callback for any stale subscription before deleting it.
   */
  prune(activeKeys: Set<string>): boolean {
    const persistedUiChanged = this.prunePersistedUiState(activeKeys);
    for (const key of this.allSessionKeys()) {
      if (!activeKeys.has(key)) {
        this.sessionSubscriptions.get(key)?.();
        this.deleteSession(key);
      }
    }
    return persistedUiChanged;
  }

  /** Union of keys across every per-session map and set. */
  private allSessionKeys(): Set<string> {
    const keys = new Set<string>();
    const maps: ReadonlyArray<ReadonlyMap<string, unknown>> = [
      this.transcriptCache,
      this.composerDraftsBySession,
      this.composerAttachmentsBySession,
      this.queuedComposerMessagesBySession,
      this.queuedComposerEditsBySession,
      this.sessionConfigBySession,
      this.lastViewedAtBySession,
      this.lastInteractedAtBySession,
      this.pinnedAtBySession,
      this.sessionErrorsBySession,
      this.sessionSubscriptions,
      this.activeAssistantMessageBySession,
      this.pendingAssistantMessageBySession,
      this.runningSinceBySession,
      this.runMetricsBySession,
      this.activeWorkingActivityBySession,
      this.sessionCommandsBySession,
      this.extensionUiBySession,
      this.pendingAutoTitleBySession,
    ];
    for (const map of maps) {
      for (const key of map.keys()) {
        keys.add(key);
      }
    }
    for (const key of this.loadedTranscriptKeys) {
      keys.add(key);
    }
    for (const key of this.pinnedSessionOrder) {
      keys.add(key);
    }
    return keys;
  }

  /** Remove persisted UI entries for sessions that are no longer in the catalog. */
  prunePersistedUiState(activeKeys: Set<string>): boolean {
    let changed = false;
    for (const map of [
      this.composerDraftsBySession,
      this.lastViewedAtBySession,
      this.lastInteractedAtBySession,
      this.pinnedAtBySession,
    ]) {
      for (const key of map.keys()) {
        if (!activeKeys.has(key)) {
          map.delete(key);
          changed = true;
        }
      }
    }
    const nextPinnedOrder = this.pinnedSessionOrder.filter((key) => activeKeys.has(key));
    if (nextPinnedOrder.length !== this.pinnedSessionOrder.length) {
      this.pinnedSessionOrder = nextPinnedOrder;
      changed = true;
    }
    return changed;
  }

  /** Remove all state for a single session key. */
  deleteSession(key: string): void {
    const pendingAutoTitle = this.pendingAutoTitleBySession.get(key);
    this.sessionSubscriptions.delete(key);
    this.activeAssistantMessageBySession.delete(key);
    this.pendingAssistantMessageBySession.delete(key);
    this.runningSinceBySession.delete(key);
    this.runMetricsBySession.delete(key);
    this.activeWorkingActivityBySession.delete(key);
    this.composerDraftsBySession.delete(key);
    this.composerAttachmentsBySession.delete(key);
    this.queuedComposerMessagesBySession.delete(key);
    this.queuedComposerEditsBySession.delete(key);
    this.sessionConfigBySession.delete(key);
    this.lastViewedAtBySession.delete(key);
    this.lastInteractedAtBySession.delete(key);
    this.pinnedAtBySession.delete(key);
    this.pinnedSessionOrder = this.pinnedSessionOrder.filter((entry) => entry !== key);
    this.sessionErrorsBySession.delete(key);
    this.sessionCommandsBySession.delete(key);
    this.extensionUiBySession.delete(key);
    this.pendingAutoTitleBySession.delete(key);
    pendingAutoTitle?.cancel();
    this.loadedTranscriptKeys.delete(key);
    this.transcriptCache.delete(key);
  }
}

export function createEmptyExtensionUiState(): MutableSessionExtensionUiState {
  return {
    ...createBaseExtensionUiState(),
    instanceId: randomUUID(),
    pendingDialogs: [],
  };
}

export function serializeExtensionUiState(
  state: MutableSessionExtensionUiState,
): SessionExtensionUiStateRecord {
  return {
    instanceId: state.instanceId,
    statuses: [...state.statuses.entries()].map(([key, text]) => ({ key, text })),
    widgets: [...state.widgets.values()],
    pendingDialogs: [...state.pendingDialogs],
    ...(state.title ? { title: state.title } : {}),
    ...(state.editorText ? { editorText: state.editorText } : {}),
  };
}
