import type { SessionDriverEvent, SessionRef } from "@pi-app/session-driver";
import type { TranscriptMessage } from "../src/desktop-state";
import {
  formatElapsedDuration,
  makeActivityItem,
  makeSummaryItem,
  makeToolItem,
  makeTranscriptMessage,
  makeTranscriptMessageWithAttachments,
  sessionKey,
  TRANSCRIPT_HISTORY_LIMIT,
} from "./app-store-utils";

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

export function appendUserMessage(
  transcriptCache: Map<string, TranscriptMessage[]>,
  sessionRef: SessionRef,
  text: string,
  attachments: NonNullable<Extract<TranscriptMessage, { kind: "message" }>["attachments"]> = [],
): TranscriptMessage[] {
  const key = sessionKey(sessionRef);
  const transcript = [...(transcriptCache.get(key) ?? [])];
  transcript.push(
    attachments.length > 0 ? makeTranscriptMessageWithAttachments("user", text, attachments) : makeTranscriptMessage("user", text),
  );
  transcriptCache.set(key, transcript);
  return transcript;
}

export function appendAssistantDelta(
  transcriptCache: Map<string, TranscriptMessage[]>,
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
  transcriptCache: Map<string, TranscriptMessage[]>,
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
      transcript.push(makeActivityItem("Resumed session", { metadata: relativeDetail(event.timestamp) }));
      break;
    case "sessionUpdated":
      if (event.snapshot.status === "running" && event.snapshot.runningRunId && !state.runningSinceBySession.has(key)) {
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
      upsertToolRow(transcript, event.callId, event.toolName, "running", toolLabel(event.toolName, event.input), undefined);
      break;
    }
    case "toolUpdated":
      upsertToolRow(transcript, event.callId, undefined, "running", undefined, event.text ?? progressLabel(event.progress));
      break;
    case "toolFinished":
      upsertToolRow(
        transcript,
        event.callId,
        undefined,
        event.success ? "success" : "error",
        undefined,
        detailFromOutput(event.output),
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
        transcript.push(makeSummaryItem(workedForLabel(metrics.startedAt, event.timestamp), { presentation: "divider" }));
      } else {
        transcript.push(makeSummaryItem("Completed", {
          presentation: "divider",
          metadata: relativeDetail(event.timestamp),
        }));
      }
      break;
    }
    case "runFailed": {
      const metrics = currentMetrics;
      clearRunState(transcript, key, event.sessionRef, state);
      transcript.push(
        makeActivityItem(event.error.message, {
          tone: "error",
          metadata: metrics ? workedForLabel(metrics.startedAt, event.timestamp) : undefined,
          detail: event.error.code,
        }),
      );
      break;
    }
    case "sessionClosed":
      clearRunState(transcript, key, event.sessionRef, state);
      transcript.push(makeActivityItem("Stopped", { metadata: relativeDetail(event.timestamp) }));
      break;
    case "hostUiRequest":
      transcript.push(makeActivityItem(hostUiLabel(event), { metadata: relativeDetail(event.timestamp) }));
      break;
    default:
      break;
  }

  transcriptCache.set(key, trimTranscript(transcript));
}

function upsertToolRow(
  transcript: TranscriptMessage[],
  callId: string,
  toolName?: string,
  status?: "running" | "success" | "error",
  label?: string,
  detail?: string,
) {
  const index = transcript.findIndex((item) => item.kind === "tool" && item.callId === callId);
  const existing = index >= 0 ? transcript[index] : undefined;
  const next = makeToolItem(
    callId,
    toolName ?? (existing?.kind === "tool" ? existing.toolName : "tool"),
    status ?? (existing?.kind === "tool" ? existing.status : "running"),
    label ?? (existing?.kind === "tool" ? existing.label : "Working"),
    {
      detail: detail ?? (existing?.kind === "tool" ? existing.detail : undefined),
      metadata: existing?.kind === "tool" ? existing.metadata : undefined,
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

function trimTranscript(transcript: TranscriptMessage[]): TranscriptMessage[] {
  return transcript.slice(-TRANSCRIPT_HISTORY_LIMIT);
}

function removeWorkingActivity(transcript: TranscriptMessage[], activityId: string | undefined): void {
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
  if (isRecord(output) && Array.isArray(output.content)) {
    const text = output.content
      .map((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : ""))
      .join(" ")
      .trim();
    if (text) {
      return truncate(text);
    }
  }
  if (typeof output === "string") {
    return truncate(output);
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

function hostUiLabel(event: Extract<SessionDriverEvent, { type: "hostUiRequest" }>): string {
  switch (event.request.kind) {
    case "confirm":
      return event.request.title;
    case "input":
    case "select":
      return event.request.title;
    case "notify":
      return event.request.message;
    case "status":
      return event.request.text ?? event.request.key;
    case "widget":
      return event.request.lines?.join(" · ") ?? event.request.key;
    case "title":
      return `Renamed session to ${event.request.title}`;
    case "editorText":
      return "Prepared editor text";
    default:
      return "Requested input";
  }
}

function truncate(value: string, limit = 160): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 1)}…`;
}

function inputLabel(input: unknown): string | undefined {
  if (typeof input === "string") {
    return truncate(input, 80);
  }
  if (!isRecord(input)) {
    return undefined;
  }

  const candidates = ["path", "filePath", "query", "q", "url", "command", "text", "title"];
  for (const key of candidates) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      return truncate(value, 80);
    }
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
