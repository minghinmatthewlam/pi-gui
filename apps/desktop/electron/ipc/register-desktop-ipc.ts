import { ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import path from "node:path";
import type { SessionRef } from "@pi-gui/session-driver";
import type {
  ComposerAttachment,
  DesktopAppState,
  WorkspaceSessionTarget,
} from "../../contracts/desktop-state";
import {
  ComposerAttachmentLimitError,
  type ClipboardImageRead,
} from "../../contracts/composer-attachments";
import {
  desktopIpc,
  type ChangedFilesResult,
  type CustomProviderProbeInput,
  type CustomProviderProbeResult,
} from "../../contracts/ipc";
import type { DesktopAppStore } from "../application/app-store";
import type { NotificationPermissionService } from "../platform/notification-permission";
import type { TerminalService } from "../platform/terminal-service";
import type { ThemeManager } from "../platform/theme-manager";
import type { WindowOwner } from "../windows/window-owner";
import { WorkbenchRequests, type WorkbenchOwner } from "./workbench-requests";
import { assertComposerAttachmentPixels } from "./composer-attachment-pixels";
import {
  expectAppView,
  expectBoolean,
  expectComposerAttachments,
  expectCreateSessionInput,
  expectCreateWorktreeInput,
  expectCustomProviderConfig,
  expectCustomProviderProbeInput,
  expectForkThreadInput,
  expectHostUiResponse,
  expectModelSettingsScopeMode,
  expectNavigateSessionTreeOptions,
  expectNonEmptyString,
  expectNotificationPreferences,
  expectOptionalDeliverOptions,
  expectOptionalString,
  expectOptionalThinkingLevel,
  expectRemoveWorktreeInput,
  expectSendChildThreadFollowUpInput,
  expectSessionTarget,
  expectSetChildSupervisionLoopInput,
  expectStartThreadInput,
  expectCreateScheduledTaskInput,
  expectUpdateScheduledTaskInput,
  expectString,
  expectStringArray,
  expectTerminalSize,
  expectThemeMode,
  expectThemePresetId,
  expectThreadGrouping,
  expectThinkingLevel,
  expectWorkspaceFileListOptions,
} from "./request-validation";

type StateOwner = Pick<
  DesktopAppStore,
  | "getStateForView"
  | "getSelectedTranscriptForView"
  | "setActiveView"
  | "setSidebarCollapsed"
  | "setThreadGrouping"
  | "setThemeMode"
  | "setThemePresetId"
>;

type WorkspaceOwner = Pick<
  DesktopAppStore,
  | "addWorkspace"
  | "selectWorkspace"
  | "renameWorkspace"
  | "removeWorkspace"
  | "reorderWorkspaces"
  | "createWorktree"
  | "removeWorktree"
  | "syncCurrentWorkspace"
  | "getWorkspacePath"
>;

type ConversationOwner = Pick<
  DesktopAppStore,
  | "reorderPinnedSessions"
  | "selectSession"
  | "renameSession"
  | "archiveSession"
  | "unarchiveSession"
  | "markSessionRead"
  | "setSessionPinned"
  | "createSession"
  | "startThread"
  | "forkThread"
  | "cancelCurrentRun"
  | "addComposerAttachments"
  | "removeComposerAttachment"
  | "editQueuedComposerMessage"
  | "cancelQueuedComposerEdit"
  | "removeQueuedComposerMessage"
  | "steerQueuedComposerMessage"
  | "updateComposerDraft"
  | "submitComposer"
  | "getSessionTree"
  | "navigateSessionTree"
  | "respondToHostUiRequest"
  | "setSessionModel"
  | "setSessionThinkingLevel"
  | "withError"
>;

type OrchestrationOwner = Pick<
  DesktopAppStore,
  "sendChildThreadFollowUp" | "setChildSupervisionLoop"
>;

type ScheduledTaskOwner = Pick<
  DesktopAppStore,
  | "createScheduledTask"
  | "updateScheduledTask"
  | "deleteScheduledTask"
  | "beginScheduledTaskInterview"
>;

type SettingsOwner = Pick<
  DesktopAppStore,
  | "refreshRuntime"
  | "setModelSettingsScopeMode"
  | "setDefaultModel"
  | "setDefaultThinkingLevel"
  | "loginProvider"
  | "logoutProvider"
  | "setProviderApiKey"
  | "setEnableSkillCommands"
  | "listCustomProviders"
  | "setCustomProvider"
  | "deleteCustomProvider"
  | "setScopedModelPatterns"
  | "setSkillEnabled"
  | "setExtensionEnabled"
  | "setNotificationPreferences"
  | "setIntegratedTerminalShell"
  | "setEnableTransparency"
  | "getSkillFilePath"
  | "getExtensionFilePath"
>;

export interface DesktopIpcOwners {
  readonly state: StateOwner;
  readonly workbench: WorkbenchOwner;
  readonly workspace: WorkspaceOwner;
  readonly conversation: ConversationOwner;
  readonly orchestration: OrchestrationOwner;
  readonly scheduledTasks: ScheduledTaskOwner;
  readonly settings: SettingsOwner;
}

export interface DesktopIpcCapabilities {
  readonly ping: () => string;
  readonly theme: ThemeManager;
  readonly openExternal: (url: string) => Promise<void>;
  readonly pickWorkspace: (window: BrowserWindow) => Promise<DesktopAppState>;
  readonly createLoginCallbacks: (
    window: BrowserWindow,
  ) => Parameters<DesktopAppStore["loginProvider"]>[2];
  readonly probeCustomProviderModels: (
    input: CustomProviderProbeInput,
  ) => Promise<CustomProviderProbeResult>;
  readonly notificationPermission: () => NotificationPermissionService | undefined;
  readonly terminal: () => TerminalService;
  readonly optionalTerminal: () => TerminalService | undefined;
  readonly setTerminalFocused: (webContentsId: number, focused: boolean) => void;
  readonly setSidePanelFocused: (webContentsId: number, focused: boolean) => void;
  readonly setTransparency: (enabled: boolean) => void;
  readonly pickComposerAttachments: (
    window: BrowserWindow,
    existing?: readonly ComposerAttachment[],
  ) => Promise<readonly ComposerAttachment[] | undefined>;
  readonly readClipboardImage: () => ClipboardImageRead;
  readonly validateComposerAttachments: (
    attachments: readonly ComposerAttachment[],
  ) => readonly ComposerAttachment[];
  readonly listWorkspaceFiles: (
    workspacePath: string,
    options?: { readonly force?: boolean },
  ) => Promise<readonly unknown[]>;
  readonly readWorkspaceFile: (workspacePath: string, filePath: string) => Promise<unknown>;
  readonly revealWorkspaceFile: (workspacePath: string, filePath: string) => Promise<void>;
  readonly getChangedFiles: (workspacePath: string) => Promise<ChangedFilesResult>;
  readonly getFileDiff: (workspacePath: string, filePath: string) => Promise<string>;
  readonly stageFile: (
    workspacePath: string,
    filePath: string,
    options: { readonly sourcePath?: string },
  ) => Promise<void>;
  readonly relaunchApplication: () => void;
}

export interface RegisterDesktopIpcOptions {
  readonly windows: WindowOwner;
  readonly owners: DesktopIpcOwners;
  readonly capabilities: DesktopIpcCapabilities;
}

function senderWindow(windows: WindowOwner, event: IpcMainInvokeEvent): BrowserWindow {
  return windows.windowForSender(event.sender);
}

export function registerDesktopIpc({
  windows,
  owners,
  capabilities,
}: RegisterDesktopIpcOptions): void {
  const workbench = new WorkbenchRequests(owners.workbench);
  const workbenchSenders = new WeakSet<Electron.WebContents>();
  const workbenchSender = (event: IpcMainInvokeEvent) => {
    const sender = windows.windowForSender(event.sender).webContents;
    if (!event.senderFrame || event.senderFrame !== sender.mainFrame) {
      throw new Error("Workbench requests must originate from the window's main frame.");
    }
    if (!workbenchSenders.has(sender)) {
      workbenchSenders.add(sender);
      sender.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
        if (isMainFrame && !isInPlace) workbench.resetRenderer(sender);
      });
      sender.once("destroyed", () => workbench.resetRenderer(sender));
    }
    return sender;
  };
  ipcMain.handle(desktopIpc.getTaskWorkbenchTemplate, (event, rawTarget: unknown) => {
    workbenchSender(event);
    return workbench.get(rawTarget);
  });
  ipcMain.handle(desktopIpc.saveTaskWorkbenchTemplate, (event, rawInput: unknown) =>
    workbench.save(workbenchSender(event), rawInput),
  );
  const run = (event: IpcMainInvokeEvent, action: () => Promise<DesktopAppState>) =>
    windows.runStateAction(senderWindow(windows, event), action);
  const immediate = (event: IpcMainInvokeEvent, action: () => Promise<DesktopAppState>) =>
    windows.runImmediateStateAction(senderWindow(windows, event), action);
  const reportLimit = (event: IpcMainInvokeEvent, error: ComposerAttachmentLimitError) =>
    run(event, () => owners.conversation.withError(error));
  const runCatchingLimits = async (
    event: IpcMainInvokeEvent,
    action: () => Promise<DesktopAppState>,
  ): Promise<DesktopAppState> => {
    try {
      return await action();
    } catch (error) {
      if (error instanceof ComposerAttachmentLimitError) {
        return reportLimit(event, error);
      }
      throw error;
    }
  };

  ipcMain.handle(desktopIpc.ping, (event) => {
    windows.windowForSender(event.sender);
    return capabilities.ping();
  });
  ipcMain.handle(desktopIpc.getThemeMode, (event) => {
    windows.windowForSender(event.sender);
    return capabilities.theme.getMode();
  });
  ipcMain.handle(desktopIpc.getResolvedTheme, (event) => {
    windows.windowForSender(event.sender);
    return capabilities.theme.getResolvedTheme();
  });
  ipcMain.handle(desktopIpc.setThemeMode, (event, rawMode: unknown) => {
    windows.windowForSender(event.sender);
    const mode = expectThemeMode(rawMode);
    capabilities.theme.setMode(mode);
    return run(event, () => owners.state.setThemeMode(mode));
  });
  ipcMain.handle(desktopIpc.setThemePresetId, (event, rawPresetId: unknown) => {
    const presetId = expectThemePresetId(rawPresetId);
    return run(event, () => owners.state.setThemePresetId(presetId));
  });
  ipcMain.handle(desktopIpc.openExternal, (event, rawUrl: unknown) => {
    windows.windowForSender(event.sender);
    return capabilities.openExternal(expectString(rawUrl, "url"));
  });
  ipcMain.handle(desktopIpc.relaunchApplication, (event) => {
    windows.windowForSender(event.sender);
    capabilities.relaunchApplication();
  });
  ipcMain.handle(desktopIpc.stateRequest, (event) =>
    owners.state.getStateForView(windows.viewForSender(event.sender)),
  );
  ipcMain.handle(desktopIpc.selectedTranscriptRequest, (event) =>
    owners.state.getSelectedTranscriptForView(windows.viewForSender(event.sender)),
  );

  ipcMain.handle(desktopIpc.addWorkspacePath, (event, rawPath: unknown) =>
    run(event, () => owners.workspace.addWorkspace(expectNonEmptyString(rawPath, "workspacePath"))),
  );
  ipcMain.handle(desktopIpc.pickWorkspace, (event) =>
    capabilities.pickWorkspace(senderWindow(windows, event)),
  );
  ipcMain.handle(desktopIpc.selectWorkspace, (event, rawWorkspaceId: unknown) =>
    run(event, () =>
      owners.workspace.selectWorkspace(expectNonEmptyString(rawWorkspaceId, "workspaceId")),
    ),
  );
  ipcMain.handle(
    desktopIpc.renameWorkspace,
    (event, rawWorkspaceId: unknown, rawDisplayName: unknown) =>
      run(event, () =>
        owners.workspace.renameWorkspace(
          expectNonEmptyString(rawWorkspaceId, "workspaceId"),
          expectString(rawDisplayName, "displayName"),
        ),
      ),
  );
  ipcMain.handle(desktopIpc.removeWorkspace, (event, rawWorkspaceId: unknown) =>
    run(event, () =>
      owners.workspace.removeWorkspace(expectNonEmptyString(rawWorkspaceId, "workspaceId")),
    ),
  );
  ipcMain.handle(desktopIpc.reorderWorkspaces, (event, rawOrder: unknown) =>
    run(event, () => owners.workspace.reorderWorkspaces(expectStringArray(rawOrder, "order"))),
  );
  ipcMain.handle(desktopIpc.reorderPinnedSessions, (event, rawOrder: unknown) =>
    run(event, () =>
      owners.conversation.reorderPinnedSessions(expectStringArray(rawOrder, "order")),
    ),
  );
  ipcMain.handle(desktopIpc.openWorkspaceInFinder, async (event, rawWorkspaceId: unknown) => {
    windows.windowForSender(event.sender);
    const workspaceId = expectNonEmptyString(rawWorkspaceId, "workspaceId");
    const workspacePath = owners.workspace.getWorkspacePath(workspaceId);
    if (!workspacePath) {
      throw new Error(`Unknown workspace: ${workspaceId}`);
    }
    await shell.openPath(workspacePath);
  });
  ipcMain.handle(desktopIpc.createWorktree, (event, rawInput: unknown) =>
    run(event, () => owners.workspace.createWorktree(expectCreateWorktreeInput(rawInput))),
  );
  ipcMain.handle(desktopIpc.removeWorktree, (event, rawInput: unknown) =>
    run(event, () => owners.workspace.removeWorktree(expectRemoveWorktreeInput(rawInput))),
  );
  ipcMain.handle(desktopIpc.syncCurrentWorkspace, (event) =>
    run(event, () => owners.workspace.syncCurrentWorkspace()),
  );

  ipcMain.handle(desktopIpc.selectSession, (event, rawTarget: unknown) => {
    const target = expectSessionTarget(rawTarget);
    return run(event, () => owners.conversation.selectSession(target));
  });
  ipcMain.handle(desktopIpc.renameSession, (event, rawTarget: unknown, rawTitle: unknown) => {
    const target = expectSessionTarget(rawTarget);
    const title = expectString(rawTitle, "title");
    return run(event, () => owners.conversation.renameSession(target, title));
  });
  ipcMain.handle(desktopIpc.archiveSession, (event, rawTarget: unknown) => {
    const target = expectSessionTarget(rawTarget);
    return run(event, () => owners.conversation.archiveSession(target));
  });
  ipcMain.handle(desktopIpc.unarchiveSession, (event, rawTarget: unknown) => {
    const target = expectSessionTarget(rawTarget);
    return run(event, () => owners.conversation.unarchiveSession(target));
  });
  ipcMain.handle(desktopIpc.markSessionRead, (event, rawTarget: unknown) => {
    const target = expectSessionTarget(rawTarget);
    return run(event, () => owners.conversation.markSessionRead(target));
  });
  ipcMain.handle(desktopIpc.setSessionPinned, (event, rawTarget: unknown, rawPinned: unknown) => {
    const target = expectSessionTarget(rawTarget);
    const pinned = expectBoolean(rawPinned, "pinned");
    // Pin metadata has an explicit target and must not wait for an active prompt to finish.
    return immediate(event, () => owners.conversation.setSessionPinned(target, pinned));
  });
  ipcMain.handle(desktopIpc.setActiveView, (event, rawView: unknown) => {
    const view = expectAppView(rawView);
    return run(event, () => owners.state.setActiveView(view));
  });
  ipcMain.handle(desktopIpc.setSidebarCollapsed, (event, rawCollapsed: unknown) =>
    run(event, () => owners.state.setSidebarCollapsed(expectBoolean(rawCollapsed, "collapsed"))),
  );
  ipcMain.handle(desktopIpc.setThreadGrouping, (event, rawGrouping: unknown) =>
    run(event, () => owners.state.setThreadGrouping(expectThreadGrouping(rawGrouping))),
  );

  ipcMain.handle(desktopIpc.refreshRuntime, (event, rawWorkspaceId: unknown) =>
    run(event, () =>
      owners.settings.refreshRuntime(expectOptionalString(rawWorkspaceId, "workspaceId")),
    ),
  );
  ipcMain.handle(desktopIpc.setModelSettingsScopeMode, (event, rawMode: unknown) => {
    const mode = expectModelSettingsScopeMode(rawMode);
    return run(event, () => owners.settings.setModelSettingsScopeMode(mode));
  });
  ipcMain.handle(
    desktopIpc.setSessionModel,
    (
      event,
      rawWorkspaceId: unknown,
      rawSessionId: unknown,
      rawProvider: unknown,
      rawModel: unknown,
    ) =>
      run(event, () =>
        owners.conversation.setSessionModel(
          {
            workspaceId: expectNonEmptyString(rawWorkspaceId, "workspaceId"),
            sessionId: expectNonEmptyString(rawSessionId, "sessionId"),
          },
          expectNonEmptyString(rawProvider, "provider"),
          expectNonEmptyString(rawModel, "modelId"),
        ),
      ),
  );
  ipcMain.handle(
    desktopIpc.setDefaultModel,
    (event, rawWorkspaceId: unknown, rawProvider: unknown, rawModel: unknown) =>
      run(event, () =>
        owners.settings.setDefaultModel(
          expectNonEmptyString(rawWorkspaceId, "workspaceId"),
          expectNonEmptyString(rawProvider, "provider"),
          expectNonEmptyString(rawModel, "modelId"),
        ),
      ),
  );
  ipcMain.handle(
    desktopIpc.setDefaultThinkingLevel,
    (event, rawWorkspaceId: unknown, thinkingLevel: unknown) =>
      run(event, () =>
        owners.settings.setDefaultThinkingLevel(
          expectNonEmptyString(rawWorkspaceId, "workspaceId"),
          expectOptionalThinkingLevel(thinkingLevel),
        ),
      ),
  );
  ipcMain.handle(
    desktopIpc.setSessionThinkingLevel,
    (event, rawWorkspaceId: unknown, rawSessionId: unknown, thinkingLevel: unknown) =>
      run(event, () =>
        owners.conversation.setSessionThinkingLevel(
          {
            workspaceId: expectNonEmptyString(rawWorkspaceId, "workspaceId"),
            sessionId: expectNonEmptyString(rawSessionId, "sessionId"),
          },
          expectThinkingLevel(thinkingLevel),
        ),
      ),
  );
  ipcMain.handle(
    desktopIpc.loginProvider,
    (event, rawWorkspaceId: unknown, rawProviderId: unknown) => {
      const window = senderWindow(windows, event);
      return windows.runUnscopedStateAction(window, () =>
        owners.settings.loginProvider(
          expectNonEmptyString(rawWorkspaceId, "workspaceId"),
          expectNonEmptyString(rawProviderId, "providerId"),
          capabilities.createLoginCallbacks(window),
        ),
      );
    },
  );
  ipcMain.handle(
    desktopIpc.logoutProvider,
    (event, rawWorkspaceId: unknown, rawProviderId: unknown) =>
      run(event, () =>
        owners.settings.logoutProvider(
          expectNonEmptyString(rawWorkspaceId, "workspaceId"),
          expectNonEmptyString(rawProviderId, "providerId"),
        ),
      ),
  );
  ipcMain.handle(
    desktopIpc.setProviderApiKey,
    (event, rawWorkspaceId: unknown, rawProviderId: unknown, rawApiKey: unknown) =>
      run(event, () =>
        owners.settings.setProviderApiKey(
          expectNonEmptyString(rawWorkspaceId, "workspaceId"),
          expectNonEmptyString(rawProviderId, "providerId"),
          expectString(rawApiKey, "apiKey"),
        ),
      ),
  );
  ipcMain.handle(
    desktopIpc.setEnableSkillCommands,
    (event, rawWorkspaceId: unknown, rawEnabled: unknown) =>
      run(event, () =>
        owners.settings.setEnableSkillCommands(
          expectNonEmptyString(rawWorkspaceId, "workspaceId"),
          expectBoolean(rawEnabled, "enabled"),
        ),
      ),
  );
  ipcMain.handle(desktopIpc.listCustomProviders, (event) => {
    windows.windowForSender(event.sender);
    return owners.settings.listCustomProviders();
  });
  ipcMain.handle(
    desktopIpc.setCustomProvider,
    (event, rawWorkspaceId: unknown, rawConfig: unknown) =>
      run(event, () =>
        owners.settings.setCustomProvider(
          expectNonEmptyString(rawWorkspaceId, "workspaceId"),
          expectCustomProviderConfig(rawConfig),
        ),
      ),
  );
  ipcMain.handle(
    desktopIpc.deleteCustomProvider,
    (event, rawWorkspaceId: unknown, rawProviderId: unknown) =>
      run(event, () =>
        owners.settings.deleteCustomProvider(
          expectNonEmptyString(rawWorkspaceId, "workspaceId"),
          expectNonEmptyString(rawProviderId, "providerId"),
        ),
      ),
  );
  ipcMain.handle(desktopIpc.probeCustomProviderModels, (event, rawInput: unknown) => {
    windows.windowForSender(event.sender);
    return capabilities.probeCustomProviderModels(expectCustomProviderProbeInput(rawInput));
  });
  ipcMain.handle(
    desktopIpc.setScopedModelPatterns,
    (event, rawWorkspaceId: unknown, rawPatterns: unknown) =>
      run(event, () =>
        owners.settings.setScopedModelPatterns(
          expectNonEmptyString(rawWorkspaceId, "workspaceId"),
          expectStringArray(rawPatterns, "patterns"),
        ),
      ),
  );
  ipcMain.handle(
    desktopIpc.setSkillEnabled,
    (event, rawWorkspaceId: unknown, rawFilePath: unknown, rawEnabled: unknown) =>
      run(event, () =>
        owners.settings.setSkillEnabled(
          expectNonEmptyString(rawWorkspaceId, "workspaceId"),
          expectNonEmptyString(rawFilePath, "filePath"),
          expectBoolean(rawEnabled, "enabled"),
        ),
      ),
  );
  ipcMain.handle(
    desktopIpc.setExtensionEnabled,
    (event, rawWorkspaceId: unknown, rawFilePath: unknown, rawEnabled: unknown) =>
      run(event, () =>
        owners.settings.setExtensionEnabled(
          expectNonEmptyString(rawWorkspaceId, "workspaceId"),
          expectNonEmptyString(rawFilePath, "filePath"),
          expectBoolean(rawEnabled, "enabled"),
        ),
      ),
  );
  ipcMain.handle(
    desktopIpc.respondToHostUiRequest,
    (event, rawWorkspaceId: unknown, rawSessionId: unknown, rawResponse: unknown) =>
      immediate(event, () =>
        owners.conversation.respondToHostUiRequest(
          {
            workspaceId: expectNonEmptyString(rawWorkspaceId, "workspaceId"),
            sessionId: expectNonEmptyString(rawSessionId, "sessionId"),
          },
          expectHostUiResponse(rawResponse),
        ),
      ),
  );
  ipcMain.handle(desktopIpc.setNotificationPreferences, (event, rawPreferences: unknown) =>
    run(event, () =>
      owners.settings.setNotificationPreferences(expectNotificationPreferences(rawPreferences)),
    ),
  );
  ipcMain.handle(desktopIpc.setIntegratedTerminalShell, (event, rawShellPath: unknown) =>
    run(event, () =>
      owners.settings.setIntegratedTerminalShell(expectString(rawShellPath, "shellPath")),
    ),
  );
  ipcMain.handle(desktopIpc.setEnableTransparency, async (event, rawEnabled: unknown) => {
    const window = senderWindow(windows, event);
    const enabled = expectBoolean(rawEnabled, "enabled");
    return windows.runUnscopedStateAction(window, async () => {
      const state = await owners.settings.setEnableTransparency(enabled);
      capabilities.setTransparency(enabled);
      return state;
    });
  });

  registerTerminalIpc(windows, capabilities);

  ipcMain.handle(desktopIpc.getNotificationPermissionStatus, (event) => {
    windows.windowForSender(event.sender);
    return capabilities.notificationPermission()?.getCurrentStatus() ?? Promise.resolve("unknown");
  });
  ipcMain.handle(desktopIpc.requestNotificationPermission, (event) => {
    windows.windowForSender(event.sender);
    return capabilities.notificationPermission()?.requestPermission() ?? Promise.resolve("unknown");
  });
  ipcMain.handle(desktopIpc.openSystemNotificationSettings, (event) => {
    windows.windowForSender(event.sender);
    return capabilities.notificationPermission()?.openSystemSettings() ?? Promise.resolve();
  });

  ipcMain.handle(desktopIpc.createSession, (event, rawInput: unknown) =>
    run(event, () => owners.conversation.createSession(expectCreateSessionInput(rawInput))),
  );
  ipcMain.handle(desktopIpc.startThread, (event, rawInput: unknown) => {
    const input = expectStartThreadInput(rawInput);
    if (input.attachments?.length) {
      assertComposerAttachmentPixels(input.attachments);
    }
    return run(event, () => owners.conversation.startThread(input));
  });
  ipcMain.handle(desktopIpc.forkThread, (event, rawInput: unknown) =>
    run(event, () => owners.conversation.forkThread(expectForkThreadInput(rawInput))),
  );
  ipcMain.handle(desktopIpc.sendChildThreadFollowUp, (event, rawInput: unknown) =>
    run(event, () =>
      owners.orchestration.sendChildThreadFollowUp(expectSendChildThreadFollowUpInput(rawInput)),
    ),
  );
  ipcMain.handle(desktopIpc.setChildSupervisionLoop, (event, rawInput: unknown) =>
    run(event, () =>
      owners.orchestration.setChildSupervisionLoop(expectSetChildSupervisionLoopInput(rawInput)),
    ),
  );
  ipcMain.handle(desktopIpc.createScheduledTask, (event, rawInput: unknown) =>
    run(event, () =>
      owners.scheduledTasks.createScheduledTask(expectCreateScheduledTaskInput(rawInput)),
    ),
  );
  ipcMain.handle(desktopIpc.updateScheduledTask, (event, rawId: unknown, rawPatch: unknown) =>
    run(event, () =>
      owners.scheduledTasks.updateScheduledTask(
        expectNonEmptyString(rawId, "id"),
        expectUpdateScheduledTaskInput(rawPatch),
      ),
    ),
  );
  ipcMain.handle(desktopIpc.deleteScheduledTask, (event, rawId: unknown) =>
    run(event, () => owners.scheduledTasks.deleteScheduledTask(expectNonEmptyString(rawId, "id"))),
  );
  ipcMain.handle(desktopIpc.beginScheduledTaskInterview, (event) =>
    run(event, () => owners.scheduledTasks.beginScheduledTaskInterview()),
  );
  ipcMain.handle(
    desktopIpc.openSkillInFinder,
    (event, rawWorkspaceId: unknown, rawFilePath: unknown) => {
      windows.windowForSender(event.sender);
      return openOwnedFileInFinder(
        owners.settings.getSkillFilePath(
          expectNonEmptyString(rawWorkspaceId, "workspaceId"),
          expectNonEmptyString(rawFilePath, "filePath"),
        ),
        expectString(rawFilePath, "filePath"),
        "skill",
      );
    },
  );
  ipcMain.handle(
    desktopIpc.openExtensionInFinder,
    (event, rawWorkspaceId: unknown, rawFilePath: unknown) => {
      windows.windowForSender(event.sender);
      return openOwnedFileInFinder(
        owners.settings.getExtensionFilePath(
          expectNonEmptyString(rawWorkspaceId, "workspaceId"),
          expectNonEmptyString(rawFilePath, "filePath"),
        ),
        expectString(rawFilePath, "filePath"),
        "extension",
      );
    },
  );

  ipcMain.handle(desktopIpc.cancelCurrentRun, (event) => {
    const target = windows.targetForSender(event.sender);
    // A long slash command can still own the serialized action queue.
    // Stop must bypass that queue and cancel the captured target immediately.
    return immediate(event, () => owners.conversation.cancelCurrentRun(target));
  });
  ipcMain.handle(desktopIpc.pickComposerAttachments, (event) =>
    runCatchingLimits(event, async () => {
      const window = senderWindow(windows, event);
      const target = windows.targetForSender(event.sender);
      const existing = (await windows.stateForWindow(window)).composerAttachments ?? [];
      const attachments = await capabilities.pickComposerAttachments(window, existing);
      if (!attachments?.length) {
        return windows.stateForWindow(window);
      }
      assertComposerAttachmentPixels(attachments);
      return windows.runStateAction(window, () =>
        owners.conversation.addComposerAttachments(target, attachments),
      );
    }),
  );
  ipcMain.on(desktopIpc.readClipboardImage, (event) => {
    windows.windowForSender(event.sender);
    event.returnValue = capabilities.readClipboardImage();
  });
  ipcMain.handle(desktopIpc.addComposerAttachments, (event, rawAttachments: unknown) =>
    runCatchingLimits(event, () => {
      const target = windows.targetForSender(event.sender);
      const attachments = capabilities.validateComposerAttachments(
        expectComposerAttachments(rawAttachments),
      );
      assertComposerAttachmentPixels(attachments);
      return run(event, () => owners.conversation.addComposerAttachments(target, attachments));
    }),
  );
  ipcMain.handle(desktopIpc.removeComposerAttachment, (event, rawAttachmentId: unknown) => {
    const target = windows.targetForSender(event.sender);
    return run(event, () =>
      owners.conversation.removeComposerAttachment(
        target,
        expectNonEmptyString(rawAttachmentId, "attachmentId"),
      ),
    );
  });
  ipcMain.handle(
    desktopIpc.editQueuedComposerMessage,
    (event, rawMessageId: unknown, rawCurrentDraft: unknown) => {
      const target = windows.targetForSender(event.sender);
      return run(event, () =>
        owners.conversation.editQueuedComposerMessage(
          target,
          expectNonEmptyString(rawMessageId, "messageId"),
          expectOptionalString(rawCurrentDraft, "currentDraft"),
        ),
      );
    },
  );
  ipcMain.handle(desktopIpc.cancelQueuedComposerEdit, (event) => {
    const target = windows.targetForSender(event.sender);
    return run(event, () => owners.conversation.cancelQueuedComposerEdit(target));
  });
  ipcMain.handle(desktopIpc.removeQueuedComposerMessage, (event, rawMessageId: unknown) => {
    const target = windows.targetForSender(event.sender);
    return run(event, () =>
      owners.conversation.removeQueuedComposerMessage(
        target,
        expectNonEmptyString(rawMessageId, "messageId"),
      ),
    );
  });
  ipcMain.handle(desktopIpc.steerQueuedComposerMessage, (event, rawMessageId: unknown) => {
    const target = windows.targetForSender(event.sender);
    return run(event, () =>
      owners.conversation.steerQueuedComposerMessage(
        target,
        expectNonEmptyString(rawMessageId, "messageId"),
      ),
    );
  });
  ipcMain.handle(desktopIpc.updateComposerDraft, (event, rawDraft: unknown) => {
    const target = windows.targetForSender(event.sender);
    return run(event, () =>
      windows.withComposerDraftPersistOrigin(event.sender, () =>
        owners.conversation.updateComposerDraft(target, expectString(rawDraft, "composerDraft")),
      ),
    );
  });
  ipcMain.handle(desktopIpc.submitComposer, (event, rawText: unknown, rawOptions: unknown) => {
    const target = windows.targetForSender(event.sender);
    const text = expectString(rawText, "text");
    const options = expectOptionalDeliverOptions(rawOptions);
    // Ordinary prompts target a captured session and may await the entire turn.
    // Keep that wait outside the window queue so selection and other windows stay usable.
    // Slash commands can change selection (for example an extension creating a child
    // session), so retain their serialized sender-view context.
    const dispatch = text.trimStart().startsWith("/") ? run : immediate;
    return dispatch(event, () => owners.conversation.submitComposer(target, text, options));
  });
  ipcMain.handle(desktopIpc.getSessionTree, (event, rawTarget: unknown) => {
    windows.windowForSender(event.sender);
    return owners.conversation.getSessionTree(expectSessionTarget(rawTarget));
  });
  ipcMain.handle(
    desktopIpc.navigateSessionTree,
    (event, rawTarget: unknown, rawTargetId: unknown, rawOptions: unknown) => {
      const window = senderWindow(windows, event);
      const target = expectSessionTarget(rawTarget);
      const targetId = expectNonEmptyString(rawTargetId, "targetId");
      const options = expectNavigateSessionTreeOptions(rawOptions);
      return windows.runStateResultAction(window, () =>
        owners.conversation.navigateSessionTree(target, targetId, options),
      );
    },
  );

  registerWorkspaceFileIpc(windows, owners.workspace, capabilities);
  ipcMain.handle(desktopIpc.toggleWindowMaximize, (event) => {
    const window = senderWindow(windows, event);
    if (window.isMaximized()) {
      window.unmaximize();
    } else {
      window.maximize();
    }
  });
}

function registerTerminalIpc(windows: WindowOwner, capabilities: DesktopIpcCapabilities): void {
  ipcMain.handle(
    desktopIpc.terminalEnsurePanel,
    (event, rawWorkspaceId: unknown, rawScopeId: unknown, rawSize: unknown) =>
      capabilities
        .terminal()
        .ensurePanel(
          windows.windowForSender(event.sender).webContents,
          expectNonEmptyString(rawWorkspaceId, "workspaceId"),
          expectNonEmptyString(rawScopeId, "terminalScopeId"),
          expectTerminalSize(rawSize),
        ),
  );
  ipcMain.handle(
    desktopIpc.terminalCreateSession,
    (event, rawWorkspaceId: unknown, rawScopeId: unknown, rawSize: unknown) =>
      capabilities
        .terminal()
        .createSession(
          windows.windowForSender(event.sender).webContents,
          expectNonEmptyString(rawWorkspaceId, "workspaceId"),
          expectNonEmptyString(rawScopeId, "terminalScopeId"),
          expectTerminalSize(rawSize),
        ),
  );
  ipcMain.handle(
    desktopIpc.terminalSetActiveSession,
    (event, rawWorkspaceId: unknown, rawScopeId: unknown, rawTerminalId: unknown) =>
      capabilities
        .terminal()
        .setActiveSession(
          windows.windowForSender(event.sender).webContents,
          expectNonEmptyString(rawWorkspaceId, "workspaceId"),
          expectNonEmptyString(rawScopeId, "terminalScopeId"),
          expectNonEmptyString(rawTerminalId, "terminalId"),
        ),
  );
  ipcMain.handle(desktopIpc.terminalWrite, (event, rawTerminalId: unknown, rawData: unknown) => {
    capabilities
      .optionalTerminal()
      ?.write(
        windows.windowForSender(event.sender).webContents,
        expectNonEmptyString(rawTerminalId, "terminalId"),
        expectString(rawData, "data"),
      );
  });
  ipcMain.handle(desktopIpc.terminalResize, (event, rawTerminalId: unknown, rawSize: unknown) => {
    capabilities
      .optionalTerminal()
      ?.resize(
        windows.windowForSender(event.sender).webContents,
        expectNonEmptyString(rawTerminalId, "terminalId"),
        expectTerminalSize(rawSize),
      );
  });
  ipcMain.handle(
    desktopIpc.terminalRestartSession,
    (event, rawTerminalId: unknown, rawSize: unknown) =>
      capabilities
        .terminal()
        .restart(
          windows.windowForSender(event.sender).webContents,
          expectNonEmptyString(rawTerminalId, "terminalId"),
          expectTerminalSize(rawSize),
        ),
  );
  ipcMain.handle(desktopIpc.terminalCloseSession, (event, rawTerminalId: unknown) =>
    capabilities
      .terminal()
      .close(
        windows.windowForSender(event.sender).webContents,
        expectNonEmptyString(rawTerminalId, "terminalId"),
      ),
  );
  ipcMain.handle(
    desktopIpc.terminalSetTitle,
    (event, rawTerminalId: unknown, rawTitle: unknown) => {
      capabilities
        .optionalTerminal()
        ?.setTitle(
          windows.windowForSender(event.sender).webContents,
          expectNonEmptyString(rawTerminalId, "terminalId"),
          expectString(rawTitle, "title"),
        );
    },
  );
  ipcMain.on(desktopIpc.terminalSetFocused, (event, rawFocused: unknown) => {
    const window = windows.windowForSender(event.sender);
    capabilities.setTerminalFocused(window.webContents.id, expectBoolean(rawFocused, "focused"));
  });
  ipcMain.on(desktopIpc.sidePanelSetFocused, (event, rawFocused: unknown) => {
    const window = windows.windowForSender(event.sender);
    capabilities.setSidePanelFocused(window.webContents.id, expectBoolean(rawFocused, "focused"));
  });
}

function registerWorkspaceFileIpc(
  windows: WindowOwner,
  workspace: WorkspaceOwner,
  capabilities: DesktopIpcCapabilities,
): void {
  ipcMain.handle(
    desktopIpc.listWorkspaceFiles,
    async (event, rawWorkspaceId: unknown, rawOptions: unknown) => {
      windows.windowForSender(event.sender);
      const workspacePath = workspace.getWorkspacePath(
        expectNonEmptyString(rawWorkspaceId, "workspaceId"),
      );
      if (!workspacePath) {
        return [];
      }
      const options = expectWorkspaceFileListOptions(rawOptions);
      return capabilities.listWorkspaceFiles(workspacePath, options);
    },
  );
  ipcMain.handle(
    desktopIpc.readWorkspaceFile,
    async (event, rawWorkspaceId: unknown, rawFilePath: unknown) => {
      windows.windowForSender(event.sender);
      const workspaceId = expectNonEmptyString(rawWorkspaceId, "workspaceId");
      const workspacePath = workspace.getWorkspacePath(workspaceId);
      if (!workspacePath) {
        throw new Error(`Unknown workspace: ${workspaceId}`);
      }
      return capabilities.readWorkspaceFile(workspacePath, expectString(rawFilePath, "filePath"));
    },
  );
  ipcMain.handle(
    desktopIpc.revealWorkspaceFile,
    async (event, rawWorkspaceId: unknown, rawFilePath: unknown) => {
      windows.windowForSender(event.sender);
      const workspaceId = expectNonEmptyString(rawWorkspaceId, "workspaceId");
      const workspacePath = workspace.getWorkspacePath(workspaceId);
      if (!workspacePath) {
        throw new Error(`Unknown workspace: ${workspaceId}`);
      }
      await capabilities.revealWorkspaceFile(workspacePath, expectString(rawFilePath, "filePath"));
    },
  );
  ipcMain.handle(desktopIpc.getChangedFiles, async (event, rawWorkspaceId: unknown) => {
    windows.windowForSender(event.sender);
    const workspacePath = workspace.getWorkspacePath(
      expectNonEmptyString(rawWorkspaceId, "workspaceId"),
    );
    if (!workspacePath) {
      return {
        state: "unavailable",
        error: {
          code: "workspace-unavailable",
          message: "Changed files are unavailable because this workspace could not be found.",
        },
      } satisfies ChangedFilesResult;
    }
    return capabilities.getChangedFiles(workspacePath);
  });
  ipcMain.handle(
    desktopIpc.getFileDiff,
    async (event, rawWorkspaceId: unknown, rawFilePath: unknown) => {
      windows.windowForSender(event.sender);
      const workspacePath = workspace.getWorkspacePath(
        expectNonEmptyString(rawWorkspaceId, "workspaceId"),
      );
      return workspacePath
        ? capabilities.getFileDiff(workspacePath, expectString(rawFilePath, "filePath"))
        : "";
    },
  );
  ipcMain.handle(
    desktopIpc.stageFile,
    async (event, rawWorkspaceId: unknown, rawFilePath: unknown, rawStagingSourcePath: unknown) => {
      windows.windowForSender(event.sender);
      const workspaceId = expectNonEmptyString(rawWorkspaceId, "workspaceId");
      const workspacePath = workspace.getWorkspacePath(workspaceId);
      if (!workspacePath) {
        throw new Error(`Unknown workspace: ${workspaceId}`);
      }
      await capabilities.stageFile(workspacePath, expectString(rawFilePath, "filePath"), {
        sourcePath: expectOptionalString(rawStagingSourcePath, "stagingSourcePath"),
      });
    },
  );
}

async function openOwnedFileInFinder(
  resolvedPath: string | undefined,
  requestedPath: string,
  kind: "skill" | "extension",
): Promise<void> {
  if (!resolvedPath) {
    throw new Error(`Unknown ${kind}: ${requestedPath}`);
  }
  await shell.openPath(path.dirname(resolvedPath));
}
