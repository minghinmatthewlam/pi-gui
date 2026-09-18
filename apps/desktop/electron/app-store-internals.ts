import type { PiSdkDriver, JsonCatalogStore } from "@pi-gui/pi-sdk-driver";
import type {
  CreateSessionOptions,
  SessionConfig,
  SessionDriverEvent,
  SessionRef,
  SessionSnapshot,
  WorkspaceRef,
} from "@pi-gui/session-driver";
import type { RuntimeCommandRecord, RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import type {
  AppView,
  ComposerAttachment,
  ComposerDraftSyncSource,
  DesktopAppState,
  ExtensionCommandCompatibilityRecord,
  QueuedComposerMessage,
  TranscriptMessage,
  WorkspaceSessionTarget,
} from "../src/desktop-state";
import type {
  PendingAutoTitle,
  QueuedComposerEditState,
  SessionStateMap,
} from "./session-state-map";
import type { GitWorktreeManager } from "./worktree-manager";
import type { JsonFileStore } from "./json-file-store";
import type { PendingRuntimeCommandExecution } from "./extension-command-compatibility";

/**
 * Internal interface shared by method-group files
 * (`app-store-workspace.ts`, `app-store-worktree.ts`, `app-store-composer.ts`)
 * so they can call back into the store without needing access to private members.
 */
export interface AppStoreInternals {
  /* ── State ─────────────────────────────────────────────── */
  state: DesktopAppState;
  readonly sessionState: SessionStateMap;
  readonly runtimeByWorkspace: Map<string, RuntimeSnapshot>;
  readonly extensionCommandCompatibilityByWorkspace: Map<
    string,
    Map<string, ExtensionCommandCompatibilityRecord>
  >;
  readonly pendingRuntimeCommandsBySession: Map<string, PendingRuntimeCommandExecution>;

  /* ── Infrastructure ────────────────────────────────────── */
  readonly driver: PiSdkDriver;
  readonly catalogStore: JsonCatalogStore;
  readonly worktreeManager: GitWorktreeManager;
  readonly worktreeRoot: string;
  readonly attachmentStore: JsonFileStore<ComposerAttachment[]>;

  /* ── Shared helpers (called by extracted method groups) ── */
  initialize(): Promise<void>;
  refreshState(options?: RefreshStateOptions): Promise<DesktopAppState>;
  allocateComposerDraftSyncNonce(baseNonce?: number): number;
  emit(): DesktopAppState;
  withError(error: unknown): Promise<DesktopAppState>;
  withSessionError(sessionRef: SessionRef, error: unknown): Promise<DesktopAppState>;
  withErrorHandling(fn: () => Promise<DesktopAppState>): Promise<DesktopAppState>;
  selectSessionFast(target: WorkspaceSessionTarget): Promise<DesktopAppState>;
  workspaceRefFromState(workspaceId: string): WorkspaceRef | undefined;
  selectedSessionRef(): SessionRef | undefined;
  getExtensionFilePath(workspaceId: string, filePath: string): string | undefined;
  sessionFromState(
    sessionRef: SessionRef,
  ):
    | { archivedAt?: string; updatedAt: string; title: string; status: string; preview?: string }
    | undefined;
  ensureSessionReady(sessionRef: SessionRef): Promise<SessionSnapshot | undefined>;
  ensureSessionSubscription(sessionRef: SessionRef): Promise<void>;
  ensureSessionSubscribed(sessionRef: SessionRef): Promise<void>;
  subscribeToSessionEvents(
    listener: (event: SessionDriverEvent, state: DesktopAppState) => void | Promise<void>,
  ): () => void;
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
  cancelPendingDialogsForSession(sessionRef: SessionRef): Promise<void>;
  persistUiState(): Promise<void>;
  persistComposerAttachments(
    key: string,
    attachments: readonly ComposerAttachment[],
  ): Promise<void>;
  schedulePersistUiState(): void;
  updateSessionConfig(sessionRef: SessionRef, config: SessionConfig | undefined): void;
  setPendingAutoTitle(sessionRef: SessionRef, pending: PendingAutoTitle): void;
  getPendingAutoTitle(sessionRef: SessionRef): PendingAutoTitle | undefined;
  clearPendingAutoTitle(sessionRef: SessionRef): void;
  updateQueuedComposerMessages(
    sessionRef: SessionRef,
    queuedMessages: readonly import("@pi-gui/session-driver").SessionQueuedMessage[] | undefined,
  ): void;
  getQueuedComposerMessages(sessionRef: SessionRef): readonly QueuedComposerMessage[];
  setQueuedComposerEditState(
    sessionRef: SessionRef,
    editState: QueuedComposerEditState | undefined,
  ): void;
  getQueuedComposerEditState(sessionRef: SessionRef): QueuedComposerEditState | undefined;
  reloadTranscriptFromDriver(sessionRef: SessionRef): Promise<void>;
  publishSelectedTranscript(): void;
  publishSelectedTranscriptFor(sessionRef: SessionRef): void;
  buildCreateSessionOptions(workspaceId: string): Promise<CreateSessionOptions | undefined>;
}

export interface RefreshStateOptions {
  readonly selectedWorkspaceId?: string;
  readonly selectedSessionId?: string;
  readonly composerDraft?: string;
  readonly composerDraftSyncSource?: ComposerDraftSyncSource;
  readonly clearLastError?: boolean;
  readonly refreshWorktrees?: boolean;
  readonly activeView?: AppView;
  readonly markSelectedSessionViewed?: boolean;
  readonly hydrateSelectedSession?: boolean;
  readonly emitState?: boolean;
  readonly persistState?: boolean;
  readonly publishSelectedTranscript?: boolean;
}
