import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { sessionKey } from "@pi-gui/pi-sdk-driver";
import type { WorktreeCatalogEntry } from "@pi-gui/catalogs";
import type { WorkspaceRef } from "@pi-gui/session-driver";
import type { CreateWorktreeInput, DesktopAppState, RemoveWorktreeInput, StartThreadInput } from "../src/desktop-state";
import { sendMessageToSession } from "./app-store-composer";
import type { CreateWorktreeOptions } from "./worktree-manager";
import type { AppStoreInternals } from "./app-store-internals";
import { NEW_THREAD_PLACEHOLDER_TITLE } from "./thread-title-constants";

/* ── Public methods ─────────────────────────────────────── */

export async function createWorktree(store: AppStoreInternals, input: CreateWorktreeInput): Promise<DesktopAppState> {
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
    const synced = await store.driver.syncWorkspace(created.path, created.displayName);
    if (input.fromSessionId) {
      await store.driver.createSession(
        synced.workspace,
        { title: sessionTitleForWorktree(store, input.fromSessionWorkspaceId ?? input.workspaceId, input.fromSessionId) },
      );
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

export async function removeWorktree(store: AppStoreInternals, input: RemoveWorktreeInput): Promise<DesktopAppState> {
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

    const selectedWorkspaceId =
      store.state.selectedWorkspaceId === input.worktreeId ? input.workspaceId : store.state.selectedWorkspaceId;
    const selectedSessionId =
      store.state.selectedWorkspaceId === input.worktreeId ? "" : store.state.selectedSessionId;
    return store.refreshState({
      selectedWorkspaceId,
      selectedSessionId,
      composerDraft: "",
      clearLastError: true,
      refreshWorktrees: false,
    });
  });
}

export async function startThread(store: AppStoreInternals, input: StartThreadInput): Promise<DesktopAppState> {
  await store.initialize();
  const rootWorkspace = store.workspaceRefFromState(input.rootWorkspaceId);
  if (!rootWorkspace) {
    return store.withError(`Unknown workspace: ${input.rootWorkspaceId}`);
  }

  return store.withErrorHandling(async () => {
    let targetWorkspace = rootWorkspace;
    if (input.environment === "worktree") {
      const worktreeOptions = buildWorktreeOptions(store, rootWorkspace, undefined, undefined, input.prompt);
      const created = await store.worktreeManager.createWorktree(rootWorkspace, worktreeOptions);
      const synced = await store.driver.syncWorkspace(created.path, created.displayName);
      targetWorkspace = synced.workspace;
    }

    const prompt = input.prompt?.trim() ?? "";
    const attachments = input.attachments ?? [];
    const createOptions = (await store.buildCreateSessionOptions(targetWorkspace.workspaceId)) ?? {};
    const initialModel =
      input.provider && input.modelId
        ? { provider: input.provider, modelId: input.modelId }
        : createOptions.initialModel;
    const initialThinkingLevel = input.thinkingLevel ?? createOptions.initialThinkingLevel;
    const session = await store.driver.createSession(targetWorkspace, {
      ...createOptions,
      title: NEW_THREAD_PLACEHOLDER_TITLE,
      ...(initialModel ? { initialModel } : {}),
      ...(initialThinkingLevel ? { initialThinkingLevel } : {}),
    });
    const key = sessionKey(session.ref);
    store.sessionState.transcriptCache.set(key, []);
    store.sessionState.loadedTranscriptKeys.add(key);
    store.updateSessionConfig(session.ref, session.config);
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
    store.state = {
      ...store.state,
      selectedWorkspaceId: session.ref.workspaceId,
      selectedSessionId: session.ref.sessionId,
    };
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
      void sendMessageToSession(store, session.ref, prompt, attachments, {
        rollbackOptimisticMessageOnError: false,
      }).catch((error) => {
        void store.withError(error);
      });
    }
    if (prompt) {
      void generateAndApplyAutoTitle(store, session.ref, targetWorkspace, {
        prompt,
        requestToken: pendingAutoTitle.requestToken,
        signal: autoTitleAbortController.signal,
        ...(initialModel ? { model: initialModel } : {}),
        ...(initialThinkingLevel ? { thinkingLevel: initialThinkingLevel } : {}),
      });
    } else {
      store.clearPendingAutoTitle(session.ref);
    }

    return state;
  });
}

export async function syncAndListWorktrees(
  store: AppStoreInternals,
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
    existing.worktrees.filter((worktree) => worktree.kind === "primary").map((worktree) => worktree.workspaceId),
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
    .map((group) =>
      [...group].sort((left, right) => {
        const leftIsExistingPrimary = existingPrimaryByWorkspaceId.has(left.workspace.workspaceId);
        const rightIsExistingPrimary = existingPrimaryByWorkspaceId.has(right.workspace.workspaceId);
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
      store.catalogStore.worktrees.replaceWorkspaceWorktrees(workspaceId, []).catch(() => undefined),
    ),
  );

  return (await store.catalogStore.worktrees.listWorktrees()).worktrees;
}

/**
 * Build default worktree options — used both by `createWorktree` and `startThread`
 * (which lives in the main store).
 */
export function buildWorktreeOptions(
  store: AppStoreInternals,
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
  const baseLabel = preferredTitle
    ? clampSlug(slugify(preferredTitle), 18)
    : "wt";
  const folderName = `${baseLabel}-${suffix}`;
  const repoName = clampSlug(slugify(basename(workspace.path) || "repo"), 20);
  const displayName = preferredTitle || `Worktree ${suffix}`;
  return {
    path: join(homedir(), ".pi", "worktrees", repoName, folderName),
    displayName,
    branchName: `pi/${folderName}`,
    startPoint: "HEAD",
  };
}

/* ── Private helpers ─────────────────────────────────────── */

async function generateAndApplyAutoTitle(
  store: AppStoreInternals,
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
      return;
    }

    store.clearPendingAutoTitle(sessionRef);
    await store.driver.renameSession(sessionRef, generatedTitle);
  } catch {
    clearMatchingPendingTitle();
  }
}

function sessionTitleForWorktree(store: AppStoreInternals, workspaceId: string, sessionId: string): string | undefined {
  return store.state.workspaces
    .find((workspace) => workspace.id === workspaceId)
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
