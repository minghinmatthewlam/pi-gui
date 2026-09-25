import { sessionKey } from "@pi-gui/session-driver";
import type { PiSdkDriver } from "@pi-gui/pi-sdk-driver";
import type { JsonCatalogStore } from "@pi-gui/catalogs/node";
import type {
  CreateSessionOptions,
  SessionConfig,
  SessionRef,
  SessionSnapshot,
  WorkspaceRef,
} from "@pi-gui/session-driver";
import type { RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import type {
  CreateSessionInput,
  CreateWorktreeInput,
  DesktopAppState,
  ForkThreadInput,
  RemoveWorktreeInput,
  StartThreadInput,
  ComposerAttachment,
  WorkspaceSessionTarget,
} from "../../contracts/desktop-state";
import { toSessionRef } from "../application/app-store-utils";
import type { RefreshStateOptions } from "../application/refresh-state-options";
import type { GitWorktreeManager } from "../platform/worktrees/worktree-manager";
import { NEW_THREAD_PLACEHOLDER_TITLE } from "../conversation/thread-title-constants";
import type { PendingAutoTitle } from "../conversation/session-state-map";
import * as worktree from "./app-store-worktree";

export interface WorkspaceStateView {
  readonly selectedWorkspaceId?: string;
  readonly selectedSessionId?: string;
  readonly workspaces: DesktopAppState["workspaces"];
}

type WorkspaceDriver = Pick<
  PiSdkDriver,
  | "archiveSession"
  | "createSession"
  | "forkSession"
  | "generateThreadTitle"
  | "removeWorkspace"
  | "renameSession"
  | "renameWorkspace"
  | "syncWorkspace"
  | "unarchiveSession"
  | "validateForkSession"
>;

export interface WorkspaceOwnerHost {
  readonly driver: WorkspaceDriver;
  readonly catalogStore: JsonCatalogStore;
  readonly worktreeManager: GitWorktreeManager;
  readonly worktreeRoot: string;
  readonly isAppWorktreePath: (path: string) => Promise<boolean>;
  setRuntimeSnapshot(workspaceId: string, snapshot: RuntimeSnapshot): void;
  refreshRuntime(workspace: WorkspaceRef): Promise<RuntimeSnapshot>;
  initialize(): Promise<void>;
  workspaceState(): WorkspaceStateView;
  setActiveSession(sessionRef: SessionRef): void;
  seedSession(snapshot: SessionSnapshot): void;
  unpinSession(sessionRef: SessionRef): void;
  refreshState(options?: RefreshStateOptions): Promise<DesktopAppState>;
  emit(): DesktopAppState;
  withError(error: unknown): Promise<DesktopAppState>;
  withErrorHandling(fn: () => Promise<DesktopAppState>): Promise<DesktopAppState>;
  selectSessionFast(target: WorkspaceSessionTarget): Promise<DesktopAppState>;
  workspaceRefFromState(workspaceId: string): WorkspaceRef | undefined;
  selectedSessionRef(): SessionRef | undefined;
  sessionFromState(
    sessionRef: SessionRef,
  ):
    | { archivedAt?: string; updatedAt: string; title: string; status: string; preview?: string }
    | undefined;
  ensureSessionReady(sessionRef: SessionRef): Promise<SessionSnapshot | undefined>;
  cancelPendingDialogsForSession(sessionRef: SessionRef): Promise<void>;
  clearPendingAutoTitle(sessionRef: SessionRef): void;
  updateSessionConfig(sessionRef: SessionRef, config: SessionConfig | undefined): void;
  buildCreateSessionOptions(workspaceId: string): Promise<CreateSessionOptions | undefined>;
  reloadTranscriptFromDriver(sessionRef: SessionRef): Promise<void>;
  setPendingAutoTitle(sessionRef: SessionRef, pending: PendingAutoTitle): void;
  getPendingAutoTitle(sessionRef: SessionRef): PendingAutoTitle | undefined;
  sendMessageToSession(
    sessionRef: SessionRef,
    text: string,
    attachments: readonly ComposerAttachment[],
    options?: { readonly rollbackOptimisticMessageOnError?: boolean },
  ): Promise<void>;
}

export interface WorkspaceOwner {
  addWorkspace(path: string): Promise<DesktopAppState>;
  renameWorkspace(workspaceId: string, displayName: string): Promise<DesktopAppState>;
  removeWorkspace(workspaceId: string): Promise<DesktopAppState>;
  selectWorkspace(workspaceId: string): Promise<DesktopAppState>;
  selectSession(target: WorkspaceSessionTarget): Promise<DesktopAppState>;
  renameSession(target: WorkspaceSessionTarget, title: string): Promise<DesktopAppState>;
  archiveSession(target: WorkspaceSessionTarget): Promise<DesktopAppState>;
  unarchiveSession(target: WorkspaceSessionTarget): Promise<DesktopAppState>;
  createSession(input: CreateSessionInput): Promise<DesktopAppState>;
  syncCurrentWorkspace(): Promise<DesktopAppState>;
  createWorktree(input: CreateWorktreeInput): Promise<DesktopAppState>;
  removeWorktree(input: RemoveWorktreeInput): Promise<DesktopAppState>;
  startThread(input: StartThreadInput): Promise<DesktopAppState>;
  forkThread(input: ForkThreadInput): Promise<DesktopAppState>;
  reconcileWorktrees(): Promise<void>;
  syncAndListWorktrees(
    workspaces: Parameters<typeof worktree.syncAndListWorktrees>[1],
  ): ReturnType<typeof worktree.syncAndListWorktrees>;
}

export function createWorkspaceOwner(store: WorkspaceOwnerHost): WorkspaceOwner {
  return {
    addWorkspace: (path) => addWorkspace(store, path),
    renameWorkspace: (workspaceId, displayName) => renameWorkspace(store, workspaceId, displayName),
    removeWorkspace: (workspaceId) => removeWorkspace(store, workspaceId),
    selectWorkspace: (workspaceId) => selectWorkspace(store, workspaceId),
    selectSession: (target) => selectSession(store, target),
    renameSession: (target, title) => renameSession(store, target, title),
    archiveSession: (target) => archiveSession(store, target),
    unarchiveSession: (target) => unarchiveSession(store, target),
    createSession: (input) => createSession(store, input),
    syncCurrentWorkspace: () => syncCurrentWorkspace(store),
    createWorktree: (input) => worktree.createWorktree(store, input),
    removeWorktree: (input) => worktree.removeWorktree(store, input),
    startThread: (input) => worktree.startThread(store, input),
    forkThread: (input) => worktree.forkThread(store, input),
    reconcileWorktrees: () => worktree.reconcileWorktrees(store),
    syncAndListWorktrees: (workspaces) => worktree.syncAndListWorktrees(store, workspaces),
  };
}

function fallbackSelectionAfterWorkspaceRemoval(
  state: WorkspaceStateView,
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

async function addWorkspace(store: WorkspaceOwnerHost, path: string): Promise<DesktopAppState> {
  await store.initialize();
  const normalizedPath = path.trim();
  if (!normalizedPath) {
    return store.emit();
  }
  const state = store.workspaceState();
  const hadNoWorkspaces = state.workspaces.length === 0;

  const existing = state.workspaces.find((workspace) => workspace.path === normalizedPath);
  if (existing) {
    return syncWorkspace(store, existing.id, {
      selectedWorkspaceId: existing.id,
      selectedSessionId: state.selectedSessionId,
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
    if (hadNoWorkspaces) {
      const snapshot = await store.refreshRuntime(synced.workspace);
      store.setRuntimeSnapshot(synced.workspace.workspaceId, snapshot);
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

async function renameWorkspace(
  store: WorkspaceOwnerHost,
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
    const state = store.workspaceState();
    return store.refreshState({
      selectedWorkspaceId: state.selectedWorkspaceId,
      selectedSessionId: state.selectedSessionId,
      clearLastError: true,
    });
  });
}

async function removeWorkspace(
  store: WorkspaceOwnerHost,
  workspaceId: string,
): Promise<DesktopAppState> {
  await store.initialize();

  return store.withErrorHandling(async () => {
    await store.driver.removeWorkspace(workspaceId);
    return store.refreshState(
      fallbackSelectionAfterWorkspaceRemoval(store.workspaceState(), workspaceId),
    );
  });
}

async function selectWorkspace(
  store: WorkspaceOwnerHost,
  workspaceId: string,
): Promise<DesktopAppState> {
  await store.initialize();
  const state = store.workspaceState();
  const workspace = state.workspaces.find((entry) => entry.id === workspaceId);
  if (!workspace) {
    return store.emit();
  }

  const currentSessionRef = store.selectedSessionRef();
  if (currentSessionRef && currentSessionRef.workspaceId !== workspaceId) {
    await store.cancelPendingDialogsForSession(currentSessionRef);
  }

  return syncWorkspace(store, workspaceId, {
    selectedWorkspaceId: workspaceId,
    selectedSessionId: state.selectedWorkspaceId === workspaceId ? state.selectedSessionId : "",
    clearLastError: true,
    refreshWorktrees: true,
    activeView: "threads",
  });
}

async function selectSession(
  store: WorkspaceOwnerHost,
  target: WorkspaceSessionTarget,
): Promise<DesktopAppState> {
  await store.initialize();
  const currentSessionRef = store.selectedSessionRef();
  if (
    currentSessionRef &&
    (currentSessionRef.workspaceId !== target.workspaceId ||
      currentSessionRef.sessionId !== target.sessionId)
  ) {
    await store.cancelPendingDialogsForSession(currentSessionRef);
  }

  return store.selectSessionFast(target);
}

async function renameSession(
  store: WorkspaceOwnerHost,
  target: WorkspaceSessionTarget,
  title: string,
): Promise<DesktopAppState> {
  await store.initialize();
  const nextTitle = title.trim();
  if (!nextTitle) {
    return store.withError("Thread title cannot be empty.");
  }

  return store.withErrorHandling(async () => {
    const sessionRef = toSessionRef(target);
    if (!store.sessionFromState(sessionRef)) {
      return store.withError(`Unknown session: ${target.workspaceId}:${target.sessionId}`);
    }
    store.clearPendingAutoTitle(sessionRef);
    await store.driver.renameSession(sessionRef, nextTitle);
    const state = store.workspaceState();
    return store.refreshState({
      selectedWorkspaceId: state.selectedWorkspaceId,
      selectedSessionId: state.selectedSessionId,
      clearLastError: true,
    });
  });
}

async function archiveSession(
  store: WorkspaceOwnerHost,
  target: WorkspaceSessionTarget,
): Promise<DesktopAppState> {
  await store.initialize();

  return store.withErrorHandling(async () => {
    const sessionRef = toSessionRef(target);
    store.clearPendingAutoTitle(sessionRef);
    store.unpinSession(sessionRef);
    await store.driver.archiveSession(sessionRef);
    return store.refreshState(selectionAfterArchiving(store.workspaceState(), target));
  });
}

function selectionAfterArchiving(
  state: WorkspaceStateView,
  target: WorkspaceSessionTarget,
): RefreshStateOptions {
  if (
    state.selectedWorkspaceId !== target.workspaceId ||
    state.selectedSessionId !== target.sessionId
  ) {
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
    targetWorkspace.kind === "worktree"
      ? (targetWorkspace.rootWorkspaceId ?? targetWorkspace.id)
      : targetWorkspace.id;
  const rankedCandidates = state.workspaces
    .filter((w) => w.id === rootWorkspaceId || w.rootWorkspaceId === rootWorkspaceId)
    .flatMap((w) =>
      w.sessions
        .filter((s) => s.id !== target.sessionId || w.id !== target.workspaceId)
        .filter((s) => !s.archivedAt)
        .map((s) => ({ workspaceId: w.id, session: s })),
    )
    .sort((left, right) => {
      if (left.workspaceId === target.workspaceId && right.workspaceId !== target.workspaceId)
        return -1;
      if (left.workspaceId !== target.workspaceId && right.workspaceId === target.workspaceId)
        return 1;
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

async function unarchiveSession(
  store: WorkspaceOwnerHost,
  target: WorkspaceSessionTarget,
): Promise<DesktopAppState> {
  await store.initialize();

  return store.withErrorHandling(async () => {
    const sessionRef = toSessionRef(target);
    store.clearPendingAutoTitle(sessionRef);
    await store.driver.unarchiveSession(sessionRef);
    const state = store.workspaceState();
    return store.refreshState({
      selectedWorkspaceId: state.selectedWorkspaceId,
      selectedSessionId:
        state.selectedWorkspaceId === target.workspaceId && !state.selectedSessionId
          ? target.sessionId
          : state.selectedSessionId,
      clearLastError: true,
      activeView: "threads",
    });
  });
}

async function createSession(
  store: WorkspaceOwnerHost,
  input: CreateSessionInput,
): Promise<DesktopAppState> {
  await store.initialize();
  const ws = store.workspaceRefFromState(input.workspaceId);
  if (!ws) {
    return store.withError(`Unknown workspace: ${input.workspaceId}`);
  }

  return store.withErrorHandling(async () => {
    const createOptions = await store.buildCreateSessionOptions(input.workspaceId);
    const snapshot = await store.driver.createSession(ws, {
      ...createOptions,
      title: input.title?.trim() || NEW_THREAD_PLACEHOLDER_TITLE,
    });
    store.seedSession(snapshot);
    store.setActiveSession(snapshot.ref);
    return store.refreshState({
      selectedWorkspaceId: snapshot.ref.workspaceId,
      selectedSessionId: snapshot.ref.sessionId,
      composerDraft: "",
      clearLastError: true,
      activeView: "threads",
    });
  });
}

async function syncCurrentWorkspace(store: WorkspaceOwnerHost): Promise<DesktopAppState> {
  await store.initialize();
  const state = store.workspaceState();
  if (!state.selectedWorkspaceId) {
    return store.refreshState({ clearLastError: true, refreshWorktrees: true });
  }

  return syncWorkspace(store, state.selectedWorkspaceId, {
    selectedWorkspaceId: state.selectedWorkspaceId,
    selectedSessionId: state.selectedSessionId,
    clearLastError: true,
    refreshWorktrees: true,
  });
}

async function syncWorkspace(
  store: WorkspaceOwnerHost,
  workspaceId: string,
  refreshOptions: RefreshStateOptions,
): Promise<DesktopAppState> {
  const workspace = store.workspaceState().workspaces.find((entry) => entry.id === workspaceId);
  if (!workspace) {
    return store.emit();
  }

  return store.withErrorHandling(async () => {
    await store.driver.syncWorkspace(workspace.path, workspace.name);
    return store.refreshState(refreshOptions);
  });
}
