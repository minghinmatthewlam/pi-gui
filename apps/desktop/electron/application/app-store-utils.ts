import { randomUUID } from "node:crypto";
import type {
  SessionCatalogEntry,
  WorkspaceCatalogEntry,
  WorktreeCatalogEntry,
} from "@pi-gui/catalogs";
import { sessionKey } from "@pi-gui/session-driver";
import type {
  SessionAttachment,
  SessionConfig,
  SessionQueuedMessage,
  SessionRef,
  SessionStatus,
} from "@pi-gui/session-driver";
import type {
  ComposerAttachment,
  QueuedComposerMessage,
  SessionRecord,
  TranscriptMessage,
  WorktreeRecord,
  WorkspaceRecord,
  WorkspaceSessionTarget,
} from "../../contracts/desktop-state";

export const LEGACY_TRANSCRIPT_HISTORY_LIMIT = 180;

export function mapToRecord<V>(map: Map<string, V>): Record<string, V> {
  return Object.fromEntries(map.entries());
}

export function buildWorkspaceRecords(
  workspaces: readonly WorkspaceCatalogEntry[],
  worktrees: readonly WorktreeCatalogEntry[],
  sessions: readonly SessionCatalogEntry[],
  transcriptCache: Map<string, readonly TranscriptMessage[]>,
  runningSinceBySession: Map<string, string>,
  sessionConfigBySession: Map<string, SessionConfig>,
  lastViewedAtBySession: Map<string, string>,
  pinnedAtBySession: Map<string, string>,
): WorkspaceRecord[] {
  const workspaceRoots = resolveWorkspaceRoots(workspaces, worktrees);

  return workspaces.map((workspace) => {
    const rootWorkspaceId = workspaceRoots.get(workspace.workspaceId);

    return {
      id: workspace.workspaceId,
      name: workspace.displayName,
      path: workspace.path,
      lastOpenedAt: workspace.lastOpenedAt,
      kind: rootWorkspaceId ? "worktree" : "primary",
      ...(rootWorkspaceId
        ? {
            rootWorkspaceId,
            branchName: linkedWorktreeBranchName(workspace, worktrees, rootWorkspaceId),
          }
        : {}),
      sessions: sessions
        .filter((session) => session.workspaceId === workspace.workspaceId)
        .map((session) =>
          buildSessionRecord(
            session,
            transcriptCache,
            runningSinceBySession,
            sessionConfigBySession,
            lastViewedAtBySession,
            pinnedAtBySession,
          ),
        ),
    };
  });
}

export function buildWorktreeRecords(
  workspaces: readonly WorkspaceCatalogEntry[],
  worktrees: readonly WorktreeCatalogEntry[],
): Record<string, readonly WorktreeRecord[]> {
  const workspaceRoots = resolveWorkspaceRoots(workspaces, worktrees);
  const linkedWorkspaceIdsByPath = new Map(
    workspaces.map((workspace) => [workspace.path, workspace.workspaceId] as const),
  );
  const groups = new Map<string, WorktreeRecord[]>();

  for (const worktree of worktrees) {
    if (worktree.kind !== "linked") {
      continue;
    }
    const linkedWorkspaceId = linkedWorkspaceIdsByPath.get(worktree.path);
    const resolvedRootWorkspaceId = linkedWorkspaceId
      ? workspaceRoots.get(linkedWorkspaceId)
      : undefined;
    if (linkedWorkspaceId) {
      if (!resolvedRootWorkspaceId || resolvedRootWorkspaceId !== worktree.workspaceId) {
        continue;
      }
    }
    const entry: WorktreeRecord = {
      id: worktree.worktreeId,
      rootWorkspaceId: resolvedRootWorkspaceId ?? worktree.workspaceId,
      linkedWorkspaceId,
      name: worktree.displayName,
      path: worktree.path,
      status: worktree.status,
      branchName: worktree.branchName,
      updatedAt: worktree.updatedAt,
    };
    const existing = groups.get(worktree.workspaceId);
    if (existing) {
      existing.push(entry);
    } else {
      groups.set(worktree.workspaceId, [entry]);
    }
  }

  for (const entries of groups.values()) {
    entries.sort((left, right) => {
      if (left.updatedAt !== right.updatedAt) {
        return right.updatedAt.localeCompare(left.updatedAt);
      }
      return left.name.localeCompare(right.name);
    });
  }

  return mapToRecord(groups);
}

function resolveWorkspaceRoots(
  workspaces: readonly WorkspaceCatalogEntry[],
  worktrees: readonly WorktreeCatalogEntry[],
): Map<string, string | undefined> {
  const workspacesById = new Map(
    workspaces.map((workspace) => [workspace.workspaceId, workspace] as const),
  );
  const linkedEntriesByPath = new Map<string, WorktreeCatalogEntry[]>();
  for (const worktree of worktrees) {
    if (worktree.kind !== "linked") {
      continue;
    }
    const existing = linkedEntriesByPath.get(worktree.path);
    if (existing) {
      existing.push(worktree);
    } else {
      linkedEntriesByPath.set(worktree.path, [worktree]);
    }
  }

  const candidateRootByWorkspaceId = new Map<string, string | undefined>();
  for (const workspace of workspaces) {
    const candidates = (linkedEntriesByPath.get(workspace.path) ?? []).filter(
      (worktree) => worktree.workspaceId !== workspace.workspaceId,
    );
    const owner = pickPreferredWorkspaceId(
      candidates.map((candidate) => candidate.workspaceId),
      workspacesById,
    );
    candidateRootByWorkspaceId.set(workspace.workspaceId, owner);
  }

  const resolvedRoots = new Map<string, string | undefined>();
  for (const workspace of workspaces) {
    const candidateRootId = candidateRootByWorkspaceId.get(workspace.workspaceId);
    if (!candidateRootId) {
      resolvedRoots.set(workspace.workspaceId, undefined);
      continue;
    }
    const reciprocalRootId = candidateRootByWorkspaceId.get(candidateRootId);
    if (reciprocalRootId === workspace.workspaceId) {
      const primaryId = pickPreferredWorkspaceId(
        [workspace.workspaceId, candidateRootId],
        workspacesById,
      );
      resolvedRoots.set(
        workspace.workspaceId,
        primaryId === workspace.workspaceId ? undefined : primaryId,
      );
      continue;
    }
    resolvedRoots.set(workspace.workspaceId, candidateRootId);
  }

  return resolvedRoots;
}

function pickPreferredWorkspaceId(
  workspaceIds: readonly string[],
  workspacesById: ReadonlyMap<string, WorkspaceCatalogEntry>,
): string | undefined {
  return [...workspaceIds]
    .filter((workspaceId, index, values) => values.indexOf(workspaceId) === index)
    .sort((left, right) => {
      const leftWorkspace = workspacesById.get(left);
      const rightWorkspace = workspacesById.get(right);
      const leftSortOrder = leftWorkspace?.sortOrder ?? Number.MAX_SAFE_INTEGER;
      const rightSortOrder = rightWorkspace?.sortOrder ?? Number.MAX_SAFE_INTEGER;
      if (leftSortOrder !== rightSortOrder) {
        return leftSortOrder - rightSortOrder;
      }
      const leftLastOpenedAt = leftWorkspace?.lastOpenedAt ?? "";
      const rightLastOpenedAt = rightWorkspace?.lastOpenedAt ?? "";
      if (leftLastOpenedAt !== rightLastOpenedAt) {
        return leftLastOpenedAt.localeCompare(rightLastOpenedAt);
      }
      const leftPath = workspacesById.get(left)?.path ?? left;
      const rightPath = workspacesById.get(right)?.path ?? right;
      if (leftPath.length !== rightPath.length) {
        return leftPath.length - rightPath.length;
      }
      return leftPath.localeCompare(rightPath);
    })[0];
}

function linkedWorktreeBranchName(
  workspace: WorkspaceCatalogEntry,
  worktrees: readonly WorktreeCatalogEntry[],
  rootWorkspaceId: string,
): string | undefined {
  return worktrees.find(
    (worktree) =>
      worktree.kind === "linked" &&
      worktree.path === workspace.path &&
      worktree.workspaceId === rootWorkspaceId,
  )?.branchName;
}

function buildSessionRecord(
  session: SessionCatalogEntry,
  transcriptCache: Map<string, readonly TranscriptMessage[]>,
  runningSinceBySession: Map<string, string>,
  sessionConfigBySession: Map<string, SessionConfig>,
  lastViewedAtBySession: Map<string, string>,
  pinnedAtBySession: Map<string, string>,
): SessionRecord {
  const key = sessionKey(session.sessionRef);
  const transcript = transcriptCache.get(key) ?? [];
  const preview = previewFromTranscript(transcript) ?? session.previewSnippet ?? session.title;
  const lastViewedAt = lastViewedAtBySession.get(key);
  const pinnedAt = pinnedAtBySession.get(key);
  return {
    id: session.sessionRef.sessionId,
    title: session.title,
    updatedAt: session.updatedAt,
    pinnedAt,
    lastViewedAt,
    archivedAt: session.archivedAt,
    preview,
    status: session.status,
    runningSince: runningSinceBySession.get(key),
    hasUnseenUpdate: hasUnseenSessionUpdate(
      session.status,
      session.updatedAt,
      lastViewedAt,
      transcript,
    ),
    config: sessionConfigBySession.get(key),
  };
}

export function hasUnseenSessionUpdate(
  status: SessionStatus,
  updatedAt: string,
  lastViewedAt: string | undefined,
  transcript: readonly TranscriptMessage[],
): boolean {
  if (status === "running" || status === "stopping" || !lastViewedAt) {
    return false;
  }

  const activityAt = latestSessionActivityAt(updatedAt, transcript);
  return activityAt > lastViewedAt;
}

export function latestSessionActivityAt(
  updatedAt: string,
  transcript: readonly TranscriptMessage[],
): string {
  let latest = updatedAt;
  for (const item of transcript) {
    if (item.createdAt > latest) {
      latest = item.createdAt;
    }
  }
  return latest;
}

export function toSessionRef(target: WorkspaceSessionTarget): SessionRef {
  return {
    workspaceId: target.workspaceId,
    sessionId: target.sessionId,
  };
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
    ...(attachments?.length
      ? { attachments: attachments.map((attachment) => ({ ...attachment })) }
      : {}),
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

export function cloneComposerAttachment(attachment: ComposerAttachment): ComposerAttachment {
  if (attachment.kind === "file") {
    return { ...attachment };
  }
  return {
    ...attachment,
    kind: "image",
  };
}

export function cloneComposerAttachments(
  attachments: readonly ComposerAttachment[],
): ComposerAttachment[] {
  return attachments.flatMap((attachment) => {
    const normalized = normalizeComposerAttachment(
      attachment as unknown as Record<string, unknown>,
    );
    return normalized ? [normalized] : [];
  });
}

export function toSessionAttachments(
  attachments: readonly ComposerAttachment[],
): SessionAttachment[] {
  return attachments.map((attachment) =>
    attachment.kind === "image"
      ? toImageAttachmentPayload(attachment)
      : toFileAttachmentPayload(attachment),
  );
}

export function toSessionQueuedMessages(
  messages: readonly QueuedComposerMessage[],
): SessionQueuedMessage[] {
  return messages.map((message) => ({
    id: message.id,
    mode: message.mode,
    text: message.text,
    ...(message.attachments.length > 0
      ? {
          attachments: toSessionAttachments(message.attachments),
        }
      : {}),
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
  }));
}

export function mergeQueuedComposerMessages(
  previous: readonly QueuedComposerMessage[] | undefined,
  next: readonly SessionQueuedMessage[] | undefined,
): QueuedComposerMessage[] {
  if (!next || next.length === 0) {
    return [];
  }

  const previousById = new Map((previous ?? []).map((message) => [message.id, message]));
  return next.map((message) => {
    const existing = previousById.get(message.id);
    return {
      id: message.id,
      mode: message.mode,
      text: message.text,
      attachments: mergeQueuedComposerAttachments(
        existing?.attachments,
        message.attachments,
        message.id,
      ),
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
    };
  });
}

export function toTranscriptAttachments(
  attachments: readonly ComposerAttachment[],
): NonNullable<Extract<TranscriptMessage, { kind: "message" }>["attachments"]> {
  return attachments.map((attachment) =>
    attachment.kind === "image"
      ? toImageAttachmentPayload(attachment)
      : toFileAttachmentPayload(attachment),
  );
}

function toImageAttachmentPayload({
  data,
  mimeType,
  name,
}: Extract<ComposerAttachment, { readonly kind: "image" }>) {
  return {
    kind: "image" as const,
    data,
    mimeType,
    name,
  };
}

function toFileAttachmentPayload({
  fsPath,
  mimeType,
  name,
  sizeBytes,
}: Extract<ComposerAttachment, { readonly kind: "file" }>) {
  return {
    kind: "file" as const,
    fsPath,
    mimeType,
    name,
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
  };
}

function mergeQueuedComposerAttachments(
  previous: readonly ComposerAttachment[] | undefined,
  next: readonly SessionAttachment[] | undefined,
  messageId: string,
): ComposerAttachment[] {
  if (!next || next.length === 0) {
    return [];
  }

  return next.map((attachment, index) => {
    const existing = previous?.[index];
    if (
      existing &&
      existing.kind === attachment.kind &&
      existing.name === attachment.name &&
      existing.mimeType === attachment.mimeType
    ) {
      if (
        existing.kind === "image" &&
        attachment.kind === "image" &&
        existing.data === attachment.data
      ) {
        return existing;
      }
      if (
        existing.kind === "file" &&
        attachment.kind === "file" &&
        existing.fsPath === attachment.fsPath &&
        existing.sizeBytes === attachment.sizeBytes
      ) {
        return existing;
      }
    }

    if (attachment.kind === "image") {
      return {
        id: `${messageId}:image:${index}:${randomUUID()}`,
        kind: "image",
        name: attachment.name ?? `Image ${index + 1}`,
        mimeType: attachment.mimeType,
        data: attachment.data,
      } satisfies ComposerAttachment;
    }

    return {
      id: `${messageId}:file:${index}:${randomUUID()}`,
      kind: "file",
      name: attachment.name,
      mimeType: attachment.mimeType,
      fsPath: attachment.fsPath,
      ...(attachment.sizeBytes !== undefined ? { sizeBytes: attachment.sizeBytes } : {}),
    } satisfies ComposerAttachment;
  });
}

function normalizeComposerAttachment(value: Record<string, unknown>): ComposerAttachment | null {
  if (
    (value.kind === "image" || value.kind === undefined) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.mimeType === "string" &&
    typeof value.data === "string"
  ) {
    return {
      id: value.id,
      kind: "image",
      name: value.name,
      mimeType: value.mimeType,
      data: value.data,
    };
  }

  if (
    value.kind === "file" &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.mimeType === "string" &&
    typeof value.fsPath === "string"
  ) {
    return {
      id: value.id,
      kind: "file",
      name: value.name,
      mimeType: value.mimeType,
      fsPath: value.fsPath,
      ...(typeof value.sizeBytes === "number" ? { sizeBytes: value.sizeBytes } : {}),
    };
  }

  return null;
}

export function makeActivityItem(
  label: string,
  options: Pick<
    Extract<TranscriptMessage, { kind: "activity" }>,
    "detail" | "metadata" | "tone"
  > = {},
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
  options: Partial<
    Pick<Extract<TranscriptMessage, { kind: "summary" }>, "metadata" | "presentation">
  > = {},
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
  options: Pick<
    Extract<TranscriptMessage, { kind: "tool" }>,
    "detail" | "metadata" | "input" | "output"
  > = {},
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

export function previewFromTranscript(
  transcript: readonly TranscriptMessage[],
): string | undefined {
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
