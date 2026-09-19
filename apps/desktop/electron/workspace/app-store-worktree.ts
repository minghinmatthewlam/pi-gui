import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { WorktreeCatalogEntry } from "@pi-gui/catalogs";
import type { WorkspaceRef } from "@pi-gui/session-driver";
import type {
  CreateWorktreeInput,
  DesktopAppState,
  ForkThreadInput,
  RemoveWorktreeInput,
  StartThreadInput,
} from "../../contracts/desktop-state";
import type { CreateWorktreeOptions } from "../platform/worktrees/worktree-manager";
import type { WorkspaceOwnerHost } from "./app-store-workspace";
import { NEW_THREAD_PLACEHOLDER_TITLE } from "../conversation/thread-title-constants";

/* ── Public methods ─────────────────────────────────────── */

export async function createWorktree(
  store: WorkspaceOwnerHost,
  input: CreateWorktreeInput,
): Promise<DesktopAppState> {
  await store.initialize();
  const rootWorkspace = store.workspaceRefFromState(input.workspaceId);
  if (!rootWorkspace) {
    return store.withError(`Unknown workspace: ${input.workspaceId}`);
  }

  return store.withErrorHandling(async () => {
    const createOptions = buildWorktreeOptions(
      store,
      rootWorkspace,
      input.fromSessionWorkspaceId,
      input.fromSessionId,
    );
    const created = await store.worktreeManager.createWorktree(rootWorkspace, createOptions);
    try {
      const synced = await store.driver.syncWorkspace(created.path, created.displayName);
      if (input.fromSessionId) {
        await store.driver.createSession(synced.workspace, {
          title: sessionTitleForWorktree(
            store,
            input.fromSessionWorkspaceId ?? input.workspaceId,
            input.fromSessionId,
          ),
        });
      }
    } catch (error) {
      await rollbackCreatedWorktree(store, rootWorkspace, createOptions);
      throw error;
    }

    return store.refreshState({
      selectedWorkspaceId: created.path,
      selectedSessionId: "",
      composerDraft: "",
      clearLastError: true,
      refreshWorktrees: false,
    });
  });
}

export async function removeWorktree(
  store: WorkspaceOwnerHost,
  input: RemoveWorktreeInput,
): Promise<DesktopAppState> {
  await store.initialize();
  const rootWorkspace = store.workspaceRefFromState(input.workspaceId);
  if (!rootWorkspace) {
    return store.withError(`Unknown workspace: ${input.workspaceId}`);
  }

  return store.withErrorHandling(async () => {
    const worktree = await store.catalogStore.worktrees.getWorktree(input.worktreeId);
    await store.worktreeManager.removeWorktree(rootWorkspace, input.worktreeId);
    if (worktree?.path) {
      await store.driver.removeWorkspace(worktree.path).catch(() => undefined);
    }

    const state = store.workspaceState();
    const selectedWorkspaceId =
      state.selectedWorkspaceId === input.worktreeId
        ? input.workspaceId
        : state.selectedWorkspaceId;
    const selectedSessionId =
      state.selectedWorkspaceId === input.worktreeId ? "" : state.selectedSessionId;
    return store.refreshState({
      selectedWorkspaceId,
      selectedSessionId,
      composerDraft: "",
      clearLastError: true,
      refreshWorktrees: false,
    });
  });
}

export async function startThread(
  store: WorkspaceOwnerHost,
  input: StartThreadInput,
): Promise<DesktopAppState> {
  await store.initialize();
  const rootWorkspace = store.workspaceRefFromState(input.rootWorkspaceId);
  if (!rootWorkspace) {
    return store.withError(`Unknown workspace: ${input.rootWorkspaceId}`);
  }

  return store.withErrorHandling(async () => {
    let targetWorkspace = rootWorkspace;
    let rollbackWorktree: (() => Promise<void>) | undefined;
    if (input.environment === "worktree") {
      const worktreeOptions = buildWorktreeOptions(
        store,
        rootWorkspace,
        undefined,
        undefined,
        input.prompt,
      );
      const created = await store.worktreeManager.createWorktree(rootWorkspace, worktreeOptions);
      rollbackWorktree = () => rollbackCreatedWorktree(store, rootWorkspace, worktreeOptions);
      try {
        const synced = await store.driver.syncWorkspace(created.path, created.displayName);
        targetWorkspace = synced.workspace;
      } catch (error) {
        await rollbackWorktree();
        throw error;
      }
    }

    const prompt = input.prompt?.trim() ?? "";
    const attachments = input.attachments ?? [];
    let session: Awaited<ReturnType<typeof store.driver.createSession>>;
    let initialModel: { provider: string; modelId: string } | undefined;
    let initialThinkingLevel: string | undefined;
    try {
      const createOptions =
        (await store.buildCreateSessionOptions(targetWorkspace.workspaceId)) ?? {};
      initialModel =
        input.provider && input.modelId
          ? { provider: input.provider, modelId: input.modelId }
          : createOptions.initialModel;
      initialThinkingLevel = input.thinkingLevel ?? createOptions.initialThinkingLevel;
      session = await store.driver.createSession(targetWorkspace, {
        ...createOptions,
        title: NEW_THREAD_PLACEHOLDER_TITLE,
        ...(initialModel ? { initialModel } : {}),
        ...(initialThinkingLevel ? { initialThinkingLevel } : {}),
      });
    } catch (error) {
      if (rollbackWorktree) {
        await rollbackWorktree();
      }
      throw error;
    }
    store.seedSession(session);
    const autoTitleAbortController = new AbortController();
    const pendingAutoTitle = {
      requestToken: randomUUID(),
      cancel: () => autoTitleAbortController.abort(),
    };
    store.setPendingAutoTitle(session.ref, pendingAutoTitle);

    // Navigate to thread view immediately so streaming deltas render live.
    // Set selection eagerly so that any subscription replay events
    // (fired by ensureSessionReady inside refreshState) read the new
    // session ID instead of the stale one.
    store.setActiveSession(session.ref);
    const state = await store.refreshState({
      selectedWorkspaceId: session.ref.workspaceId,
      selectedSessionId: session.ref.sessionId,
      composerDraft: "",
      clearLastError: true,
      refreshWorktrees: input.environment === "worktree",
      activeView: "threads",
    });

    // Fire message in background — assistantDelta events flow through
    // handleSessionEvent → emit() and update React while on the thread view
    if (prompt || attachments.length > 0) {
      void store
        .sendMessageToSession(session.ref, prompt, attachments, {
          rollbackOptimisticMessageOnError: false,
        })
        .catch((error) => {
          void store.withError(error).catch((error: unknown) => {
            console.error("[app-store-worktree] withError failed", error);
          });
        });
    }
    if (prompt) {
      void generateAndApplyAutoTitle(store, session.ref, targetWorkspace, {
        prompt,
        requestToken: pendingAutoTitle.requestToken,
        signal: autoTitleAbortController.signal,
        ...(initialModel ? { model: initialModel } : {}),
        ...(initialThinkingLevel ? { thinkingLevel: initialThinkingLevel } : {}),
      }).catch((error: unknown) => {
        console.error("[app-store-worktree] generateAndApplyAutoTitle failed", error);
      });
    } else {
      store.clearPendingAutoTitle(session.ref);
    }

    return state;
  });
}

export async function forkThread(
  store: WorkspaceOwnerHost,
  input: ForkThreadInput,
): Promise<DesktopAppState> {
  await store.initialize();
  const sourceWorkspace = store.workspaceRefFromState(input.sourceWorkspaceId);
  if (!sourceWorkspace) {
    return store.withError(`Unknown workspace: ${input.sourceWorkspaceId}`);
  }

  return store.withErrorHandling(async () => {
    const sourceRef = { workspaceId: input.sourceWorkspaceId, sessionId: input.sourceSessionId };
    const forkOptions = {
      ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
      ...(input.sourceMessageIndex !== undefined
        ? { sourceMessageIndex: input.sourceMessageIndex }
        : {}),
      ...(input.userMessageIndex !== undefined ? { userMessageIndex: input.userMessageIndex } : {}),
      ...(input.position ? { position: input.position } : {}),
    };
    await store.driver.validateForkSession(sourceRef, {
      targetWorkspace: sourceWorkspace,
      ...forkOptions,
    });

    let targetWorkspace = sourceWorkspace;
    let rollbackWorktree: (() => Promise<void>) | undefined;
    if (input.environment === "worktree") {
      const rootWorkspace = store.workspaceRefFromState(input.rootWorkspaceId);
      if (!rootWorkspace) {
        return store.withError(`Unknown workspace: ${input.rootWorkspaceId}`);
      }
      const worktreeOptions = buildWorktreeOptions(
        store,
        rootWorkspace,
        input.sourceWorkspaceId,
        input.sourceSessionId,
      );
      const created = await store.worktreeManager.createWorktree(rootWorkspace, worktreeOptions);
      rollbackWorktree = () => rollbackCreatedWorktree(store, rootWorkspace, worktreeOptions);
      try {
        const synced = await store.driver.syncWorkspace(created.path, created.displayName);
        targetWorkspace = synced.workspace;
      } catch (error) {
        await rollbackWorktree();
        throw error;
      }
    }

    let session: Awaited<ReturnType<typeof store.driver.forkSession>>["snapshot"];
    let selectedText: Awaited<ReturnType<typeof store.driver.forkSession>>["selectedText"];
    try {
      ({ snapshot: session, selectedText } = await store.driver.forkSession(sourceRef, {
        targetWorkspace,
        ...forkOptions,
      }));
    } catch (error) {
      if (rollbackWorktree) {
        await rollbackWorktree();
      }
      throw error;
    }
    store.updateSessionConfig(session.ref, session.config);

    // Set selection eagerly so subscription replay events read the new session ID.
    store.setActiveSession(session.ref);

    // Load the branched history transcript from the driver before publishing state.
    await store.reloadTranscriptFromDriver(session.ref);

    return store.refreshState({
      selectedWorkspaceId: session.ref.workspaceId,
      selectedSessionId: session.ref.sessionId,
      composerDraft: selectedText ?? "",
      composerDraftSyncSource: "selection",
      clearLastError: true,
      refreshWorktrees: input.environment === "worktree",
      activeView: "threads",
    });
  });
}

export async function syncAndListWorktrees(
  store: WorkspaceOwnerHost,
  workspaces: readonly {
    workspaceId: string;
    path: string;
    displayName: string;
    sortOrder: number;
    lastOpenedAt: string;
  }[],
): Promise<readonly WorktreeCatalogEntry[]> {
  const existing = await store.catalogStore.worktrees.listWorktrees();
  const existingPrimaryByWorkspaceId = new Set(
    existing.worktrees
      .filter((worktree) => worktree.kind === "primary")
      .map((worktree) => worktree.workspaceId),
  );
  const inspected = await Promise.all(
    workspaces.map(async (workspace) => {
      try {
        const inspection = await store.worktreeManager.inspectWorkspace(workspace);
        return {
          workspace,
          ...inspection,
        };
      } catch {
        return {
          workspace,
          canonicalPath: workspace.path,
          commonDir: `workspace:${workspace.workspaceId}`,
        };
      }
    }),
  );
  const groups = new Map<string, typeof inspected>();

  for (const entry of inspected) {
    const group = groups.get(entry.commonDir);
    if (group) {
      group.push(entry);
    } else {
      groups.set(entry.commonDir, [entry]);
    }
  }

  const syncRoots = [...groups.values()]
    .map(
      (group) =>
        [...group].sort((left, right) => {
          const leftIsExistingPrimary = existingPrimaryByWorkspaceId.has(
            left.workspace.workspaceId,
          );
          const rightIsExistingPrimary = existingPrimaryByWorkspaceId.has(
            right.workspace.workspaceId,
          );
          if (leftIsExistingPrimary !== rightIsExistingPrimary) {
            return leftIsExistingPrimary ? -1 : 1;
          }
          if (left.workspace.sortOrder !== right.workspace.sortOrder) {
            return left.workspace.sortOrder - right.workspace.sortOrder;
          }
          if (left.workspace.lastOpenedAt !== right.workspace.lastOpenedAt) {
            return left.workspace.lastOpenedAt.localeCompare(right.workspace.lastOpenedAt);
          }
          if (left.canonicalPath.length !== right.canonicalPath.length) {
            return left.canonicalPath.length - right.canonicalPath.length;
          }
          return left.workspace.displayName.localeCompare(right.workspace.displayName);
        })[0],
    )
    .filter((entry): entry is (typeof inspected)[number] => Boolean(entry));
  const syncRootWorkspaceIds = new Set(syncRoots.map((entry) => entry.workspace.workspaceId));
  const staleWorkspaceIds = inspected
    .map((entry) => entry.workspace.workspaceId)
    .filter((workspaceId) => !syncRootWorkspaceIds.has(workspaceId));

  await Promise.all(
    syncRoots.map((entry) =>
      store.worktreeManager
        .refreshWorktrees({
          workspaceId: entry.workspace.workspaceId,
          path: entry.workspace.path,
          displayName: entry.workspace.displayName,
        })
        .catch(() => undefined),
    ),
  );
  await Promise.all(
    staleWorkspaceIds.map((workspaceId) =>
      store.catalogStore.worktrees
        .replaceWorkspaceWorktrees(workspaceId, [])
        .catch(() => undefined),
    ),
  );

  return (await store.catalogStore.worktrees.listWorktrees()).worktrees;
}

/**
 * Build default worktree options — used both by `createWorktree` and `startThread`
 * (which lives in the main store).
 */
function buildWorktreeOptions(
  store: WorkspaceOwnerHost,
  workspace: WorkspaceRef,
  fromSessionWorkspaceId?: string,
  fromSessionId?: string,
  titleHint?: string,
): CreateWorktreeOptions {
  const sessionTitle =
    fromSessionId && fromSessionWorkspaceId
      ? sessionTitleForWorktree(store, fromSessionWorkspaceId, fromSessionId)
      : undefined;
  const preferredTitle = shortDisplayTitle(titleHint?.trim() || sessionTitle);
  const suffix = shortUniqueSuffix();
  const baseLabel = preferredTitle ? clampSlug(slugify(preferredTitle), 18) : "wt";
  const folderName = `${baseLabel}-${suffix}`;
  const repoName = clampSlug(slugify(basename(workspace.path) || "repo"), 20);
  const displayName = preferredTitle || `Worktree ${suffix}`;
  return {
    path: join(store.worktreeRoot, repoName, folderName),
    displayName,
    branchName: `pi/${folderName}`,
    startPoint: "HEAD",
  };
}

/**
 * Startup reconcile pass (fix: worktree/branch GC). Only the active profile's
 * user-data-namespaced root is eligible for automatic collection. Cataloged
 * worktrees under the legacy shared ~/.pi/worktrees root remain usable, but are
 * intentionally never adopted or pruned because their profile ownership is
 * ambiguous.
 */
export async function reconcileWorktrees(store: WorkspaceOwnerHost): Promise<void> {
  try {
    const referencedPaths = new Set<string>();
    const catalog = await store.catalogStore.worktrees.listWorktrees();
    for (const worktree of catalog.worktrees) {
      if (worktree.path) {
        referencedPaths.add(await canonicalWorktreePath(worktree.path));
      }
    }
    for (const workspace of store.workspaceState().workspaces) {
      referencedPaths.add(await canonicalWorktreePath(workspace.path));
    }
    await store.worktreeManager.pruneOrphanedWorktrees({
      worktreeRoot: store.worktreeRoot,
      referencedPaths,
    });
  } catch (error) {
    console.warn(
      `pi-gui: worktree reconcile skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function canonicalWorktreePath(pathValue: string): Promise<string> {
  const resolved = resolve(pathValue);
  try {
    return await realpath(resolved);
  } catch {
    return resolved;
  }
}

async function rollbackCreatedWorktree(
  store: WorkspaceOwnerHost,
  workspace: WorkspaceRef,
  options: CreateWorktreeOptions,
): Promise<void> {
  await store.worktreeManager
    .destroyWorktree(workspace, {
      path: options.path,
      ...(options.branchName ? { branchName: options.branchName } : {}),
    })
    .catch(() => undefined);
}

/* ── Private helpers ─────────────────────────────────────── */

async function generateAndApplyAutoTitle(
  store: WorkspaceOwnerHost,
  sessionRef: { workspaceId: string; sessionId: string },
  workspace: WorkspaceRef,
  options: {
    readonly prompt: string;
    readonly requestToken: string;
    readonly signal: AbortSignal;
    readonly model?: { provider: string; modelId: string };
    readonly thinkingLevel?: string;
  },
): Promise<void> {
  const clearMatchingPendingTitle = () => {
    const pendingAutoTitle = store.getPendingAutoTitle(sessionRef);
    if (pendingAutoTitle?.requestToken === options.requestToken) {
      store.clearPendingAutoTitle(sessionRef);
    }
  };

  try {
    const generatedTitle = await store.driver.generateThreadTitle(workspace, {
      prompt: options.prompt,
      signal: options.signal,
      ...(options.model ? { model: options.model } : {}),
      ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
    });
    if (!generatedTitle) {
      // Generation succeeded but produced nothing usable — the thread silently
      // keeps its placeholder title, so make the empty result visible.
      console.warn(
        `[app-store] auto-title skipped for ${sessionRef.workspaceId}:${sessionRef.sessionId}: generation returned empty`,
      );
      clearMatchingPendingTitle();
      return;
    }
    const pendingAutoTitle = store.getPendingAutoTitle(sessionRef);
    const currentSession = store.sessionFromState(sessionRef);
    if (
      !pendingAutoTitle ||
      pendingAutoTitle.requestToken !== options.requestToken ||
      currentSession?.title !== NEW_THREAD_PLACEHOLDER_TITLE
    ) {
      // Expected when the user renamed first; anything else here means a
      // generated title was dropped — make the reason visible.
      console.warn(
        `[app-store] auto-title skipped for ${sessionRef.workspaceId}:${sessionRef.sessionId}: ` +
          `pending=${Boolean(pendingAutoTitle)} tokenMatch=${pendingAutoTitle?.requestToken === options.requestToken} ` +
          `title=${JSON.stringify(currentSession?.title)}`,
      );
      return;
    }

    store.clearPendingAutoTitle(sessionRef);
    await store.driver.renameSession(sessionRef, generatedTitle);
    await store.refreshState({ clearLastError: true });
  } catch (error) {
    // Auto-title is best-effort, but a swallowed rename failure must at least
    // be visible — the thread silently keeps its placeholder title otherwise.
    console.warn(
      `[app-store] auto-title failed for ${sessionRef.workspaceId}:${sessionRef.sessionId}:`,
      error,
    );
    clearMatchingPendingTitle();
  }
}

function sessionTitleForWorktree(
  store: WorkspaceOwnerHost,
  workspaceId: string,
  sessionId: string,
): string | undefined {
  return store
    .workspaceState()
    .workspaces.find((workspace) => workspace.id === workspaceId)
    ?.sessions.find((session) => session.id === sessionId)
    ?.title.trim();
}

function slugify(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "worktree";
}

function clampSlug(value: string, limit = 28): string {
  if (value.length <= limit) {
    return value;
  }
  const trimmed = value.slice(0, limit).replace(/-+$/g, "");
  return trimmed || "worktree";
}

function shortUniqueSuffix(): string {
  return randomUUID().slice(0, 6);
}

function shortDisplayTitle(value: string | undefined, limit = 44): string | undefined {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length > limit ? `${trimmed.slice(0, limit - 3).trimEnd()}...` : trimmed;
}
