import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  selectSession,
  waitForWorkspaceByPath,
  type DesktopHarness,
} from "../helpers/electron-app";
import { appendMessagesToSessionFile, sessionFilePathFromCatalog } from "../helpers/session-file";

async function loadedThreadIds(harness: DesktopHarness): Promise<string[]> {
  return harness.electronApp.evaluate(() => {
    const hooks = (
      globalThis as { __PI_APP_TEST_HOOKS?: { loadedTranscriptSessionIds?: () => string[] } }
    ).__PI_APP_TEST_HOOKS;
    if (!hooks?.loadedTranscriptSessionIds) {
      throw new Error("loadedTranscriptSessionIds hook is unavailable");
    }
    return hooks.loadedTranscriptSessionIds();
  });
}

/**
 * Opened threads used to stay in memory until quit. Idle threads beyond the few viewed most
 * recently are released, and reload from their files, with their messages, when opened again.
 */
test("releases idle threads that weren't viewed recently and reloads them when opened", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("release-idle-threads-workspace");
  const titles = ["Thread one", "Thread two", "Thread three", "Thread four", "Thread five"];

  // Seed five threads whose files contain a message each.
  const seed = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  const refs: { workspaceId: string; sessionId: string }[] = [];
  try {
    const window = await seed.firstWindow();
    for (const title of titles) {
      await createNamedThread(window, title);
      const state = await getDesktopState(window);
      refs.push({ workspaceId: state.selectedWorkspaceId, sessionId: state.selectedSessionId });
    }
  } finally {
    await seed.close();
  }
  for (const [index, ref] of refs.entries()) {
    await appendMessagesToSessionFile(await sessionFilePathFromCatalog(userDataDir, ref), [
      { role: "user", text: `question for ${titles[index]}` },
      { role: "assistant", text: `answer from ${titles[index]}` },
    ]);
  }

  const harness = await launchDesktop(userDataDir, { testMode: "background" });
  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    const transcript = window.getByTestId("transcript");
    for (const title of titles) {
      await selectSession(window, title);
      await expect(transcript).toContainText(`answer from ${title}`);
    }

    // Only the threads viewed most recently stay loaded.
    const recent = refs.slice(-3).map((ref) => `${ref.workspaceId}:${ref.sessionId}`);
    await expect
      .poll(async () => (await loadedThreadIds(harness)).sort())
      .toEqual([...recent].sort());

    // A released thread reloads from its file, with its messages, and still works.
    await selectSession(window, "Thread one");
    await expect(transcript).toContainText("question for Thread one");
    await expect(transcript).toContainText("answer from Thread one");
    await expect(transcript).not.toContainText("answer from Thread five");
    expect(await loadedThreadIds(harness)).toContain(
      `${refs[0]!.workspaceId}:${refs[0]!.sessionId}`,
    );
    const composer = window.getByTestId("composer");
    await composer.fill("draft after reload");
    await expect(composer).toHaveValue("draft after reload");
  } finally {
    await harness.close();
  }
});
