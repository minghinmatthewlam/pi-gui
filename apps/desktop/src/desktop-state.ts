import type { SessionTranscriptMessage, SessionTranscriptRole } from "@pi-app/pi-sdk-driver";

export type SessionStatus = "idle" | "running" | "failed";
export type SessionRole = SessionTranscriptRole;
export type TranscriptMessage = SessionTranscriptMessage;

export interface SessionRecord {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly preview: string;
  readonly status: SessionStatus;
  readonly transcript: readonly TranscriptMessage[];
}

export interface WorkspaceRecord {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly lastOpenedAt: string;
  readonly sessions: readonly SessionRecord[];
}

export interface DesktopAppState {
  readonly workspaces: readonly WorkspaceRecord[];
  readonly selectedWorkspaceId: string;
  readonly selectedSessionId: string;
  readonly composerDraft: string;
  readonly revision: number;
  readonly lastError?: string;
}

export interface CreateSessionInput {
  readonly workspaceId: string;
  readonly title?: string;
}

export interface WorkspaceSessionTarget {
  readonly workspaceId: string;
  readonly sessionId: string;
}

export function createEmptyDesktopAppState(): DesktopAppState {
  return {
    workspaces: [],
    selectedWorkspaceId: "",
    selectedSessionId: "",
    composerDraft: "",
    revision: 0,
  };
}

export function cloneDesktopAppState(state: DesktopAppState): DesktopAppState {
  return structuredClone(state);
}

export function getSelectedWorkspace(state: DesktopAppState): WorkspaceRecord | undefined {
  return state.workspaces.find((workspace) => workspace.id === state.selectedWorkspaceId);
}

export function getSelectedSession(state: DesktopAppState): SessionRecord | undefined {
  return getSelectedWorkspace(state)?.sessions.find((session) => session.id === state.selectedSessionId);
}
