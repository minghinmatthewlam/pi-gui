import { expect, test } from "@playwright/test";
import type { SessionDriverEvent } from "@pi-gui/session-driver";
import {
  createNamedThread,
  emitTestSessionEvent,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

test("shows streamed reasoning and model/tool timings on the Electron transcript", async () => {
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("thinking-timings");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await createNamedThread(window, "Thinking timings");
    const state = await getDesktopState(window);
    if (!state.selectedWorkspaceId || !state.selectedSessionId)
      throw new Error("No thread selected");
    const sessionRef = {
      workspaceId: state.selectedWorkspaceId,
      sessionId: state.selectedSessionId,
    };
    const start = Date.now();
    const at = (ms: number) => new Date(start + ms).toISOString();
    const send = async (event: Omit<SessionDriverEvent, "sessionRef">) =>
      emitTestSessionEvent(harness, { ...event, sessionRef } as SessionDriverEvent);

    await send({ type: "assistantMessageStarted", timestamp: at(0) });
    await send({ type: "assistantThinkingDelta", timestamp: at(400), text: "Check the numbers." });
    const thinking = window.getByTestId("thinking-trace");
    await expect(thinking).toBeVisible();
    await thinking.locator("summary").click();
    await expect(thinking).toContainText("Check the numbers.");
    await send({ type: "assistantDelta", timestamp: at(950), text: "The result is 42." });
    await send({ type: "assistantDelta", timestamp: at(1450), text: " Done." });
    await expect(window.getByTestId("assistant-timing")).toContainText("First token 950 ms");
    await expect(window.getByTestId("assistant-timing")).toContainText("Generation 500 ms");
    await send({ type: "assistantMessageEnded", timestamp: at(1550) });
    await send({
      type: "toolStarted",
      timestamp: at(1600),
      callId: "timed-tool",
      toolName: "bash",
    });
    await send({ type: "toolFinished", timestamp: at(2850), callId: "timed-tool", success: true });
    await expect(window.locator(".timeline-tool__meta-inline", { hasText: "bash" })).toContainText(
      "1.3 s",
    );
  } finally {
    await harness.close();
  }
});
