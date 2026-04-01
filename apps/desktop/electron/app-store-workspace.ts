import { sessionKey } from "@pi-gui/pi-sdk-driver";
import type { CreateSessionInput, DesktopAppState, WorkspaceSessionTarget } from "../src/desktop-state";
import { toSessionRef } from "./app-store-utils";
import type { AppStoreInternals, RefreshStateOptions } from "./app-store-internals";

function fallbackSelectionAfterWorkspaceRemoval(
  state: DesktopAppState,
  removedWorkspaceId: string,
): RefreshStateOptions {
  const remaining = state.workspaces.filter((workspace) => workspace.id !== removedWorkspaceId);
  const nextWorkspace = remaining[0];
  return {
    selectedWorkspaceId: nextWorkspace?.id,
    selectedSessionId: nextWorkspace?.sessions[0]?.id,
    composerDraft: "",
    clearLastError: true,
  };
}

export async function addWorkspace(store: AppStoreInternals, path: string): Promise<DesktopAppState> {
  await store.initialize();
  const normalizedPath = path.trim();
  if (!normalizedPath) {
    return store.emit();
  }

  const existing = store.state.workspaces.find((workspace) => workspace.path === normalizedPath);
  if (existing) {
    return syncWorkspace(store, existing.id, {
      selectedWorkspaceId: existing.id,
      selectedSessionId: store.state.selectedSessionId,
      clearLastError: true,
      refreshWorktrees: true,
    });
  }

  return store.withErrorHandling(async () => {
    const synced = await store.driver.syncWorkspace(normalizedPath);
    const firstSession = synced.sessions[0];
    if (firstSession) {
      await store.ensureSessionReady(firstSession.sessionRef);
    }

    return store.refreshState({
      selectedWorkspaceId: synced.workspace.workspaceId,
      selectedSessionId: firstSession?.sessionRef.sessionId ?? "",
      composerDraft: "",
      clearLastError: true,
      refreshWorktrees: true,
    });
  });
}

export async function renameWorkspace(
  store: AppStoreInternals,
  workspaceId: string,
  displayName: string,
): Promise<DesktopAppState> {
  await store.initialize();
  const nextName = displayName.trim();
  if (!nextName) {
    return store.withError("Workspace name cannot be empty.");
  }

  return store.withErrorHandling(async () => {
    await store.driver.renameWorkspace(workspaceId, nextName);
    return store.refreshState({
      selectedWorkspaceId: store.state.selectedWorkspaceId,
      selectedSessionId: store.state.selectedSessionId,
      clearLastError: true,
    });
  });
}

export async function removeWorkspace(store: AppStoreInternals, workspaceId: string): Promise<DesktopAppState> {
  await store.initialize();

  return store.withErrorHandling(async () => {
    await store.driver.removeWorkspace(workspaceId);
    return store.refreshState(fallbackSelectionAfterWorkspaceRemoval(store.state, workspaceId));
  });
}

export async function selectWorkspace(store: AppStoreInternals, workspaceId: string): Promise<DesktopAppState> {
  await store.initialize();
  const workspace = store.state.workspaces.find((entry) => entry.id === workspaceId);
  if (!workspace) {
    return store.emit();
  }

  const currentSessionRef = store.selectedSessionRef();
  if (currentSessionRef && currentSessionRef.workspaceId !== workspaceId) {
    await store.cancelPendingDialogsForSession(currentSessionRef);
  }

  return syncWorkspace(store, workspaceId, {
    selectedWorkspaceId: workspaceId,
    selectedSessionId: store.state.selectedWorkspaceId === workspaceId ? store.state.selectedSessionId : "",
    clearLastError: true,
    refreshWorktrees: true,
    activeView: "threads",
  });
}

export async function selectSession(store: AppStoreInternals, target: WorkspaceSessionTarget): Promise<DesktopAppState> {
  await store.initialize();
  const currentSessionRef = store.selectedSessionRef();
  if (
    currentSessionRef &&
    (currentSessionRef.workspaceId !== target.workspaceId || currentSessionRef.sessionId !== target.sessionId)
  ) {
    await store.cancelPendingDialogsForSession(currentSessionRef);
  }

  return store.selectSessionFast(target);
}

export async function archiveSession(
  store: AppStoreInternals,
  target: WorkspaceSessionTarget,
): Promise<DesktopAppState> {
  await store.initialize();

  return store.withErrorHandling(async () => {
    await store.driver.archiveSession(toSessionRef(target));
    return store.refreshState(selectionAfterArchiving(store.state, target));
  });
}

function selectionAfterArchiving(state: DesktopAppState, target: WorkspaceSessionTarget): RefreshStateOptions {
  if (state.selectedWorkspaceId !== target.workspaceId || state.selectedSessionId !== target.sessionId) {
    return {
      selectedWorkspaceId: state.selectedWorkspaceId,
      selectedSessionId: state.selectedSessionId,
      clearLastError: true,
      activeView: "threads",
    };
  }

  const targetWorkspace = state.workspaces.find((w) => w.id === target.workspaceId);
  if (!targetWorkspace) {
    return {
      selectedWorkspaceId: state.selectedWorkspaceId,
      selectedSessionId: state.selectedSessionId,
      clearLastError: true,
      activeView: "threads",
    };
  }

  const rootWorkspaceId =
    targetWorkspace.kind === "worktree" ? (targetWorkspace.rootWorkspaceId ?? targetWorkspace.id) : targetWorkspace.id;
  const rankedCandidates = state.workspaces
    .filter((w) => w.id === rootWorkspaceId || w.rootWorkspaceId === rootWorkspaceId)
    .flatMap((w) =>
      w.sessions
        .filter((s) => s.id !== target.sessionId || w.id !== target.workspaceId)
        .filter((s) => !s.archivedAt)
        .map((s) => ({ workspaceId: w.id, session: s })),
    )
    .sort((left, right) => {
      if (left.workspaceId === target.workspaceId && right.workspaceId !== target.workspaceId) return -1;
      if (left.workspaceId !== target.workspaceId && right.workspaceId === target.workspaceId) return 1;
      if (left.session.updatedAt !== right.session.updatedAt) {
        return right.session.updatedAt.localeCompare(left.session.updatedAt);
      }
      return left.session.title.localeCompare(right.session.title);
    });

  const next = rankedCandidates[0];
  return {
    selectedWorkspaceId: next?.workspaceId ?? target.workspaceId,
    selectedSessionId: next?.session.id ?? "",
    clearLastError: true,
    activeView: "threads",
  };
}

export async function unarchiveSession(
  store: AppStoreInternals,
  target: WorkspaceSessionTarget,
): Promise<DesktopAppState> {
  await store.initialize();

  return store.withErrorHandling(async () => {
    await store.driver.unarchiveSession(toSessionRef(target));
    return store.refreshState({
      selectedWorkspaceId: store.state.selectedWorkspaceId,
      selectedSessionId:
        store.state.selectedWorkspaceId === target.workspaceId && !store.state.selectedSessionId
          ? target.sessionId
          : store.state.selectedSessionId,
      clearLastError: true,
      activeView: "threads",
    });
  });
}

export async function createSession(store: AppStoreInternals, input: CreateSessionInput): Promise<DesktopAppState> {
  await store.initialize();
  const ws = store.workspaceRefFromState(input.workspaceId);
  if (!ws) {
    return store.withError(`Unknown workspace: ${input.workspaceId}`);
  }

  return store.withErrorHandling(async () => {
    const createOptions = await store.buildCreateSessionOptions(input.workspaceId);
    const snapshot = await store.driver.createSession(ws, {
      ...createOptions,
      title: input.title?.trim() || "New thread",
    });
    const key = sessionKey(snapshot.ref);
    store.sessionState.transcriptCache.set(key, []);
    store.sessionState.loadedTranscriptKeys.add(key);
    store.updateSessionConfig(snapshot.ref, snapshot.config);
    store.state = {
      ...store.state,
      selectedWorkspaceId: snapshot.ref.workspaceId,
      selectedSessionId: snapshot.ref.sessionId,
    };
    return store.refreshState({
      selectedWorkspaceId: snapshot.ref.workspaceId,
      selectedSessionId: snapshot.ref.sessionId,
      composerDraft: "",
      clearLastError: true,
      activeView: "threads",
    });
  });
}

export async function syncCurrentWorkspace(store: AppStoreInternals): Promise<DesktopAppState> {
  await store.initialize();
  if (!store.state.selectedWorkspaceId) {
    return store.refreshState({ clearLastError: true, refreshWorktrees: true });
  }

  return syncWorkspace(store, store.state.selectedWorkspaceId, {
    selectedWorkspaceId: store.state.selectedWorkspaceId,
    selectedSessionId: store.state.selectedSessionId,
    clearLastError: true,
    refreshWorktrees: true,
  });
}

export async function syncWorkspace(
  store: AppStoreInternals,
  workspaceId: string,
  refreshOptions: RefreshStateOptions,
): Promise<DesktopAppState> {
  const workspace = store.state.workspaces.find((entry) => entry.id === workspaceId);
  if (!workspace) {
    return store.emit();
  }

  return store.withErrorHandling(async () => {
    await store.driver.syncWorkspace(workspace.path, workspace.name);
    return store.refreshState(refreshOptions);
  });
}
