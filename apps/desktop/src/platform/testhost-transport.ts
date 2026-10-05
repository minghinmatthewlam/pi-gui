import {
  createDesktopCommandSubscription,
  desktopIpc,
  type PiDesktopApi,
  type PiDesktopCommand,
} from "../../contracts/ipc";
import type { ClipboardImageRead } from "../../contracts/composer-attachments";

/**
 * `window.piApp` over the Rust test host's WebSocket, for a page opened with
 * `?testhost=ws://…`. It stands in for the Electron preload: each call goes to the kernel by
 * its API name, and pushes arrive by their `desktopIpc` channel.
 */

const WINDOW_ID_KEY = "pi-gui:testhost-window";

interface WireError {
  readonly name?: string;
  readonly message?: string;
  readonly data?: Record<string, unknown>;
}

interface WireMessage {
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: WireError;
  readonly channel?: string;
  readonly push?: string;
  readonly payload?: unknown;
  readonly hello?: { readonly window: number | null; readonly platform: string };
}

type Pending = { resolve(value: unknown): void; reject(error: Error): void };
type Listener = (payload: never) => void;

export function testHostUrl(search: string = window.location.search): string | undefined {
  const url = new URLSearchParams(search).get("testhost");
  return url && /^wss?:\/\//.test(url) ? url : undefined;
}

function readStoredWindowId(): number | undefined {
  try {
    const stored = Number(window.sessionStorage.getItem(WINDOW_ID_KEY));
    return Number.isSafeInteger(stored) && stored > 0 ? stored : undefined;
  } catch {
    return undefined;
  }
}

function storeWindowId(id: number): void {
  try {
    window.sessionStorage.setItem(WINDOW_ID_KEY, String(id));
  } catch {
    // A page without storage starts a new window on reload.
  }
}

/** Connects, then installs `window.piApp`. Resolves once the host has named this window. */
export function installTestHostTransport(url: string): Promise<void> {
  const socket = new WebSocket(url);
  const pending = new Map<number, Pending>();
  const listeners = new Map<string, Set<Listener>>();
  const draftFlushHandlers = new Set<() => Promise<void>>();
  const appCommands = createDesktopCommandSubscription();
  let nextId = 0;

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

  const encode = (method: string, args: readonly unknown[], id?: number): string => {
    const undefinedAt = args.flatMap((arg, index) => (arg === undefined ? [index] : []));
    return JSON.stringify({
      ...(id === undefined ? {} : { id }),
      method,
      args: args.map((arg) => (arg === undefined ? null : arg)),
      ...(undefinedAt.length > 0 ? { undefinedAt } : {}),
    });
  };

  const request = (method: string, args: readonly unknown[]): Promise<never> =>
    new Promise<never>((resolve, reject) => {
      nextId += 1;
      pending.set(nextId, { resolve: resolve as (value: unknown) => void, reject });
      socket.send(encode(method, args, nextId));
    });

  const invoke =
    (method: string) =>
    (...args: unknown[]): Promise<never> =>
      request(method, args);

  const send =
    (method: string) =>
    (...args: unknown[]): Promise<void> => {
      socket.send(encode(method, args));
      return Promise.resolve();
    };

  const deliver = (channel: string, payload: unknown): void => {
    if (channel === desktopIpc.flushPendingComposerDraft) {
      // Always acknowledge, even with no handler, so the kernel never waits out its bound.
      void Promise.allSettled([...draftFlushHandlers].map((handler) => handler()))
        .then(() => request("pendingComposerDraftFlushed", [payload]))
        .catch((error: unknown) => {
          console.error("[testhost] pending draft flush acknowledgement failed", error);
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

  return new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ hello: { role: "window", window: readStoredWindowId() } }));
    });
    socket.addEventListener("error", () => reject(new Error(`Could not reach ${url}`)));
    socket.addEventListener("close", () => {
      for (const entry of pending.values()) {
        entry.reject(new Error("The test host closed the connection"));
      }
      pending.clear();
    });
    socket.addEventListener("message", (event: MessageEvent<string>) => {
      const message = JSON.parse(event.data) as WireMessage;
      if (message.hello) {
        if (message.hello.window !== null) storeWindowId(message.hello.window);
        window.piApp = createApi(message.hello.platform as NodeJS.Platform);
        resolve();
        return;
      }
      if (message.push !== undefined) {
        deliver(message.push, message.payload);
        return;
      }
      if (message.id === undefined) return;
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error) {
        // The message Electron's ipcRenderer.invoke rejects with.
        const name = message.error.name ?? "Error";
        const error = new Error(
          `Error invoking remote method '${message.channel ?? ""}': ${name}: ${message.error.message ?? ""}`,
        );
        entry.reject(error);
        return;
      }
      entry.resolve(message.result);
    });
  });

  function createApi(platform: NodeJS.Platform): PiDesktopApi {
    return {
      platform,
      versions: {} as NodeJS.ProcessVersions,
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
      // A browser page has no file paths; Electron's webUtils answers "" the same way.
      getPathForFile: () => "",
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
      // A synchronous call cannot cross the socket; the test host has no clipboard image.
      readClipboardImage: (): ClipboardImageRead => ({ ok: false }),
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
  }
}
