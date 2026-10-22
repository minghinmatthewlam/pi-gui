import {
  createDesktopCommandSubscription,
  desktopIpc,
  type PiDesktopApi,
  type PiDesktopCommand,
} from "../../contracts/ipc";

/**
 * `window.piApp` over the Rust kernel, for the shells that are not Electron: the test host's
 * WebSocket and Tauri. Each call goes to the kernel by its API name, and pushes arrive by
 * their `desktopIpc` channel. The transport only moves calls and pushes.
 */

export interface PiAppTransport {
  /** A call the renderer awaits. */
  request(method: string, args: readonly unknown[]): Promise<unknown>;
  /** A fire-and-forget send (`ipcRenderer.send`). */
  send(method: string, args: readonly unknown[]): void;
}

/** What the kernel answers a call with, on both transports. */
export interface KernelAnswer {
  readonly result?: unknown;
  readonly channel?: string;
  readonly error?: { readonly name?: string; readonly message?: string };
}

/** The value a call resolves with, or the error Electron's `ipcRenderer.invoke` rejects with. */
export function settleKernelAnswer(answer: KernelAnswer): unknown {
  if (answer.error) {
    const name = answer.error.name ?? "Error";
    throw new Error(
      `Error invoking remote method '${answer.channel ?? ""}': ${name}: ${answer.error.message ?? ""}`,
    );
  }
  return answer.result;
}

/** Arguments as JSON, with the indexes that were `undefined` so the kernel can tell them apart. */
export function encodeKernelArgs(args: readonly unknown[]): {
  readonly args: unknown[];
  readonly undefinedAt?: number[];
} {
  const undefinedAt = args.flatMap((arg, index) => (arg === undefined ? [index] : []));
  return {
    args: args.map((arg) => (arg === undefined ? null : arg)),
    ...(undefinedAt.length > 0 ? { undefinedAt } : {}),
  };
}

export interface PiAppBridge {
  readonly api: PiDesktopApi;
  /** Hands one push to its listeners. */
  deliver(channel: string, payload: unknown): void;
}

type Listener = (payload: never) => void;

export function createPiAppBridge(
  transport: PiAppTransport,
  options: {
    readonly platform: NodeJS.Platform;
    readonly versions?: Record<string, string>;
    readonly getPathForFile?: (file: File) => string;
  },
): PiAppBridge {
  const listeners = new Map<string, Set<Listener>>();
  const draftFlushHandlers = new Set<() => Promise<void>>();
  const appCommands = createDesktopCommandSubscription();

  const subscribe =
    <T>(channel: string) =>
    (listener: (payload: T) => void): (() => void) => {
      const set = listeners.get(channel) ?? new Set<Listener>();
      listeners.set(channel, set);
      set.add(listener as Listener);
      return () => {
        set.delete(listener as Listener);
      };
    };

  const invoke =
    (method: string) =>
    (...args: unknown[]): Promise<never> =>
      transport.request(method, args) as Promise<never>;

  const send =
    (method: string) =>
    (...args: unknown[]): Promise<void> => {
      transport.send(method, args);
      return Promise.resolve();
    };

  const deliver = (channel: string, payload: unknown): void => {
    if (channel === desktopIpc.flushPendingComposerDraft) {
      // Always acknowledge, even with no handler, so the kernel never waits out its bound.
      void Promise.allSettled([...draftFlushHandlers].map((handler) => handler()))
        .then(() => transport.request("pendingComposerDraftFlushed", [payload]))
        .catch((error: unknown) => {
          console.error("[piApp] pending draft flush acknowledgement failed", error);
        });
      return;
    }
    if (channel === desktopIpc.appCommand) {
      appCommands.deliver(payload as PiDesktopCommand);
      return;
    }
    for (const listener of [...(listeners.get(channel) ?? [])]) {
      (listener as (value: unknown) => void)(payload);
    }
  };

  const api = {
    platform: options.platform,
    versions: (options.versions ?? {}) as NodeJS.ProcessVersions,
    ping: invoke("ping"),
    getState: invoke("getState"),
    getTaskWorkbenchTemplate: invoke("getTaskWorkbenchTemplate"),
    saveTaskWorkbenchTemplate: invoke("saveTaskWorkbenchTemplate"),
    listExtensionViews: invoke("listExtensionViews"),
    openExtensionView: invoke("openExtensionView"),
    sendExtensionViewMessage: invoke("sendExtensionViewMessage"),
    closeExtensionView: invoke("closeExtensionView"),
    onExtensionViewMessage: subscribe(desktopIpc.extensionViewMessage),
    onExtensionViewCatalogChanged: subscribe(desktopIpc.extensionViewCatalogChanged),
    onExtensionViewOpenFile: subscribe(desktopIpc.extensionViewOpenFile),
    runExtensionAction: invoke("runExtensionAction"),
    getTurnChanges: invoke("getTurnChanges"),
    getReview: invoke("getReview"),
    getReviewFile: invoke("getReviewFile"),
    setReviewFileReviewed: invoke("setReviewFileReviewed"),
    changeReviewFileStage: invoke("changeReviewFileStage"),
    onStateChanged: subscribe(desktopIpc.stateChanged),
    getSelectedTranscript: invoke("getSelectedTranscript"),
    onSelectedTranscriptChanged: subscribe(desktopIpc.selectedTranscriptChanged),
    onCommand: (listener) => appCommands.subscribe(listener),
    onWorkspacePicked: subscribe(desktopIpc.workspacePicked),
    onClipboardImagePasted: subscribe(desktopIpc.clipboardImagePasted),
    // Without a shell that knows paths, Electron's webUtils answers "" the same way.
    getPathForFile: options.getPathForFile ?? (() => ""),
    addWorkspacePath: invoke("addWorkspacePath"),
    pickWorkspace: invoke("pickWorkspace"),
    selectWorkspace: invoke("selectWorkspace"),
    renameWorkspace: invoke("renameWorkspace"),
    removeWorkspace: invoke("removeWorkspace"),
    reorderWorkspaces: invoke("reorderWorkspaces"),
    reorderPinnedSessions: invoke("reorderPinnedSessions"),
    openWorkspaceInFinder: invoke("openWorkspaceInFinder"),
    createWorktree: invoke("createWorktree"),
    removeWorktree: invoke("removeWorktree"),
    openSkillInFinder: invoke("openSkillInFinder"),
    openExtensionInFinder: invoke("openExtensionInFinder"),
    syncCurrentWorkspace: invoke("syncCurrentWorkspace"),
    selectSession: invoke("selectSession"),
    renameSession: invoke("renameSession"),
    archiveSession: invoke("archiveSession"),
    unarchiveSession: invoke("unarchiveSession"),
    markSessionRead: invoke("markSessionRead"),
    setSessionPinned: invoke("setSessionPinned"),
    createSession: invoke("createSession"),
    startThread: invoke("startThread"),
    forkThread: invoke("forkThread"),
    sendChildThreadFollowUp: invoke("sendChildThreadFollowUp"),
    setChildSupervisionLoop: invoke("setChildSupervisionLoop"),
    createScheduledTask: invoke("createScheduledTask"),
    updateScheduledTask: invoke("updateScheduledTask"),
    deleteScheduledTask: invoke("deleteScheduledTask"),
    beginScheduledTaskInterview: invoke("beginScheduledTaskInterview"),
    cancelCurrentRun: invoke("cancelCurrentRun"),
    setActiveView: invoke("setActiveView"),
    setSidebarCollapsed: invoke("setSidebarCollapsed"),
    setThreadGrouping: invoke("setThreadGrouping"),
    setWorkspaceCollapsed: invoke("setWorkspaceCollapsed"),
    refreshRuntime: invoke("refreshRuntime"),
    setModelSettingsScopeMode: invoke("setModelSettingsScopeMode"),
    setDefaultModel: invoke("setDefaultModel"),
    setDefaultThinkingLevel: invoke("setDefaultThinkingLevel"),
    setSessionModel: invoke("setSessionModel"),
    setSessionThinkingLevel: invoke("setSessionThinkingLevel"),
    loginProvider: invoke("loginProvider"),
    logoutProvider: invoke("logoutProvider"),
    setProviderApiKey: invoke("setProviderApiKey"),
    listCustomProviders: invoke("listCustomProviders"),
    setCustomProvider: invoke("setCustomProvider"),
    deleteCustomProvider: invoke("deleteCustomProvider"),
    probeCustomProviderModels: invoke("probeCustomProviderModels"),
    setEnableSkillCommands: invoke("setEnableSkillCommands"),
    setScopedModelPatterns: invoke("setScopedModelPatterns"),
    setSkillEnabled: invoke("setSkillEnabled"),
    setExtensionEnabled: invoke("setExtensionEnabled"),
    listMcpServers: invoke("listMcpServers"),
    addMcpServer: invoke("addMcpServer"),
    removeMcpServer: invoke("removeMcpServer"),
    setMcpServerEnabled: invoke("setMcpServerEnabled"),
    setCodemodeAlwaysOn: invoke("setCodemodeAlwaysOn"),
    respondToHostUiRequest: invoke("respondToHostUiRequest"),
    setNotificationPreferences: invoke("setNotificationPreferences"),
    setIntegratedTerminalShell: invoke("setIntegratedTerminalShell"),
    setEnableTransparency: invoke("setEnableTransparency"),
    setThemePresetId: invoke("setThemePresetId"),
    ensureTerminalPanel: invoke("ensureTerminalPanel"),
    createTerminalSession: invoke("createTerminalSession"),
    setActiveTerminalSession: invoke("setActiveTerminalSession"),
    writeTerminal: invoke("writeTerminal"),
    resizeTerminal: invoke("resizeTerminal"),
    restartTerminalSession: invoke("restartTerminalSession"),
    closeTerminalSession: invoke("closeTerminalSession"),
    setTerminalTitle: invoke("setTerminalTitle"),
    setTerminalFocused: send("setTerminalFocused"),
    setSidePanelFocused: send("setSidePanelFocused"),
    onTerminalData: subscribe(desktopIpc.terminalData),
    onTerminalExit: subscribe(desktopIpc.terminalExit),
    onTerminalError: subscribe(desktopIpc.terminalError),
    getNotificationPermissionStatus: invoke("getNotificationPermissionStatus"),
    requestNotificationPermission: invoke("requestNotificationPermission"),
    openSystemNotificationSettings: invoke("openSystemNotificationSettings"),
    onNotificationPermissionStatusChanged: subscribe(
      desktopIpc.notificationPermissionStatusChanged,
    ),
    pickComposerAttachments: invoke("pickComposerAttachments"),
    readClipboardImage: invoke("readClipboardImage"),
    addComposerAttachments: invoke("addComposerAttachments"),
    removeComposerAttachment: invoke("removeComposerAttachment"),
    editQueuedComposerMessage: invoke("editQueuedComposerMessage"),
    cancelQueuedComposerEdit: invoke("cancelQueuedComposerEdit"),
    removeQueuedComposerMessage: invoke("removeQueuedComposerMessage"),
    steerQueuedComposerMessage: invoke("steerQueuedComposerMessage"),
    persistComposerDraft: invoke("persistComposerDraft"),
    updateComposerDraft: invoke("updateComposerDraft"),
    onPendingComposerDraftFlush: (handler) => {
      draftFlushHandlers.add(handler);
      return () => {
        draftFlushHandlers.delete(handler);
      };
    },
    submitComposer: invoke("submitComposer"),
    getSessionTree: invoke("getSessionTree"),
    navigateSessionTree: invoke("navigateSessionTree"),
    listWorkspaceFiles: invoke("listWorkspaceFiles"),
    readWorkspaceFile: invoke("readWorkspaceFile"),
    revealWorkspaceFile: invoke("revealWorkspaceFile"),
    getChangedFiles: invoke("getChangedFiles"),
    getFileDiff: invoke("getFileDiff"),
    stageFile: invoke("stageFile"),
    toggleWindowMaximize: invoke("toggleWindowMaximize"),
    openExternal: invoke("openExternal"),
    getThemeMode: invoke("getThemeMode"),
    getResolvedTheme: invoke("getResolvedTheme"),
    setThemeMode: invoke("setThemeMode"),
    onWindowFocused: subscribe(desktopIpc.windowFocused),
    onThemeChanged: subscribe(desktopIpc.themeChanged),
    relaunchApplication: invoke("relaunchApplication"),
  } satisfies PiDesktopApi;

  return { api, deliver };
}
