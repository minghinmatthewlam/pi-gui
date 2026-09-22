import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  waitForSelectedSessionReady,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";
import { appendMessagesToSessionFile, sessionFilePathFromCatalog } from "../helpers/session-file";

const TURN_COUNT = 6;

test("turn timing markers render without a prompt rail", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("context-rail-workspace");

  const firstRun = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  let workspaceId = "";
  let sessionId = "";
  try {
    const window = await firstRun.firstWindow();
    await createNamedThread(window, "Context rail session");
    const state = await getDesktopState(window);
    workspaceId = state.selectedWorkspaceId;
    sessionId = state.selectedSessionId;
    await waitForSelectedSessionReady(window, { workspaceId, sessionId });
  } finally {
    await firstRun.close();
  }

  const sessionFilePath = await sessionFilePathFromCatalog(userDataDir, { workspaceId, sessionId });
  const base = Date.now();
  const messages = [];
  for (let turn = 0; turn < TURN_COUNT; turn += 1) {
    const turnStart = base + turn * 60_000;
    messages.push({
      role: "user" as const,
      text: `PROMPT ${turn} unique-marker-${turn}`,
      timestampMs: turnStart,
    });
    messages.push({
      role: "assistant" as const,
      text: `Answer for turn ${turn}. ${"padding ".repeat(120)}`,
      timestampMs: turnStart + 8_000,
    });
  }
  await appendMessagesToSessionFile(sessionFilePath, messages);

  const run = await launchDesktop(userDataDir, { testMode: "background" });
  try {
    const window = await run.firstWindow();
    await run.electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setBounds({ x: 40, y: 40, width: 1500, height: 950 });
    });
    await waitForWorkspaceByPath(window, workspacePath);
    await waitForSelectedSessionReady(window, { workspaceId, sessionId });
    await expect(window.getByTestId("transcript")).toBeVisible({ timeout: 15_000 });

    await expect(window.getByTestId("timeline-turn-marker").first()).toContainText(
      "Worked for 8s",
      {
        timeout: 10_000,
      },
    );
    await expect(window.getByTestId("timeline-context-rail")).toHaveCount(0);
    await expect(window.getByRole("button", { name: /prompt navigation/i })).toHaveCount(0);
  } finally {
    await run.close();
  }
});
