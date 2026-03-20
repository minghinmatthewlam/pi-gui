import { randomUUID } from "node:crypto";
import type { SessionCatalogEntry, WorkspaceCatalogEntry } from "@pi-app/catalogs";
import type { SessionAttachment, SessionConfig, SessionRef } from "@pi-app/session-driver";
import type {
  ComposerImageAttachment,
  SessionRecord,
  TranscriptMessage,
  WorkspaceRecord,
  WorkspaceSessionTarget,
} from "../src/desktop-state";

export const TRANSCRIPT_HISTORY_LIMIT = 180;

export function buildWorkspaceRecords(
  workspaces: readonly WorkspaceCatalogEntry[],
  sessions: readonly SessionCatalogEntry[],
  transcriptCache: Map<string, TranscriptMessage[]>,
  runningSinceBySession: Map<string, string>,
  sessionConfigBySession: Map<string, SessionConfig>,
): WorkspaceRecord[] {
  return workspaces.map((workspace) => ({
    id: workspace.workspaceId,
    name: workspace.displayName,
    path: workspace.path,
    lastOpenedAt: workspace.lastOpenedAt,
    sessions: sessions
      .filter((session) => session.workspaceId === workspace.workspaceId)
      .map((session) => buildSessionRecord(session, transcriptCache, runningSinceBySession, sessionConfigBySession)),
  }));
}

function buildSessionRecord(
  session: SessionCatalogEntry,
  transcriptCache: Map<string, TranscriptMessage[]>,
  runningSinceBySession: Map<string, string>,
  sessionConfigBySession: Map<string, SessionConfig>,
): SessionRecord {
  const key = sessionKey(session.sessionRef);
  const transcript = transcriptCache.get(key) ?? [];
  const preview = previewFromTranscript(transcript) ?? session.previewSnippet ?? session.title;
  return {
    id: session.sessionRef.sessionId,
    title: session.title,
    updatedAt: session.updatedAt,
    preview,
    status: session.status,
    runningSince: runningSinceBySession.get(key),
    config: sessionConfigBySession.get(key),
    transcript: transcript.map(cloneTranscriptMessage),
  };
}

export function resolveSelectedWorkspaceId(
  preferredWorkspaceId: string,
  workspaces: readonly WorkspaceRecord[],
): string {
  if (preferredWorkspaceId && workspaces.some((workspace) => workspace.id === preferredWorkspaceId)) {
    return preferredWorkspaceId;
  }
  return workspaces[0]?.id ?? "";
}

export function resolveSelectedSessionId(
  workspaceId: string,
  preferredSessionId: string,
  workspaces: readonly WorkspaceRecord[],
): string {
  const workspace = workspaces.find((entry) => entry.id === workspaceId);
  if (!workspace) {
    return "";
  }
  if (preferredSessionId && workspace.sessions.some((session) => session.id === preferredSessionId)) {
    return preferredSessionId;
  }
  return workspace.sessions[0]?.id ?? "";
}

export function toSessionRef(target: WorkspaceSessionTarget): SessionRef {
  return {
    workspaceId: target.workspaceId,
    sessionId: target.sessionId,
  };
}

export function sessionKey(sessionRef: SessionRef): string {
  return `${sessionRef.workspaceId}:${sessionRef.sessionId}`;
}

export function makeTranscriptMessage(role: "user" | "assistant", text: string): TranscriptMessage {
  return {
    kind: "message",
    id: randomUUID(),
    role,
    text,
    createdAt: new Date().toISOString(),
  };
}

export function makeTranscriptMessageWithAttachments(
  role: "user" | "assistant",
  text: string,
  attachments: NonNullable<Extract<TranscriptMessage, { kind: "message" }>["attachments"]>,
): TranscriptMessage {
  return {
    ...makeTranscriptMessage(role, text),
    ...(attachments?.length ? { attachments: attachments.map((attachment) => ({ ...attachment })) } : {}),
  };
}

export function cloneTranscriptMessage(message: TranscriptMessage): TranscriptMessage {
  if (message.kind === "message" && message.attachments) {
    return {
      ...message,
      attachments: message.attachments.map((attachment) => ({ ...attachment })),
    };
  }
  return { ...message };
}

export function cloneComposerImageAttachment(attachment: ComposerImageAttachment): ComposerImageAttachment {
  return { ...attachment };
}

export function cloneComposerImageAttachments(
  attachments: readonly ComposerImageAttachment[],
): ComposerImageAttachment[] {
  return attachments.map(cloneComposerImageAttachment);
}

export function toSessionAttachments(
  attachments: readonly ComposerImageAttachment[],
): SessionAttachment[] {
  return attachments.map(toImageAttachmentPayload);
}

export function toTranscriptAttachments(
  attachments: readonly ComposerImageAttachment[],
): NonNullable<Extract<TranscriptMessage, { kind: "message" }>["attachments"]> {
  return attachments.map(toImageAttachmentPayload);
}

function toImageAttachmentPayload({ data, mimeType, name }: ComposerImageAttachment) {
  return {
    kind: "image" as const,
    data,
    mimeType,
    name,
  };
}

export function makeActivityItem(
  label: string,
  options: Pick<Extract<TranscriptMessage, { kind: "activity" }>, "detail" | "metadata" | "tone"> = {},
): TranscriptMessage {
  return {
    kind: "activity",
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    label,
    ...options,
  };
}

export function makeSummaryItem(
  label: string,
  options: Partial<Pick<Extract<TranscriptMessage, { kind: "summary" }>, "metadata" | "presentation">> = {},
): TranscriptMessage {
  return {
    kind: "summary",
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    label,
    presentation: options.presentation ?? "inline",
    ...(options.metadata ? { metadata: options.metadata } : {}),
  };
}

export function makeToolItem(
  callId: string,
  toolName: string,
  status: "running" | "success" | "error",
  label: string,
  options: Pick<Extract<TranscriptMessage, { kind: "tool" }>, "detail" | "metadata"> = {},
): TranscriptMessage {
  return {
    kind: "tool",
    id: callId,
    callId,
    toolName,
    status,
    label,
    createdAt: new Date().toISOString(),
    ...options,
  };
}

export function previewFromTranscript(transcript: readonly TranscriptMessage[]): string | undefined {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const item = transcript[index];
    if (!item) {
      continue;
    }
    if (item.kind === "message" && item.role === "assistant") {
      return item.text;
    }
  }

  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const item = transcript[index];
    if (!item) {
      continue;
    }
    if (item.kind === "message") {
      return item.text;
    }
    if (item.kind === "tool" || item.kind === "activity") {
      return item.label;
    }
  }
  return undefined;
}

export function formatElapsedDuration(startedAt: string, endedAt: string): string {
  const diffMs = Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));
  const seconds = Math.max(1, Math.round(diffMs / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return remaining === 0 ? `${minutes}m` : `${minutes}m ${remaining}s`;
}
