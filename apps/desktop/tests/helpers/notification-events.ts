import { readFile } from "node:fs/promises";
import type { SessionDriverEvent } from "@pi-gui/session-driver";
import type { DesktopHarness } from "./electron-app";
import { emitTestSessionEvent } from "./electron-app";
import type { SessionContext } from "../live/session-event-test-helpers";

export async function readOptionalLog(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

export async function emitRunningEvent(
  harness: DesktopHarness,
  session: SessionContext,
  label: string,
): Promise<string> {
  const startedAt = new Date().toISOString();
  const runId = `${label.toLowerCase()}-${Date.now()}`;
  const event: Extract<SessionDriverEvent, { type: "sessionUpdated" }> = {
    type: "sessionUpdated",
    sessionRef: session.sessionRef,
    timestamp: startedAt,
    runId,
    snapshot: {
      ref: session.sessionRef,
      workspace: session.workspace,
      title: session.title,
      status: "running",
      updatedAt: startedAt,
      preview: `${label} running`,
      runningRunId: runId,
    },
  };
  await emitTestSessionEvent(harness, event);
  return runId;
}

export async function emitCompletedEvent(
  harness: DesktopHarness,
  session: SessionContext,
  label: string,
  runId?: string,
): Promise<void> {
  const completedAt = new Date(Date.now() + 1_000).toISOString();
  const completedEvent: Extract<SessionDriverEvent, { type: "runCompleted" }> = {
    type: "runCompleted",
    sessionRef: session.sessionRef,
    timestamp: completedAt,
    runId: runId ?? `${label.toLowerCase()}-${Date.now()}`,
    snapshot: {
      ref: session.sessionRef,
      workspace: session.workspace,
      title: session.title,
      status: "idle",
      updatedAt: completedAt,
      preview: `${label} complete`,
    },
  };
  await emitTestSessionEvent(harness, completedEvent);
}

export async function emitFailedEvent(
  harness: DesktopHarness,
  session: SessionContext,
  label: string,
  message: string,
): Promise<void> {
  const runId = await emitRunningEvent(harness, session, label);
  const failedAt = new Date(Date.now() + 1_000).toISOString();
  const failedEvent: Extract<SessionDriverEvent, { type: "runFailed" }> = {
    type: "runFailed",
    sessionRef: session.sessionRef,
    timestamp: failedAt,
    runId,
    error: {
      message,
    },
  };
  await emitTestSessionEvent(harness, failedEvent);
}

export async function emitAttentionRequest(
  harness: DesktopHarness,
  session: SessionContext,
  label: string,
  title: string,
): Promise<void> {
  await emitRunningEvent(harness, session, label);
  const requestEvent: Extract<SessionDriverEvent, { type: "hostUiRequest" }> = {
    type: "hostUiRequest",
    sessionRef: session.sessionRef,
    timestamp: new Date().toISOString(),
    request: {
      kind: "confirm",
      requestId: `${label.toLowerCase()}-${Date.now()}`,
      title,
      message: `${title} message`,
    },
  };
  await emitTestSessionEvent(harness, requestEvent);
}
