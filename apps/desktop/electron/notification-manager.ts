import { Notification, type BrowserWindow } from "electron";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { DesktopAppStore } from "./app-store";
import type { DesktopAppState } from "../src/desktop-state";
import { sessionKey } from "@pi-gui/pi-sdk-driver";
import type { SessionDriverEvent, SessionRef } from "@pi-gui/session-driver";
import { getSelectedSession } from "../src/desktop-state";
import { ensureNotificationPermission } from "./notification-permission";
import { isSessionActivelyViewed } from "./session-visibility";

export class NotificationManager {
  private readonly completedRunKeys = new Set<string>();
  private readonly activeBySession = new Map<string, Electron.Notification>();
  private latestState: DesktopAppState | undefined;
  private trackedWindow: BrowserWindow | null = null;
  private stopTrackingWindow: (() => void) | undefined;
  private lastActivelyViewedSession: SessionRef | undefined;
  private backgroundCandidateSessions: SessionRef[] = [];
  private permissionRequestPending = false;

  constructor(
    private readonly store: DesktopAppStore,
    private readonly getWindow: () => BrowserWindow | null,
  ) {}

  start(): () => void {
    const stopState = this.store.subscribe((state) => {
      this.latestState = state;
      const selectedSession = getSelectedSession(state);
      const window = this.getWindow();
      if (
        selectedSession &&
        isSessionActivelyViewed(
          state,
          {
            workspaceId: state.selectedWorkspaceId,
            sessionId: state.selectedSessionId,
          },
          window,
        )
      ) {
        this.dismissForSession({
          workspaceId: state.selectedWorkspaceId,
          sessionId: state.selectedSessionId,
        });
      }
      void this.reevaluateOnboardingState();
    });
    const stopEvents = this.store.subscribeToSessionEvents((event, state) => {
      this.latestState = state;
      void this.reevaluateOnboardingState();
      void this.handleEvent(event);
    });
    return () => {
      stopState();
      stopEvents();
      this.trackWindow(null);
    };
  }

  trackWindow(window: BrowserWindow | null): void {
    if (window === this.trackedWindow) {
      return;
    }

    this.stopTrackingWindow?.();
    this.stopTrackingWindow = undefined;
    if (!window) {
      this.trackedWindow = null;
      this.lastActivelyViewedSession = undefined;
      this.backgroundCandidateSessions = [];
      return;
    }

    this.trackedWindow = window && !window.isDestroyed() ? window : null;
    if (!this.trackedWindow) {
      this.lastActivelyViewedSession = undefined;
      this.backgroundCandidateSessions = [];
      return;
    }

    const reevaluateVisibility = () => {
      void this.reevaluateOnboardingState(false);
    };
    const clearTrackedWindow = () => {
      this.trackWindow(null);
    };

    this.trackedWindow.on("focus", reevaluateVisibility);
    this.trackedWindow.on("blur", reevaluateVisibility);
    this.trackedWindow.on("show", reevaluateVisibility);
    this.trackedWindow.on("hide", reevaluateVisibility);
    this.trackedWindow.on("minimize", reevaluateVisibility);
    this.trackedWindow.on("restore", reevaluateVisibility);
    this.trackedWindow.once("closed", clearTrackedWindow);
    this.stopTrackingWindow = () => {
      this.trackedWindow?.off("focus", reevaluateVisibility);
      this.trackedWindow?.off("blur", reevaluateVisibility);
      this.trackedWindow?.off("show", reevaluateVisibility);
      this.trackedWindow?.off("hide", reevaluateVisibility);
      this.trackedWindow?.off("minimize", reevaluateVisibility);
      this.trackedWindow?.off("restore", reevaluateVisibility);
      this.trackedWindow?.off("closed", clearTrackedWindow);
    };
    reevaluateVisibility();
  }

  private async handleEvent(event: SessionDriverEvent): Promise<void> {
    if (!Notification.isSupported()) {
      return;
    }
    if (!this.shouldNotify(event)) {
      return;
    }

    if (event.type === "runCompleted") {
      const dedupeKey = `${sessionKey(event.sessionRef)}:${event.runId ?? "completed"}`;
      if (this.completedRunKeys.has(dedupeKey)) {
        return;
      }
      this.completedRunKeys.add(dedupeKey);
      await this.showNotification(event.sessionRef, event.snapshot.title, "Agent finished responding");
      return;
    }

    if (event.type === "runFailed") {
      await this.showNotification(event.sessionRef, this.titleForSession(event.sessionRef), event.error.message);
      return;
    }

    if (event.type === "hostUiRequest" && requiresAttention(event)) {
      await this.showNotification(
        event.sessionRef,
        this.titleForSession(event.sessionRef),
        hostUiBody(event),
      );
    }
  }

  private shouldNotify(event: SessionDriverEvent): boolean {
    if (event.type !== "runCompleted" && event.type !== "runFailed" && event.type !== "hostUiRequest") {
      return false;
    }

    const preferences = this.latestState?.notificationPreferences;
    if (event.type === "runCompleted" && preferences && !preferences.backgroundCompletion) {
      return false;
    }
    if (event.type === "runFailed" && preferences && !preferences.backgroundFailure) {
      return false;
    }
    if (event.type === "hostUiRequest" && preferences && !preferences.attentionNeeded) {
      return false;
    }

    const window = this.getWindow();
    if (!window || window.isDestroyed()) {
      return true;
    }

    return !isSessionActivelyViewed(this.latestState, event.sessionRef, window);
  }

  private async reevaluateOnboardingState(syncWindow = true): Promise<void> {
    if (syncWindow && this.syncWindowTracking()) {
      return;
    }
    if (!Notification.isSupported()) {
      this.lastActivelyViewedSession = undefined;
      this.backgroundCandidateSessions = [];
      return;
    }

    const state = this.latestState;
    if (!state) {
      this.lastActivelyViewedSession = undefined;
      this.backgroundCandidateSessions = [];
      return;
    }

    const window = this.getWindow();
    const nextActivelyViewedSession = this.getActivelyViewedSession(state, window);
    const previousActivelyViewedSession = this.lastActivelyViewedSession;
    this.lastActivelyViewedSession = nextActivelyViewedSession;

    if (previousActivelyViewedSession && !sameSessionRef(previousActivelyViewedSession, nextActivelyViewedSession)) {
      this.enqueueBackgroundCandidate(previousActivelyViewedSession);
    }
    if (nextActivelyViewedSession) {
      this.backgroundCandidateSessions = this.backgroundCandidateSessions.filter(
        (candidateSessionRef) => !sameSessionRef(candidateSessionRef, nextActivelyViewedSession),
      );
    }

    await this.maybeRequestNotificationPermission(state, window);
  }

  private async maybeRequestNotificationPermission(
    state: DesktopAppState,
    window: BrowserWindow | null,
  ): Promise<void> {
    if (!this.notificationPreferencesEnabled(state)) {
      return;
    }

    this.backgroundCandidateSessions = this.backgroundCandidateSessions.filter((candidateSessionRef) => {
      if (isSessionActivelyViewed(state, candidateSessionRef, window)) {
        return false;
      }
      return Boolean(this.sessionFromLatestState(candidateSessionRef));
    });

    const nextRunnableCandidate = this.backgroundCandidateSessions.find((candidateSessionRef) => {
      const candidateSession = this.sessionFromLatestState(candidateSessionRef);
      return candidateSession?.status === "running";
    });
    if (!nextRunnableCandidate) {
      return;
    }

    if (this.permissionRequestPending) {
      return;
    }

    this.permissionRequestPending = true;
    try {
      await ensureNotificationPermission(window);
    } finally {
      this.backgroundCandidateSessions = [];
      this.permissionRequestPending = false;
    }
  }

  private enqueueBackgroundCandidate(sessionRef: SessionRef): void {
    if (this.backgroundCandidateSessions.some((candidateSessionRef) => sameSessionRef(candidateSessionRef, sessionRef))) {
      return;
    }
    this.backgroundCandidateSessions.push(sessionRef);
  }

  private async showNotification(sessionRef: SessionRef, title: string, body: string): Promise<void> {
    this.dismissForSession(sessionRef);
    await this.logNotification(sessionRef, title, body);
    if (process.env.PI_APP_TEST_MODE) {
      return;
    }
    const notification = new Notification({
      title,
      body,
      silent: false,
    });
    notification.on("click", () => {
      void this.openSession(sessionRef);
    });
    notification.on("close", () => {
      this.activeBySession.delete(sessionKey(sessionRef));
    });
    this.activeBySession.set(sessionKey(sessionRef), notification);
    notification.show();
  }

  private async logNotification(sessionRef: SessionRef, title: string, body: string): Promise<void> {
    const logPath = process.env.PI_APP_NOTIFICATION_LOG_PATH?.trim();
    if (!logPath) {
      return;
    }

    await mkdir(dirname(logPath), { recursive: true });
    await appendFile(
      logPath,
      `${JSON.stringify({ sessionRef, title, body, timestamp: new Date().toISOString() })}\n`,
      "utf8",
    );
  }

  private async openSession(sessionRef: SessionRef): Promise<void> {
    await this.store.selectSession(sessionRef);
    const window = this.getWindow();
    if (!window || window.isDestroyed()) {
      return;
    }
    if (window.isMinimized()) {
      window.restore();
    }
    window.show();
    window.focus();
    this.dismissForSession(sessionRef);
  }

  private dismissForSession(sessionRef: SessionRef): void {
    const key = sessionKey(sessionRef);
    const existing = this.activeBySession.get(key);
    existing?.close();
    this.activeBySession.delete(key);
  }

  private sessionFromLatestState(sessionRef: SessionRef) {
    const state = this.latestState;
    const workspace = state?.workspaces.find((entry) => entry.id === sessionRef.workspaceId);
    return workspace?.sessions.find((entry) => entry.id === sessionRef.sessionId);
  }

  private getActivelyViewedSession(
    state: DesktopAppState,
    window: BrowserWindow | null,
  ): SessionRef | undefined {
    const selectedSession = getSelectedSession(state);
    if (!selectedSession) {
      return undefined;
    }

    const sessionRef = {
      workspaceId: state.selectedWorkspaceId,
      sessionId: state.selectedSessionId,
    };
    return isSessionActivelyViewed(state, sessionRef, window) ? sessionRef : undefined;
  }

  private notificationPreferencesEnabled(state: DesktopAppState): boolean {
    const preferences = state.notificationPreferences;
    return preferences.backgroundCompletion || preferences.backgroundFailure || preferences.attentionNeeded;
  }

  private syncWindowTracking(): boolean {
    const window = this.getWindow();
    if (window !== this.trackedWindow) {
      this.trackWindow(window);
      return true;
    }
    return false;
  }

  private titleForSession(sessionRef: SessionRef): string {
    return this.sessionFromLatestState(sessionRef)?.title ?? "pi session";
  }
}

function requiresAttention(event: Extract<SessionDriverEvent, { type: "hostUiRequest" }>): boolean {
  return event.request.kind === "confirm" || event.request.kind === "input" || event.request.kind === "select";
}

function hostUiBody(event: Extract<SessionDriverEvent, { type: "hostUiRequest" }>): string {
  if (event.request.kind === "confirm" || event.request.kind === "input" || event.request.kind === "select") {
    return event.request.title;
  }
  return "Needs your input";
}

function sameSessionRef(left: SessionRef | undefined, right: SessionRef | undefined): boolean {
  if (!left || !right) {
    return left === right;
  }
  return left.workspaceId === right.workspaceId && left.sessionId === right.sessionId;
}
