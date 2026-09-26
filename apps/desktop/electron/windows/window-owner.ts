import { BrowserWindow, type WebContents } from "electron";
import type { SessionRef } from "@pi-gui/session-driver";
import type {
  AppView,
  DesktopAppState,
  DesktopAppViewState,
  SelectedTranscriptRecord,
} from "../../contracts/desktop-state";
import { desktopIpc } from "../../contracts/ipc";
import { SerializedActionQueue } from "./action-queue";

interface WindowViewState {
  readonly selectedWorkspaceId: string;
  readonly selectedSessionId: string;
  readonly activeView: AppView;
  readonly sidebarCollapsed: boolean;
}

export interface WindowStateOwner {
  snapshot(): DesktopAppState;
  applyView(view: DesktopAppViewState): DesktopAppState;
  projectStateForView(
    view: DesktopAppViewState,
    state: DesktopAppState,
    previousView?: DesktopAppViewState,
  ): DesktopAppState;
  getState(): Promise<DesktopAppState>;
  getStateForView(view: DesktopAppViewState): Promise<DesktopAppState>;
  getSelectedTranscriptForView(view: DesktopAppViewState): Promise<SelectedTranscriptRecord | null>;
  subscribe(listener: (state: DesktopAppState) => void): () => void;
  subscribeToSelectedTranscript(listener: () => void): () => void;
  emit(): void;
  handleWindowActivation(): void;
}

export interface WindowOwnerOptions {
  readonly onActiveWindowChanged?: (window: BrowserWindow | null) => void;
  readonly onWindowClosed?: (window: BrowserWindow) => void;
}

export interface WindowActionOptions {
  readonly forceActiveWindow?: boolean;
}

function viewFromState(state: DesktopAppState): WindowViewState {
  return {
    selectedWorkspaceId: state.selectedWorkspaceId,
    selectedSessionId: state.selectedSessionId,
    activeView: state.activeView,
    sidebarCollapsed: state.sidebarCollapsed,
  };
}

function canPublishToWindow(window: BrowserWindow): boolean {
  return (
    !window.isDestroyed() && !window.webContents.isDestroyed() && !window.webContents.isCrashed()
  );
}

export class WindowOwner {
  private readonly lastPublishedTranscript = new Map<number, SelectedTranscriptRecord | null>();
  private readonly windows = new Set<BrowserWindow>();
  private readonly windowIds = new WeakMap<BrowserWindow, number>();
  private readonly views = new Map<number, WindowViewState>();
  private readonly stopPublishingState = new Map<number, () => void>();
  private readonly stopPublishingTranscript = new Map<number, () => void>();
  private readonly stopTrackingActivation = new Map<number, () => void>();
  private readonly actionQueue = new SerializedActionQueue();
  private activeWindow: BrowserWindow | null = null;
  private activeActionWebContentsId: number | undefined;
  private deferredActivationWebContentsId: number | undefined;
  private composerDraftPersistOriginWebContentsId: number | undefined;

  constructor(
    private readonly stateOwner: WindowStateOwner,
    private readonly options: WindowOwnerOptions = {},
  ) {}

  add(window: BrowserWindow, sourceView?: DesktopAppViewState): void {
    const webContentsId = window.webContents.id;
    this.windows.add(window);
    this.windowIds.set(window, webContentsId);
    this.views.set(webContentsId, this.resolveView(sourceView));
    this.setActiveWindow(window);
    this.attachStatePublisher(window);
    this.attachActivationTracking(window);
  }

  remove(window: BrowserWindow): void {
    const webContentsId = this.windowIds.get(window);
    if (webContentsId === undefined) {
      return;
    }
    this.stopPublishingState.get(webContentsId)?.();
    this.stopPublishingState.delete(webContentsId);
    this.stopPublishingTranscript.get(webContentsId)?.();
    this.stopPublishingTranscript.delete(webContentsId);
    this.stopTrackingActivation.get(webContentsId)?.();
    this.stopTrackingActivation.delete(webContentsId);
    this.windows.delete(window);
    this.windowIds.delete(window);
    this.views.delete(webContentsId);
    this.lastPublishedTranscript.delete(webContentsId);

    if (this.activeWindow === window) {
      this.activeWindow = [...this.windows].find((candidate) => !candidate.isDestroyed()) ?? null;
      if (this.activeWindow) {
        this.setActiveWindow(this.activeWindow);
        this.applyViewToStateOwner(this.activeWindow.webContents.id);
      } else {
        this.options.onActiveWindowChanged?.(null);
      }
    }
    this.options.onWindowClosed?.(window);
  }

  allWindows(): readonly BrowserWindow[] {
    return [...this.windows];
  }

  size(): number {
    return this.windows.size;
  }

  active(): BrowserWindow | null {
    return this.activeWindow && canPublishToWindow(this.activeWindow) ? this.activeWindow : null;
  }

  foreground(): BrowserWindow | null {
    const focusedWindow = BrowserWindow.getFocusedWindow();
    if (
      focusedWindow &&
      this.views.has(focusedWindow.webContents.id) &&
      canPublishToWindow(focusedWindow)
    ) {
      return focusedWindow;
    }
    if (this.activeWindow && canPublishToWindow(this.activeWindow)) {
      return this.activeWindow;
    }
    return [...this.windows].find(canPublishToWindow) ?? null;
  }

  foregroundView(): DesktopAppViewState | undefined {
    const window = this.foreground();
    return window ? this.viewForWindow(window) : undefined;
  }

  resolveDialogWindow(parentWindow?: BrowserWindow | null): BrowserWindow | undefined {
    if (parentWindow && canPublishToWindow(parentWindow)) {
      return parentWindow;
    }
    return this.active() ?? undefined;
  }

  windowForSender(sender: WebContents): BrowserWindow {
    const window = BrowserWindow.fromWebContents(sender);
    if (!window || !this.windows.has(window) || !canPublishToWindow(window)) {
      throw new Error("IPC sender is not an active pi-gui window");
    }
    return window;
  }

  viewForSender(sender: WebContents): DesktopAppViewState {
    const window = this.windowForSender(sender);
    return this.viewForWindow(window);
  }

  viewForWindow(window: BrowserWindow): DesktopAppViewState {
    return this.views.get(window.webContents.id) ?? viewFromState(this.stateOwner.snapshot());
  }

  targetForSender(sender: WebContents): SessionRef | undefined {
    const view = this.viewForSender(sender);
    return view.selectedWorkspaceId && view.selectedSessionId
      ? { workspaceId: view.selectedWorkspaceId, sessionId: view.selectedSessionId }
      : undefined;
  }

  async stateForWindow(window?: BrowserWindow | null): Promise<DesktopAppState> {
    if (window && canPublishToWindow(window)) {
      return this.stateOwner.getStateForView(this.viewForWindow(window));
    }
    return this.stateOwner.getState();
  }

  isSessionVisibleInAnotherWindow(sessionRef: SessionRef): boolean {
    for (const window of this.windows) {
      if (!canPublishToWindow(window) || window.isMinimized() || !window.isVisible()) {
        continue;
      }
      const webContentsId = window.webContents.id;
      if (webContentsId === this.activeActionWebContentsId) {
        continue;
      }
      const view = this.views.get(webContentsId);
      if (
        view?.activeView === "threads" &&
        view.selectedWorkspaceId === sessionRef.workspaceId &&
        view.selectedSessionId === sessionRef.sessionId
      ) {
        return true;
      }
    }
    return false;
  }

  activate(window: BrowserWindow): void {
    if (!this.windows.has(window) || window.isDestroyed()) {
      return;
    }
    if (this.activeActionWebContentsId !== undefined) {
      this.deferredActivationWebContentsId = window.webContents.id;
      return;
    }
    this.applyActivation(window);
  }

  async runStateAction(
    window: BrowserWindow | null | undefined,
    action: () => Promise<DesktopAppState>,
    options: WindowActionOptions = {},
  ): Promise<DesktopAppState> {
    return this.enqueueAction(async () => {
      const context = this.beginAction(window, options);
      try {
        const state = await action();
        if (!context.window || context.webContentsId === undefined) {
          return state;
        }
        return this.finishStateAction(context.window, state);
      } finally {
        this.endAction(context.webContentsId, context.previousActionWebContentsId);
      }
    });
  }

  async runStateResultAction<T extends { readonly state: DesktopAppState }>(
    window: BrowserWindow | null | undefined,
    action: () => Promise<T>,
    options: WindowActionOptions = {},
  ): Promise<T> {
    return this.enqueueAction(async () => {
      const context = this.beginAction(window, options);
      try {
        const result = await action();
        if (!context.window || context.webContentsId === undefined) {
          return result;
        }
        const state = this.finishStateAction(context.window, result.state);
        return { ...result, state };
      } finally {
        this.endAction(context.webContentsId, context.previousActionWebContentsId);
      }
    });
  }

  async runUnscopedStateAction(
    window: BrowserWindow | null | undefined,
    action: () => Promise<DesktopAppState>,
  ): Promise<DesktopAppState> {
    const state = await action();
    if (!window || !canPublishToWindow(window)) {
      return state;
    }
    return this.projectAndRemember(window.webContents.id, state);
  }

  async runImmediateStateAction(
    window: BrowserWindow | null | undefined,
    action: () => Promise<DesktopAppState>,
  ): Promise<DesktopAppState> {
    const state = await action();
    if (!window || !canPublishToWindow(window)) {
      return state;
    }
    const projected = this.projectAndRemember(window.webContents.id, state);
    window.webContents.send(desktopIpc.stateChanged, projected);
    this.publishTranscriptSoon(window);
    return projected;
  }

  async withComposerDraftPersistOrigin<T>(
    sender: WebContents,
    action: () => Promise<T>,
  ): Promise<T> {
    const previousOrigin = this.composerDraftPersistOriginWebContentsId;
    this.composerDraftPersistOriginWebContentsId = this.windowForSender(sender).webContents.id;
    try {
      return await action();
    } finally {
      this.composerDraftPersistOriginWebContentsId = previousOrigin;
    }
  }

  private resolveView(sourceView?: DesktopAppViewState): WindowViewState {
    const state = this.stateOwner.snapshot();
    return viewFromState(
      this.stateOwner.projectStateForView({ ...viewFromState(state), ...sourceView }, state),
    );
  }

  private projectState(
    webContentsId: number,
    state: DesktopAppState = this.stateOwner.snapshot(),
    view: WindowViewState = this.views.get(webContentsId) ?? viewFromState(state),
    previousView: WindowViewState | undefined = this.views.get(webContentsId),
  ): DesktopAppState {
    const projected = this.stateOwner.projectStateForView(view, state, previousView);
    if (
      projected.composerDraftSyncSource === "persist" &&
      this.composerDraftPersistOriginWebContentsId !== undefined &&
      webContentsId !== this.composerDraftPersistOriginWebContentsId
    ) {
      return { ...projected, composerDraftSyncSource: "remote-persist" };
    }
    return projected;
  }

  private projectAndRemember(webContentsId: number, state: DesktopAppState): DesktopAppState {
    const projected = this.projectState(webContentsId, state);
    this.views.set(webContentsId, viewFromState(projected));
    return projected;
  }

  private publishState(
    window: BrowserWindow,
    state: DesktopAppState = this.stateOwner.snapshot(),
  ): void {
    if (!canPublishToWindow(window)) {
      return;
    }
    const webContentsId = window.webContents.id;
    const view =
      webContentsId === this.activeActionWebContentsId
        ? viewFromState(state)
        : (this.views.get(webContentsId) ?? viewFromState(state));
    const projected = this.projectState(webContentsId, state, view);
    this.views.set(webContentsId, viewFromState(projected));
    window.webContents.send(desktopIpc.stateChanged, projected);
  }

  private async publishTranscript(window: BrowserWindow): Promise<void> {
    if (!canPublishToWindow(window)) {
      return;
    }
    const webContentsId = window.webContents.id;
    const payload = await this.stateOwner.getSelectedTranscriptForView(this.viewForWindow(window));
    if (!canPublishToWindow(window)) {
      return;
    }
    const projected = this.projectState(webContentsId);
    if (payload) {
      if (
        projected.selectedWorkspaceId !== payload.workspaceId ||
        projected.selectedSessionId !== payload.sessionId
      ) {
        return;
      }
    } else if (projected.selectedSessionId) {
      return;
    }
    // Transcript arrays are replaced on writes, so identity detects changes
    // without serializing unchanged transcripts for unrelated session events.
    const previous = this.lastPublishedTranscript.get(webContentsId);
    if (payload) {
      if (
        previous &&
        previous.workspaceId === payload.workspaceId &&
        previous.sessionId === payload.sessionId &&
        previous.transcript === payload.transcript &&
        previous.schemaInfo === payload.schemaInfo
      ) {
        return;
      }
    } else if (previous === null) {
      return;
    }
    this.lastPublishedTranscript.set(webContentsId, payload);
    window.webContents.send(desktopIpc.selectedTranscriptChanged, payload);
  }

  private publishTranscriptSoon(window: BrowserWindow): void {
    void this.publishTranscript(window).catch((error: unknown) => {
      console.error("[window-owner] failed to publish selected transcript", error);
    });
  }

  private setActiveWindow(window: BrowserWindow): void {
    if (window.isDestroyed()) {
      return;
    }
    this.activeWindow = window;
    this.options.onActiveWindowChanged?.(window);
  }

  private applyViewToStateOwner(webContentsId: number): void {
    const view = this.views.get(webContentsId) ?? viewFromState(this.stateOwner.snapshot());
    this.stateOwner.applyView(view);
  }

  private applyActivation(window: BrowserWindow): void {
    this.setActiveWindow(window);
    this.applyViewToStateOwner(window.webContents.id);
    this.stateOwner.handleWindowActivation();
    this.views.set(window.webContents.id, viewFromState(this.stateOwner.snapshot()));
  }

  private applyDeferredActivation(): boolean {
    const webContentsId = this.deferredActivationWebContentsId;
    this.deferredActivationWebContentsId = undefined;
    if (webContentsId === undefined) {
      return false;
    }
    const window = [...this.windows].find(
      (candidate) => !candidate.isDestroyed() && candidate.webContents.id === webContentsId,
    );
    if (!window || !canPublishToWindow(window)) {
      return false;
    }
    this.applyActivation(window);
    return true;
  }

  private restoreForegroundUnlessSender(senderWebContentsId: number | undefined): void {
    const foregroundWindow = this.foreground();
    if (!foregroundWindow || foregroundWindow.webContents.id === senderWebContentsId) {
      return;
    }
    this.applyViewToStateOwner(foregroundWindow.webContents.id);
    this.stateOwner.emit();
  }

  private enqueueAction<T>(action: () => Promise<T>): Promise<T> {
    return this.actionQueue.run(action);
  }

  private beginAction(window: BrowserWindow | null | undefined, options: WindowActionOptions) {
    const liveWindow = window && !window.isDestroyed() ? window : undefined;
    const webContentsId = liveWindow?.webContents.id;
    const foregroundWindow = this.foreground();
    const senderIsForeground = Boolean(
      liveWindow && foregroundWindow?.webContents.id === liveWindow.webContents.id,
    );
    const windowIsFocused =
      Boolean(liveWindow?.isFocused()) || senderIsForeground || options.forceActiveWindow === true;
    if (liveWindow && webContentsId !== undefined) {
      if (windowIsFocused) {
        this.setActiveWindow(liveWindow);
      }
      this.applyViewToStateOwner(webContentsId);
    }
    const previousActionWebContentsId = this.activeActionWebContentsId;
    this.activeActionWebContentsId = webContentsId;
    return { window: liveWindow, webContentsId, previousActionWebContentsId };
  }

  private finishStateAction(window: BrowserWindow, state: DesktopAppState): DesktopAppState {
    const webContentsId = window.webContents.id;
    const previousView = this.views.get(webContentsId);
    const projected = this.projectState(webContentsId, state, viewFromState(state), previousView);
    this.views.set(webContentsId, viewFromState(projected));
    this.publishState(window, projected);
    this.publishTranscriptSoon(window);
    return projected;
  }

  private endAction(
    senderWebContentsId: number | undefined,
    previousActionWebContentsId: number | undefined,
  ): void {
    this.activeActionWebContentsId = previousActionWebContentsId;
    if (!this.applyDeferredActivation()) {
      this.restoreForegroundUnlessSender(senderWebContentsId);
    }
  }

  private attachStatePublisher(window: BrowserWindow): void {
    const webContentsId = window.webContents.id;
    const startPublishing = () => {
      this.lastPublishedTranscript.delete(webContentsId);
      this.stopPublishingState.get(webContentsId)?.();
      this.stopPublishingTranscript.get(webContentsId)?.();
      this.stopPublishingState.set(
        webContentsId,
        this.stateOwner.subscribe((state) => {
          this.publishState(window, state);
          this.publishTranscriptSoon(window);
        }),
      );
      this.stopPublishingTranscript.set(
        webContentsId,
        this.stateOwner.subscribeToSelectedTranscript(() => this.publishTranscriptSoon(window)),
      );
    };
    const stopPublishing = () => {
      this.stopPublishingState.get(webContentsId)?.();
      this.stopPublishingState.delete(webContentsId);
      this.stopPublishingTranscript.get(webContentsId)?.();
      this.stopPublishingTranscript.delete(webContentsId);
    };

    startPublishing();
    let recovering = false;
    window.webContents.on("render-process-gone", () => {
      recovering = true;
      stopPublishing();
    });
    window.webContents.on("did-finish-load", () => {
      if (!recovering) {
        return;
      }
      recovering = false;
      startPublishing();
      this.publishState(window);
      this.publishTranscriptSoon(window);
    });
  }

  private attachActivationTracking(window: BrowserWindow): void {
    const webContentsId = window.webContents.id;
    this.stopTrackingActivation.get(webContentsId)?.();
    const handleActivation = () => this.activate(window);
    const notifyFocused = () => {
      if (!window.isDestroyed()) window.webContents.send(desktopIpc.windowFocused);
    };
    const stop = () => {
      window.off("focus", notifyFocused);
      window.off("focus", handleActivation);
      window.off("show", handleActivation);
      window.off("restore", handleActivation);
    };
    window.on("focus", handleActivation);
    window.on("focus", notifyFocused);
    window.on("show", handleActivation);
    window.on("restore", handleActivation);
    this.stopTrackingActivation.set(webContentsId, stop);
  }
}
