import { expect, test } from "@playwright/test";
import type { SessionRef } from "@pi-gui/session-driver";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  runScheduledTaskRuntimeTool,
} from "../helpers/electron-app";

async function selectedSessionRef(
  window: Parameters<typeof getDesktopState>[0],
): Promise<SessionRef> {
  const state = await getDesktopState(window);
  if (!state.selectedWorkspaceId || !state.selectedSessionId) {
    throw new Error("Expected a selected session");
  }
  return { workspaceId: state.selectedWorkspaceId, sessionId: state.selectedSessionId };
}

test("create_scheduled_task tool writes the same catalog the list UI reads", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("scheduled-runtime-tool");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Tool parent");
    const sessionRef = await selectedSessionRef(window);
    const created = await runScheduledTaskRuntimeTool(harness, {
      toolName: "create_scheduled_task",
      sessionRef,
      params: {
        title: "Tool ping",
        instruction: "Ping from the tool",
        repeat: "interval",
        every_minutes: 15,
      },
    });
    expect(created.details?.error).toBeUndefined();
    expect(created.details?.taskId).toBeTruthy();
    const listed = await runScheduledTaskRuntimeTool(harness, {
      toolName: "list_scheduled_tasks",
      sessionRef,
      params: {},
    });
    expect(listed.content[0]?.text).toContain("Tool ping");
    await window.getByTestId("sidebar-scheduled").click();
    await expect(window.getByTestId("scheduled-task-row")).toContainText("Tool ping");
    await expect(window.getByTestId("scheduled-task-row")).toContainText("Every 15 minutes");
  } finally {
    await harness.close();
  }
});
