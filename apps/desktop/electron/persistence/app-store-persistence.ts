import type {
  AppView,
  ExtensionCommandCompatibilityRecord,
  ModelSettingsScopeMode,
  NotificationPreferences,
  OrchestrationChildThread,
  ThemeMode,
  ThemePresetId,
  ThreadGrouping,
} from "../../contracts/desktop-state";
import type { ExtensionFlagValues } from "@pi-gui/session-driver";
import type { ModelSettingsSnapshot } from "@pi-gui/session-driver/runtime-types";
import type { TaskWorkbenchTemplate } from "../../contracts/workbench";
import { coreMethods } from "../../core-process/protocol";
import type { RpcPeer } from "../../rpc/rpc-peer";

export interface PersistedUiState {
  readonly version?:
    2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19;
  readonly taskWorkbenchTemplatesBySession?: Record<string, TaskWorkbenchTemplate>;
  readonly selectedWorkspaceId?: string;
  readonly selectedSessionId?: string;
  readonly activeView?: AppView;
  readonly composerDraft?: string;
  readonly composerDraftsBySession?: Record<string, string>;
  readonly extensionCommandCompatibilityByWorkspace?: Record<
    string,
    readonly ExtensionCommandCompatibilityRecord[]
  >;
  /** Flag values last chosen for a new thread, by root workspace. */
  readonly extensionFlagsByWorkspace?: Record<string, ExtensionFlagValues>;
  /** Flag values each thread's pi session started with, by session key. */
  readonly extensionFlagsBySession?: Record<string, ExtensionFlagValues>;
  readonly notificationPreferences?: Partial<NotificationPreferences>;
  /** Names of pi-gui built-in extensions the user switched off. */
  readonly disabledBuiltinExtensions?: readonly string[];
  readonly integratedTerminalShell?: string;
  readonly lastViewedAtBySession?: Record<string, string>;
  readonly lastInteractedAtBySession?: Record<string, string>;
  readonly pinnedAtBySession?: Record<string, string>;
  readonly pinnedSessionOrder?: readonly string[];
  readonly workspaceOrder?: readonly string[];
  readonly modelSettingsScopeMode?: ModelSettingsScopeMode;
  readonly appGlobalModelSettings?: ModelSettingsSnapshot;
  readonly sidebarCollapsed?: boolean;
  readonly threadGrouping?: ThreadGrouping;
  readonly collapsedWorkspaceIds?: readonly string[];
  readonly allowMultiple?: boolean;
  readonly enableTransparency?: boolean;
  readonly themeMode?: ThemeMode;
  readonly themePresetId?: ThemePresetId;
  readonly orchestrationChildren?: readonly OrchestrationChildThread[];
}

export interface LegacyPersistedUiState extends PersistedUiState {
  readonly composerAttachmentsBySession?: Record<string, readonly unknown[]>;
  readonly transcripts?: Record<string, readonly unknown[]>;
}

/**
 * `ui-state.json` in the profile folder, read, checked and decoded by the Rust core
 * (`crates/pi-gui-core/src/persistence/ui_state.rs`). Saved data it cannot understand is
 * reported, never replaced; a damaged file falls back to its `.bak` copy.
 */
export async function readPersistedUiState(core: RpcPeer): Promise<LegacyPersistedUiState> {
  return (await core.request(coreMethods.uiStateRead)) as LegacyPersistedUiState;
}

/** Saves the state as version 19, first copying data from an older version aside. */
export async function writePersistedUiState(core: RpcPeer, state: PersistedUiState): Promise<void> {
  await core.request(coreMethods.uiStateWrite, { state });
}
