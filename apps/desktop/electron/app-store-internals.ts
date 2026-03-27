import type { PiSdkDriver, JsonCatalogStore } from "@pi-gui/pi-sdk-driver";
import type { SessionConfig, SessionRef, WorkspaceRef } from "@pi-gui/session-driver";
import type { RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import type { AppView, ComposerImageAttachment, DesktopAppState, TranscriptMessage } from "../src/desktop-state";
import type { SessionStateMap } from "./session-state-map";
import type { GitWorktreeManager } from "./worktree-manager";
import type { JsonFileStore } from "./json-file-store";

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

  /* ── Infrastructure ────────────────────────────────────── */
  readonly driver: PiSdkDriver;
  readonly catalogStore: JsonCatalogStore;
  readonly worktreeManager: GitWorktreeManager;
  readonly attachmentStore: JsonFileStore<ComposerImageAttachment[]>;

  /* ── Shared helpers (called by extracted method groups) ── */
  initialize(): Promise<void>;
  refreshState(options?: RefreshStateOptions): Promise<DesktopAppState>;
  emit(): DesktopAppState;
  withError(error: unknown): Promise<DesktopAppState>;
  withErrorHandling(fn: () => Promise<DesktopAppState>): Promise<DesktopAppState>;
  workspaceRefFromState(workspaceId: string): WorkspaceRef | undefined;
  selectedSessionRef(): SessionRef | undefined;
  getExtensionFilePath(workspaceId: string, filePath: string): string | undefined;
  sessionFromState(sessionRef: SessionRef): { archivedAt?: string; updatedAt: string; title: string; status: string } | undefined;
  ensureSessionReady(sessionRef: SessionRef): Promise<void>;
  ensureSessionSubscribed(sessionRef: SessionRef): Promise<void>;
  refreshSessionCommandsFor(sessionRef: SessionRef): Promise<void>;
  clearExtensionUiForSession(sessionRef: SessionRef): void;
  cancelPendingDialogsForSession(sessionRef: SessionRef): Promise<void>;
  persistUiState(): Promise<void>;
  persistComposerAttachments(key: string, attachments: readonly ComposerImageAttachment[]): Promise<void>;
  persistTranscriptCacheForSession(sessionRef: SessionRef): void;
  schedulePersistUiState(): void;
  updateSessionConfig(sessionRef: SessionRef, config: SessionConfig | undefined): void;
  reloadTranscriptFromDriver(sessionRef: SessionRef): Promise<void>;
}

export interface RefreshStateOptions {
  readonly selectedWorkspaceId?: string;
  readonly selectedSessionId?: string;
  readonly composerDraft?: string;
  readonly clearLastError?: boolean;
  readonly refreshWorktrees?: boolean;
  readonly activeView?: AppView;
}
