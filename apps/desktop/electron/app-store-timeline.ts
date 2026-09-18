import { sessionKey } from "@pi-gui/pi-sdk-driver";
import type { SessionTranscriptItem } from "@pi-gui/pi-sdk-driver";
import type { SessionDriverEvent, SessionQueuedMessage, SessionRef } from "@pi-gui/session-driver";
import type { TranscriptMessage } from "../src/desktop-state";
import {
  formatElapsedDuration,
  makeActivityItem,
  makeSummaryItem,
  makeToolItem,
  makeTranscriptMessage,
  makeTranscriptMessageWithAttachments,
} from "./app-store-utils";
import {
  createChildThreadToolName,
  listThreadsToolName,
  readThreadToolName,
  sendMessageToThreadToolName,
} from "./orchestration-runtime";

export interface RunMetrics {
  readonly startedAt: string;
  toolCount: number;
  searchCount: number;
  fileCount: number;
}

interface TimelineRuntimeState {
  readonly runMetricsBySession: Map<string, RunMetrics>;
  readonly runningSinceBySession: Map<string, string>;
  readonly activeAssistantMessageBySession: Map<string, string>;
  readonly activeWorkingActivityBySession: Map<string, string>;
}

export function timelineFromDriverTranscript(
  items: readonly SessionTranscriptItem[],
): TranscriptMessage[] {
  return items.map((item) => {
    if (item.kind !== "tool") {
      return item;
    }
    const detail = detailFromOutput(item.output);
    return {
      ...makeToolItem(
        item.callId,
        item.toolName,
        item.status,
        toolLabel(item.toolName, item.input),
        {
          ...(detail !== undefined ? { detail } : {}),
          ...(item.input !== undefined ? { input: item.input } : {}),
          ...(item.output !== undefined ? { output: item.output } : {}),
        },
      ),
      createdAt: item.createdAt,
    };
  });
}

export function appendUserMessage(
  transcriptCache: Map<string, readonly TranscriptMessage[]>,
  sessionRef: SessionRef,
  text: string,
  attachments: NonNullable<Extract<TranscriptMessage, { kind: "message" }>["attachments"]> = [],
): string {
  const key = sessionKey(sessionRef);
  const transcript = [...(transcriptCache.get(key) ?? [])];
  const message =
    attachments.length > 0
      ? makeTranscriptMessageWithAttachments("user", text, attachments)
      : makeTranscriptMessage("user", text);
  transcript.push(message);
  transcriptCache.set(key, transcript);
  return message.id;
}

export function appendQueuedUserMessage(
  transcriptCache: Map<string, readonly TranscriptMessage[]>,
  sessionRef: SessionRef,
  message: SessionQueuedMessage,
): void {
  const key = sessionKey(sessionRef);
  const transcript = [...(transcriptCache.get(key) ?? [])];
  const existingIndex = transcript.findIndex(
    (item) => item.kind === "message" && item.id === message.id,
  );
  const nextMessage = {
    kind: "message" as const,
    id: message.id,
    role: "user" as const,
    text: message.text,
    createdAt: message.createdAt,
    ...(message.attachments?.length
      ? {
          attachments: message.attachments.map((attachment) => ({ ...attachment })),
        }
      : {}),
  };

  if (existingIndex >= 0) {
    transcript[existingIndex] = nextMessage;
  } else {
    transcript.push(nextMessage);
  }
  transcriptCache.set(key, transcript);
}

export function appendAssistantDelta(
  transcriptCache: Map<string, readonly TranscriptMessage[]>,
  activeAssistantMessageBySession: Map<string, string>,
  sessionRef: SessionRef,
  text: string,
): void {
  const key = sessionKey(sessionRef);
  const transcript = [...(transcriptCache.get(key) ?? [])];
  const activeId = activeAssistantMessageBySession.get(key);

  if (activeId) {
    const index = transcript.findIndex((message) => message.id === activeId);
    const current = index >= 0 ? transcript[index] : undefined;
    if (current?.kind === "message") {
      transcript[index] = {
        ...current,
        text: `${current.text}${text}`,
      };
    } else {
      const message = makeTranscriptMessage("assistant", text);
      transcript.push(message);
      activeAssistantMessageBySession.set(key, message.id);
    }
  } else {
    const message = makeTranscriptMessage("assistant", text);
    transcript.push(message);
    activeAssistantMessageBySession.set(key, message.id);
  }

  transcriptCache.set(key, transcript);
}

export function clearActiveAssistantMessage(
  activeAssistantMessageBySession: Map<string, string>,
  sessionRef: SessionRef,
): void {
  activeAssistantMessageBySession.delete(sessionKey(sessionRef));
}

export function applyTimelineEvent(
  transcriptCache: Map<string, readonly TranscriptMessage[]>,
  event: SessionDriverEvent,
  state: TimelineRuntimeState,
): void {
  if (event.type === "assistantDelta") {
    return;
  }

  const key = sessionKey(event.sessionRef);
  const transcript = [...(transcriptCache.get(key) ?? [])];
  const currentMetrics = state.runMetricsBySession.get(key);

  switch (event.type) {
    case "sessionOpened":
      transcript.push(
        makeActivityItem("Resumed session", { metadata: relativeDetail(event.timestamp) }),
      );
      break;
    case "sessionUpdated":
      if (
        event.snapshot.status === "running" &&
        event.snapshot.runningRunId &&
        !state.runningSinceBySession.has(key)
      ) {
        state.runningSinceBySession.set(key, event.timestamp);
        state.runMetricsBySession.set(key, {
          startedAt: event.timestamp,
          toolCount: 0,
          searchCount: 0,
          fileCount: 0,
        });
        const activity = makeActivityItem("Working…");
        state.activeWorkingActivityBySession.set(key, activity.id);
        transcript.push(activity);
      }
      break;
    case "queuedMessageStarted":
      clearActiveAssistantMessage(state.activeAssistantMessageBySession, event.sessionRef);
      appendQueuedUserMessage(transcriptCache, event.sessionRef, event.message);
      return;
    case "toolStarted": {
      clearActiveAssistantMessage(state.activeAssistantMessageBySession, event.sessionRef);
      const metrics = currentMetrics ?? {
        startedAt: event.timestamp,
        toolCount: 0,
        searchCount: 0,
        fileCount: 0,
      };
      metrics.toolCount += 1;
      if (looksLikeSearch(event.toolName, event.input)) {
        metrics.searchCount += 1;
      }
      if (looksLikeFileExplore(event.toolName, event.input)) {
        metrics.fileCount += 1;
      }
      state.runMetricsBySession.set(key, metrics);
      upsertToolRow(
        transcript,
        event.callId,
        event.toolName,
        "running",
        toolLabel(event.toolName, event.input),
        undefined,
        event.input,
      );
      break;
    }
    case "toolUpdated":
      upsertToolRow(
        transcript,
        event.callId,
        undefined,
        "running",
        undefined,
        event.text ?? progressLabel(event.progress),
      );
      break;
    case "toolFinished":
      upsertToolRow(
        transcript,
        event.callId,
        undefined,
        event.success ? "success" : "error",
        undefined,
        detailFromOutput(event.output),
        undefined,
        event.output,
      );
      break;
    case "runCompleted": {
      const metrics = currentMetrics;
      clearRunState(transcript, key, event.sessionRef, state);
      if (metrics) {
        const label = summaryLabel(metrics);
        if (label) {
          transcript.push(makeSummaryItem(label, { presentation: "inline" }));
        }
        transcript.push(
          makeSummaryItem(workedForLabel(metrics.startedAt, event.timestamp), {
            presentation: "divider",
          }),
        );
      } else {
        transcript.push(
          makeSummaryItem("Completed", {
            presentation: "divider",
            metadata: relativeDetail(event.timestamp),
          }),
        );
      }
      break;
    }
    case "runFailed": {
      const metrics = currentMetrics;
      const latestToolError = metrics
        ? latestErrorToolDetail(transcript, metrics.startedAt)
        : undefined;
      const failureLabel = clearerRunFailureLabel(event.error.message, latestToolError);
      const failureDetail = event.error.code;
      clearRunState(transcript, key, event.sessionRef, state);
      transcript.push(
        makeActivityItem(failureLabel, {
          tone: "error",
          metadata: metrics ? workedForLabel(metrics.startedAt, event.timestamp) : undefined,
          detail: failureDetail,
        }),
      );
      break;
    }
    case "sessionClosed":
      clearRunState(transcript, key, event.sessionRef, state);
      transcript.push(makeActivityItem("Stopped", { metadata: relativeDetail(event.timestamp) }));
      break;
    case "hostUiRequest":
      if (event.request.kind === "notify") {
        transcript.push(
          makeActivityItem(event.request.message, { metadata: relativeDetail(event.timestamp) }),
        );
      }
      break;
    default:
      break;
  }

  transcriptCache.set(key, transcript);
}

function upsertToolRow(
  transcript: TranscriptMessage[],
  callId: string,
  toolName?: string,
  status?: "running" | "success" | "error",
  label?: string,
  detail?: string,
  input?: unknown,
  output?: unknown,
) {
  const index = transcript.findIndex((item) => item.kind === "tool" && item.callId === callId);
  const existing = index >= 0 ? transcript[index] : undefined;
  const existingTool = existing?.kind === "tool" ? existing : undefined;
  const next = makeToolItem(
    callId,
    toolName ?? existingTool?.toolName ?? "tool",
    status ?? existingTool?.status ?? "running",
    label ?? existingTool?.label ?? "Working",
    {
      detail: detail ?? existingTool?.detail,
      metadata: existingTool?.metadata,
      input: input ?? existingTool?.input,
      output: output ?? existingTool?.output,
    },
  );

  if (index >= 0) {
    transcript[index] = {
      ...next,
      createdAt: existing?.createdAt ?? next.createdAt,
    };
    return;
  }

  transcript.push(next);
}

function removeWorkingActivity(
  transcript: TranscriptMessage[],
  activityId: string | undefined,
): void {
  if (!activityId) {
    return;
  }
  const index = transcript.findIndex((item) => item.kind === "activity" && item.id === activityId);
  if (index >= 0) {
    transcript.splice(index, 1);
  }
}

function clearRunState(
  transcript: TranscriptMessage[],
  key: string,
  sessionRef: SessionRef,
  state: TimelineRuntimeState,
): void {
  clearActiveAssistantMessage(state.activeAssistantMessageBySession, sessionRef);
  removeWorkingActivity(transcript, state.activeWorkingActivityBySession.get(key));
  state.activeWorkingActivityBySession.delete(key);
  state.runningSinceBySession.delete(key);
  state.runMetricsBySession.delete(key);
}

function toolLabel(toolName: string, input: unknown): string {
  const detail = inputLabel(input);
  if (toolName === createChildThreadToolName) {
    return detail ? `Started child thread: ${detail}` : "Started child thread";
  }
  if (toolName === listThreadsToolName) {
    return "Listed threads";
  }
  if (toolName === readThreadToolName) {
    return detail ? `Read thread: ${detail}` : "Read thread";
  }
  if (toolName === sendMessageToThreadToolName) {
    return detail ? `Sent message to thread: ${detail}` : "Sent message to thread";
  }
  if (looksLikeSearch(toolName, input)) {
    return detail ? `Searched ${detail}` : `Searched with ${toolName}`;
  }
  if (looksLikeFileExplore(toolName, input)) {
    if (toolName.toLowerCase() === "read") {
      return detail ? `Read ${detail}` : "Read a file";
    }
    return detail ? `Explored ${detail}` : `Explored files with ${toolName}`;
  }
  return detail ? `Ran ${toolName}: ${detail}` : `Ran ${toolName}`;
}

function progressLabel(progress: number | undefined): string | undefined {
  if (progress === undefined) {
    return undefined;
  }
  if (progress <= 1) {
    return `${Math.round(progress * 100)}%`;
  }
  return String(progress);
}

function detailFromOutput(output: unknown): string | undefined {
  if (isRecord(output)) {
    const directError =
      stringProperty(output, "error") ??
      stringProperty(output, "message") ??
      stringProperty(output, "stderr");
    if (directError) {
      return summarizeToolDetail(directError);
    }
  }
  if (isRecord(output) && Array.isArray(output.content)) {
    const text = output.content
      .map((part) =>
        isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : "",
      )
      .join("\n")
      .trim();
    if (text) {
      return summarizeToolDetail(text);
    }
  }
  if (typeof output === "string") {
    return summarizeToolDetail(output);
  }
  if (output === undefined || output === null) {
    return undefined;
  }
  return truncate(JSON.stringify(output));
}

function looksLikeSearch(toolName: string, input: unknown): boolean {
  if (toolName.toLowerCase().includes("search")) {
    return true;
  }
  return typeof input === "string" && /https?:\/\/|site:|query|search/i.test(input);
}

function looksLikeFileExplore(toolName: string, input: unknown): boolean {
  if (/(read|glob|ls|list|open)/i.test(toolName)) {
    return true;
  }
  return typeof input === "string" && /\/|\.md|\.ts|file/i.test(input);
}

function summaryLabel(metrics: RunMetrics): string | undefined {
  const parts: string[] = [];
  if (metrics.fileCount > 0) {
    parts.push(`Explored ${metrics.fileCount} file${metrics.fileCount === 1 ? "" : "s"}`);
  }
  if (metrics.searchCount > 0) {
    parts.push(`${metrics.searchCount} search${metrics.searchCount === 1 ? "" : "es"}`);
  }
  if (parts.length === 0 && metrics.toolCount > 0) {
    parts.push(`Used ${metrics.toolCount} tool${metrics.toolCount === 1 ? "" : "s"}`);
  }
  return parts.length > 0 ? parts.join(", ") : undefined;
}

function workedForLabel(startedAt: string, endedAt: string): string {
  return `Worked for ${formatElapsedDuration(startedAt, endedAt)}`;
}

function relativeDetail(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function truncate(value: string, limit = 160): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 1)}…`;
}

function summarizeToolDetail(value: string): string {
  return truncate(value);
}

function inputLabel(input: unknown): string | undefined {
  if (typeof input === "string") {
    return truncate(input, 80);
  }
  if (!isRecord(input)) {
    return undefined;
  }

  const candidates = [
    "path",
    "filePath",
    "query",
    "q",
    "url",
    "command",
    "text",
    "prompt",
    "title",
    "app",
  ];
  for (const key of candidates) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      return truncate(value, 80);
    }
  }

  return undefined;
}

function latestErrorToolDetail(
  transcript: readonly TranscriptMessage[],
  runStartedAt: string,
): string | undefined {
  const runStartedAtMs = Date.parse(runStartedAt);
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const item = transcript[index];
    if (!item) {
      continue;
    }
    if (Number.isFinite(runStartedAtMs) && Date.parse(item.createdAt) < runStartedAtMs) {
      break;
    }
    if (item.kind === "tool" && item.status === "error" && item.detail) {
      return item.detail;
    }
  }
  return undefined;
}

function clearerRunFailureLabel(message: string, latestToolError: string | undefined): string {
  if (!latestToolError) {
    return message;
  }
  const normalized = message.trim().toLowerCase();
  if (
    normalized === "terminated" ||
    normalized === "failed" ||
    normalized === "error" ||
    normalized === "run failed"
  ) {
    return latestToolError;
  }
  return message;
}

function stringProperty(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
