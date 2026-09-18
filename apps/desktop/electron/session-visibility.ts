import type { BrowserWindow } from "electron";
import type { DesktopAppState } from "../src/desktop-state";
import type { SessionRef } from "@pi-gui/session-driver";

type SessionVisibilityOverride = "active" | "inactive" | undefined;

export function isSessionActivelyViewed(
  state:
    Pick<DesktopAppState, "activeView" | "selectedWorkspaceId" | "selectedSessionId"> | undefined,
  sessionRef: SessionRef,
  window: BrowserWindow | null,
): boolean {
  if (!isSelectedSession(state, sessionRef)) {
    return false;
  }
  const override = sessionVisibilityOverride();
  if (override === "active") {
    return true;
  }
  if (override === "inactive") {
    return false;
  }
  if (!window || window.isDestroyed() || window.isMinimized() || !window.isVisible()) {
    return false;
  }
  return window.isFocused();
}

export function isSessionVisibleInWindow(
  state:
    Pick<DesktopAppState, "activeView" | "selectedWorkspaceId" | "selectedSessionId"> | undefined,
  sessionRef: SessionRef,
  window: BrowserWindow | null,
): boolean {
  if (!isSelectedSession(state, sessionRef)) {
    return false;
  }
  return Boolean(window && !window.isDestroyed() && !window.isMinimized() && window.isVisible());
}

function isSelectedSession(
  state:
    Pick<DesktopAppState, "activeView" | "selectedWorkspaceId" | "selectedSessionId"> | undefined,
  sessionRef: SessionRef,
): boolean {
  if (!state) {
    return false;
  }
  if (state.activeView !== "threads") {
    return false;
  }
  return (
    state.selectedWorkspaceId === sessionRef.workspaceId &&
    state.selectedSessionId === sessionRef.sessionId
  );
}

function sessionVisibilityOverride(): SessionVisibilityOverride {
  return (globalThis as { __PI_APP_TEST_SESSION_VISIBILITY__?: SessionVisibilityOverride })
    .__PI_APP_TEST_SESSION_VISIBILITY__;
}
