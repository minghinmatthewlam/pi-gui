import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  emitTestSessionEvent,
  getDesktopState,
  getSelectedTranscript,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
} from "../helpers/electron-app";

test("reopens persisted folders and thread state while a saved running session keeps streaming updates", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("reopen-state-workspace");

  const firstRun = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  let workspaceId = "";
  let sessionId = "";
  try {
    const window = await firstRun.firstWindow();
    await createNamedThread(window, "Reopen reliability session");

    const composer = window.getByTestId("composer");
    await composer.fill("/status");
    await composer.press("Enter");
    await expect(window.getByTestId("transcript")).toContainText(/Model |No session overrides set/);

    const state = await getDesktopState(window);
    workspaceId = state.selectedWorkspaceId;
    sessionId = state.selectedSessionId;

    const transcriptPath = join(userDataDir, "transcripts", `${encodeURIComponent(`${workspaceId}:${sessionId}`)}.json`);
    await expect
      .poll(async () => {
        try {
          return await readFile(transcriptPath, "utf8");
        } catch {
          return "";
        }
      })
      .toContain("\"kind\": \"activity\"");
  } finally {
    await firstRun.close();
  }

  const catalogsPath = join(userDataDir, "catalogs.json");
  const catalogs = JSON.parse(await readFile(catalogsPath, "utf8")) as {
    sessions: Array<{
      sessionRef: { workspaceId: string; sessionId: string };
      status: string;
      updatedAt: string;
      previewSnippet?: string;
    }>;
  };
  catalogs.sessions = catalogs.sessions.map((session) =>
    session.sessionRef.workspaceId === workspaceId && session.sessionRef.sessionId === sessionId
      ? {
          ...session,
          status: "running",
          updatedAt: new Date().toISOString(),
          previewSnippet: "Resuming after reopen",
        }
      : session,
  );
  await writeFile(catalogsPath, `${JSON.stringify(catalogs, null, 2)}\n`, "utf8");

  const secondRun = await launchDesktop(userDataDir, { testMode: "background" });
  try {
    const window = await secondRun.firstWindow();
    await expect(window.locator(".topbar__session")).toHaveText("Reopen reliability session");
    await expect(window.getByTestId("transcript")).toContainText(/Model |No session overrides set/);

    await emitTestSessionEvent(secondRun, {
      type: "sessionUpdated",
      sessionRef: { workspaceId, sessionId },
      timestamp: new Date().toISOString(),
      snapshot: {
        ref: { workspaceId, sessionId },
        workspace: {
          workspaceId,
          path: workspacePath,
          displayName: "reopen-state-workspace",
        },
        title: "Reopen reliability session",
        status: "running",
        updatedAt: new Date().toISOString(),
        preview: "Resuming after reopen",
      },
    });

    for (let index = 0; index < 24; index += 1) {
      await emitTestSessionEvent(secondRun, {
        type: "assistantDelta",
        sessionRef: { workspaceId, sessionId },
        timestamp: new Date(Date.now() + index * 1_000).toISOString(),
        text: `stream chunk ${index} `.repeat(8),
      });
    }

    await expect(window.getByTestId("transcript")).toContainText("stream chunk 23");
    await expect
      .poll(async () => {
        const state = await getDesktopState(window);
        const transcript = await getSelectedTranscript(window);
        const workspace = state.workspaces.find((entry) => entry.id === workspaceId);
        const session = workspace?.sessions.find((entry) => entry.id === sessionId);
        return {
          selectedWorkspaceId: state.selectedWorkspaceId,
          selectedSessionId: state.selectedSessionId,
          status: session?.status,
          preview: session?.preview,
          transcriptLines: transcript?.transcript.length ?? 0,
        };
      })
      .toMatchObject({
        selectedWorkspaceId: workspaceId,
        selectedSessionId: sessionId,
        status: "running",
      });

    await secondRun.electronApp.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0]?.webContents as {
        forcefullyCrashRenderer?: () => void;
      } | undefined;
      contents?.forcefullyCrashRenderer?.();
    });

    await emitTestSessionEvent(secondRun, {
      type: "assistantDelta",
      sessionRef: { workspaceId, sessionId },
      timestamp: new Date().toISOString(),
      text: "post-crash chunk ".repeat(6),
    });

    const processType = await secondRun.electronApp.evaluate(() => process.type);
    expect(processType).toBe("browser");
  } finally {
    await secondRun.close();
  }
});
