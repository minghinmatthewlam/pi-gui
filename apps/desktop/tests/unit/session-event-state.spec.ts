import { expect, test } from "@playwright/test";
import type { SessionDriverEvent } from "@pi-gui/session-driver";
import {
  createEmptyDesktopAppState,
  type DesktopAppState,
  type SessionRecord,
} from "../../contracts/desktop-state";
import {
  applyUrgentRunStatusState,
  shouldYieldBeforeSessionEvent,
} from "../../electron/conversation/app-store-session-state";

const sessionRef = { workspaceId: "ws-1", sessionId: "sess-1" };
const workspace = { workspaceId: "ws-1", path: "/tmp/ws", displayName: "ws" };

function sessionState(session: SessionRecord): DesktopAppState {
  return {
    ...createEmptyDesktopAppState(),
    selectedWorkspaceId: sessionRef.workspaceId,
    selectedSessionId: sessionRef.sessionId,
    workspaces: [
      {
        id: sessionRef.workspaceId,
        name: "ws",
        path: "/tmp/ws",
        lastOpenedAt: "2026-01-01T00:00:00.000Z",
        kind: "primary",
        sessions: [session],
      },
    ],
  };
}

function idleSession(config: SessionRecord["config"]): SessionRecord {
  return {
    id: sessionRef.sessionId,
    title: "Controls session",
    updatedAt: "2026-01-01T00:00:00.000Z",
    preview: "Thinking set to max",
    status: "idle",
    hasUnseenUpdate: false,
    config,
  };
}

function sessionUpdated(status: "idle" | "stopping" | "failed"): SessionDriverEvent {
  return {
    type: "sessionUpdated",
    sessionRef,
    timestamp: "2026-01-01T00:00:01.000Z",
    snapshot: {
      ref: sessionRef,
      workspace,
      title: "Controls session",
      status,
      updatedAt: "2026-01-01T00:00:01.000Z",
      config: { provider: "openai", modelId: "gpt-5", thinkingLevel: "high" },
    },
  };
}

test("idle sessionUpdated does not clobber composer thinking config", () => {
  const state = sessionState(
    idleSession({ provider: "openai", modelId: "gpt-5", thinkingLevel: "max" }),
  );
  expect(applyUrgentRunStatusState(state, sessionUpdated("idle"))).toBeUndefined();
});

test("stopping sessionUpdated patches status and keeps composer config", () => {
  const state = sessionState({
    ...idleSession({ provider: "openai", modelId: "gpt-5", thinkingLevel: "max" }),
    status: "running",
    runningSince: "2026-01-01T00:00:00.000Z",
  });
  const next = applyUrgentRunStatusState(state, sessionUpdated("stopping"));
  expect(next?.workspaces[0]?.sessions[0]).toMatchObject({
    status: "stopping",
    runningSince: "2026-01-01T00:00:00.000Z",
    config: { thinkingLevel: "max" },
  });
});

test("only stream deltas yield before session event handling", () => {
  expect(shouldYieldBeforeSessionEvent(sessionUpdated("idle"))).toBe(false);
  expect(
    shouldYieldBeforeSessionEvent({
      type: "assistantDelta",
      sessionRef,
      timestamp: "2026-01-01T00:00:01.000Z",
      text: "token",
    }),
  ).toBe(true);
});
