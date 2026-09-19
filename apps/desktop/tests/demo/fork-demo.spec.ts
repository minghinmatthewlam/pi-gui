import { expect, test } from "@playwright/test";
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  seedForkSessionFixture,
  selectSession,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

// Slow-paced screen recording of the fork-from-message feature for demo purposes.
test("records a fork-from-message walkthrough", async () => {
  test.setTimeout(120_000);
  const videoDir = join(process.cwd(), "videos");
  await mkdir(videoDir, { recursive: true });

  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("fork-demo-workspace");
  await seedAgentDir(agentDir);
  await seedForkSessionFixture(agentDir, workspacePath);

  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background",
    recordVideoDir: videoDir,
    recordVideoSize: { width: 1480, height: 940 },
  });

  const window = await harness.firstWindow();
  const video = window.video();

  try {
    // Settle on the seeded conversation.
    await window.waitForTimeout(1_200);
    await selectSession(window, "Fork fixture session");

    const transcript = window.getByTestId("transcript");
    await expect(transcript).toContainText("Third fork question");
    await window.waitForTimeout(2_000);

    const workspace = await waitForWorkspaceByPath(window, workspacePath);
    const before = await getDesktopState(window);
    const beforeWorkspace = before.workspaces.find((entry) => entry.id === workspace.id);
    const beforeSessionCount = beforeWorkspace?.sessions.length ?? 0;
    const beforeSelectedSessionId = before.selectedSessionId;

    // Reveal the fork affordance on the second assistant response.
    const secondAnswer = transcript.locator(".timeline-item--assistant", {
      hasText: "Second fork answer",
    });
    await secondAnswer.scrollIntoViewIfNeeded();
    await window.waitForTimeout(800);
    await secondAnswer.hover();
    await window.waitForTimeout(1_400);

    // Open the fork dialog.
    await secondAnswer.getByTestId("fork-from-message").click();
    const forkModal = window.getByTestId("fork-modal");
    await expect(forkModal).toBeVisible();
    await expect(window.getByTestId("fork-modal-preview")).toContainText("Second fork answer");
    await window.waitForTimeout(2_200);

    // Show the worktree choice, then settle back on "Same worktree".
    await window.getByTestId("fork-environment-worktree").hover();
    await window.waitForTimeout(1_400);
    await window.getByTestId("fork-environment-local").hover();
    await window.waitForTimeout(1_200);

    // Confirm the fork.
    await window.getByTestId("fork-modal-confirm").click();
    await expect(forkModal).toHaveCount(0);

    await expect
      .poll(async () => {
        const state = await getDesktopState(window);
        const ws = state.workspaces.find((entry) => entry.id === workspace.id);
        return ws?.sessions.length ?? 0;
      })
      .toBe(beforeSessionCount + 1);

    const after = await getDesktopState(window);
    expect(after.selectedSessionId).not.toBe(beforeSelectedSessionId);

    // Linger on the result: new session selected, history up to and including the fork shown, empty composer.
    await expect(window.getByTestId("composer")).toHaveValue("");
    await expect(transcript).toContainText("First fork answer");
    await expect(transcript).toContainText("Second fork answer");
    await expect(transcript).not.toContainText("Third fork question");
    await window.waitForTimeout(3_500);
  } finally {
    await harness.close();
  }

  const recordedPath = await video?.path();
  if (recordedPath) {
    const finalPath = join(videoDir, "fork-from-message-demo.webm");
    await copyFile(recordedPath, finalPath);
    console.log(`\nFORK_DEMO_VIDEO=${finalPath}\n`);
  }
});
