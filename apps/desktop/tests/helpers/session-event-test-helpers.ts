import { expect } from "@playwright/test";
import type { SessionRef } from "@pi-gui/session-driver";
import { getDesktopState, launchDesktop } from "./electron-app";

type DesktopTestApi = {
  getState: () => Promise<{
    selectedWorkspaceId?: string;
    selectedSessionId?: string;
    workspaces: Array<{
      id: string;
      name: string;
      path: string;
      sessions: Array<{ id: string; title: string }>;
    }>;
  }>;
  createSession: (input: { workspaceId: string; title: string }) => Promise<unknown>;
  selectSession: (target: { workspaceId: string; sessionId: string }) => Promise<unknown>;
};

export type SessionContext = {
  readonly sessionRef: SessionRef;
  readonly workspace: {
    readonly workspaceId: string;
    readonly path: string;
    readonly displayName: string;
  };
  readonly title: string;
};

export async function setSessionVisibilityOverride(
  harness: Awaited<ReturnType<typeof launchDesktop>>,
  mode: "active" | "inactive" | null,
): Promise<void> {
  await harness.electronApp.evaluate((_, nextMode) => {
    const globals = globalThis as { __PI_APP_TEST_SESSION_VISIBILITY__?: "active" | "inactive" };
    if (!nextMode) {
      delete globals.__PI_APP_TEST_SESSION_VISIBILITY__;
      return;
    }
    globals.__PI_APP_TEST_SESSION_VISIBILITY__ = nextMode;
  }, mode);
}

export async function createThread(
  window: Parameters<typeof getDesktopState>[0],
  title: string,
): Promise<SessionContext> {
  await window.evaluate(
    async ({ targetTitle }) => {
      const app = (window as Window & { piApp?: DesktopTestApi }).piApp;
      if (!app) {
        throw new Error("piApp IPC bridge is unavailable");
      }
      const state = await app.getState();
      const workspaceId = state.selectedWorkspaceId ?? state.workspaces[0]?.id;
      if (!workspaceId) {
        throw new Error("Expected a selected workspace before creating a session");
      }
      await app.createSession({ workspaceId, title: targetTitle });
    },
    { targetTitle: title },
  );

  await expect.poll(async () => selectedSessionTitle(window), { timeout: 15_000 }).toBe(title);

  return requireSessionContext(window, title);
}

export async function selectSessionByTitle(
  window: Parameters<typeof getDesktopState>[0],
  title: string,
): Promise<void> {
  await window.evaluate(
    async ({ targetTitle }) => {
      const app = (window as Window & { piApp?: DesktopTestApi }).piApp;
      if (!app) {
        throw new Error("piApp IPC bridge is unavailable");
      }

      const state = await app.getState();
      for (const workspace of state.workspaces) {
        const session = workspace.sessions.find((entry) => entry.title === targetTitle);
        if (!session) {
          continue;
        }
        await app.selectSession({
          workspaceId: workspace.id,
          sessionId: session.id,
        });
        return;
      }

      throw new Error(`Session not found: ${targetTitle}`);
    },
    { targetTitle: title },
  );

  await expect.poll(async () => selectedSessionTitle(window), { timeout: 15_000 }).toBe(title);
}

async function selectedSessionTitle(
  window: Parameters<typeof getDesktopState>[0],
): Promise<string> {
  const state = await getDesktopState(window);
  const selectedWorkspace = state.workspaces.find(
    (workspace) => workspace.id === state.selectedWorkspaceId,
  );
  return (
    selectedWorkspace?.sessions.find((session) => session.id === state.selectedSessionId)?.title ??
    ""
  );
}

async function requireSessionContext(
  window: Parameters<typeof getDesktopState>[0],
  title: string,
): Promise<SessionContext> {
  const state = await getDesktopState(window);
  for (const workspace of state.workspaces) {
    const session = workspace.sessions.find((entry) => entry.title === title);
    if (!session) {
      continue;
    }
    return {
      sessionRef: {
        workspaceId: workspace.id,
        sessionId: session.id,
      },
      workspace: {
        workspaceId: workspace.id,
        path: workspace.path,
        displayName: workspace.name,
      },
      title,
    };
  }

  throw new Error(`Session not found: ${title}`);
}
