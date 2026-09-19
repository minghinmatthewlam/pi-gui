import type { SessionTranscriptMessage, SessionTranscriptRole } from "@pi-gui/session-driver";

export type SessionRole = SessionTranscriptRole;
export type TimelineTone = "neutral" | "success" | "warning" | "error";
export type TimelineToolStatus = "running" | "success" | "error";
export type TimelineSummaryPresentation = "inline" | "divider";

export interface TimelineActivity {
  readonly kind: "activity";
  readonly id: string;
  readonly createdAt: string;
  readonly label: string;
  readonly detail?: string;
  readonly metadata?: string;
  readonly tone?: TimelineTone;
}

export interface TimelineToolCall {
  readonly kind: "tool";
  readonly id: string;
  readonly callId: string;
  readonly toolName: string;
  readonly status: TimelineToolStatus;
  readonly label: string;
  readonly detail?: string;
  readonly metadata?: string;
  readonly createdAt: string;
  readonly input?: unknown;
  readonly output?: unknown;
}

export interface TimelineSummary {
  readonly kind: "summary";
  readonly id: string;
  readonly createdAt: string;
  readonly label: string;
  readonly metadata?: string;
  readonly presentation: TimelineSummaryPresentation;
}

export type TranscriptMessage =
  SessionTranscriptMessage | TimelineActivity | TimelineToolCall | TimelineSummary;

/**
 * A derived, view-only marker inserted between turns to show how long the agent
 * worked on the preceding user prompt. Never persisted or produced by the store;
 * the timeline computes it from real message/tool timestamps at render time, so
 * it is kept out of {@link TranscriptMessage} to avoid leaking into store code.
 */
export interface TimelineTurnMarker {
  readonly kind: "turn-marker";
  readonly id: string;
  readonly durationMs: number;
}

export type DisplayTimelineItem = TranscriptMessage | TimelineTurnMarker;
