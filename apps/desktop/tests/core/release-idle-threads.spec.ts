import { expect, test, type Page } from "@playwright/test";
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

type LoadedThreads = { readonly subscribed: string[]; readonly transcripts: string[] };

/** Threads the app holds: a live driver subscription, and a cached transcript. */
async function loadedThreads(harness: DesktopHarness): Promise<LoadedThreads> {
  const loaded = await harness.electronApp.evaluate(() => {
    const hooks = (globalThis as { __PI_APP_TEST_HOOKS?: { loadedThreads?: () => LoadedThreads } })
      .__PI_APP_TEST_HOOKS;
    if (!hooks?.loadedThreads) {
      throw new Error("loadedThreads hook is unavailable");
    }
    return hooks.loadedThreads();
  });
  return { subscribed: loaded.subscribed.sort(), transcripts: loaded.transcripts.sort() };
}

/** Both the subscription and the transcript of exactly these threads are held. */
async function expectLoadedThreads(harness: DesktopHarness, keys: string[]): Promise<void> {
  const expected = [...keys].sort();
  await expect
    .poll(() => loadedThreads(harness))
    .toEqual({ subscribed: expected, transcripts: expected });
}

const titles = ["Thread one", "Thread two", "Thread three", "Thread four", "Thread five"];
const platformModifier = process.platform === "darwin" ? "meta" : "control";

type ThreadRef = { workspaceId: string; sessionId: string };

const keyOf = (ref: ThreadRef) => `${ref.workspaceId}:${ref.sessionId}`;

/** Five threads whose files contain a message each, then a fresh launch of the app. */
async function launchWithFiveThreads(
  name: string,
): Promise<{ harness: DesktopHarness; refs: ThreadRef[]; workspacePath: string }> {
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace(name);
  const seed = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  const refs: ThreadRef[] = [];
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
  return { harness, refs, workspacePath };
}

/** Opens another window the way a person does, with Shift+Cmd+N. */
async function openSecondWindow(harness: DesktopHarness): Promise<Page> {
  const opened = harness.electronApp.waitForEvent("window");
  await harness.electronApp.evaluate(({ BrowserWindow }, modifier) => {
    BrowserWindow.getAllWindows()[0]?.webContents.sendInputEvent({
      type: "keyDown",
      keyCode: "n",
      modifiers: [modifier, "shift"],
    });
  }, platformModifier);
  const window = await opened;
  await window.waitForFunction(() => Boolean(globalThis.window.piApp));
  return window;
}

/**
 * Opened threads used to stay in memory until quit. Idle threads beyond the few viewed most
 * recently are released, and reload from their files, with their messages, when opened again.
 */
test("releases idle threads that weren't viewed recently and reloads them when opened", async () => {
  test.setTimeout(120_000);
  const { harness, refs, workspacePath } = await launchWithFiveThreads(
    "release-idle-threads-workspace",
  );
  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    const transcript = window.getByTestId("transcript");
    for (const title of titles) {
      await selectSession(window, title);
      await expect(transcript).toContainText(`answer from ${title}`);
    }

    // Only the threads viewed most recently stay loaded.
    await expectLoadedThreads(harness, refs.slice(-3).map(keyOf));

    // A released thread reloads from its file, with its messages, and still works.
    await selectSession(window, "Thread one");
    await expect(transcript).toContainText("question for Thread one");
    await expect(transcript).toContainText("answer from Thread one");
    await expect(transcript).not.toContainText("answer from Thread five");
    await expectLoadedThreads(harness, [keyOf(refs[0]!), ...refs.slice(-2).map(keyOf)]);
    const composer = window.getByTestId("composer");
    await composer.fill("draft after reload");
    await expect(composer).toHaveValue("draft after reload");
  } finally {
    await harness.close();
  }
});

test("a draft typed in a thread is still there after the thread is released and reopened", async () => {
  test.setTimeout(120_000);
  const { harness, refs, workspacePath } = await launchWithFiveThreads("release-idle-draft");
  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    const transcript = window.getByTestId("transcript");
    const composer = window.getByTestId("composer");
    await selectSession(window, "Thread one");
    await expect(transcript).toContainText("answer from Thread one");
    await composer.fill("half-written question for thread one");

    for (const title of titles.slice(1)) {
      await selectSession(window, title);
      await expect(transcript).toContainText(`answer from ${title}`);
    }
    await expectLoadedThreads(harness, refs.slice(-3).map(keyOf));

    await selectSession(window, "Thread one");
    await expect(transcript).toContainText("answer from Thread one");
    await expect(composer).toHaveValue("half-written question for thread one");
  } finally {
    await harness.close();
  }
});

test("a thread showing in another window, even minimized, stays loaded while this window moves on", async () => {
  test.setTimeout(120_000);
  const { harness, refs, workspacePath } = await launchWithFiveThreads("release-idle-windows");
  try {
    const firstWindow = await harness.firstWindow();
    await waitForWorkspaceByPath(firstWindow, workspacePath);
    await selectSession(firstWindow, "Thread one");
    await expect(firstWindow.getByTestId("transcript")).toContainText("answer from Thread one");

    // The new window opens on the thread the first window shows.
    const secondWindow = await openSecondWindow(harness);
    await expect(secondWindow.locator(".chat-header__title")).toHaveText("Thread one");
    await expect(secondWindow.getByTestId("transcript")).toContainText("answer from Thread one");

    // A minimized window still depends on its thread: it shows it again when restored.
    await secondWindow.evaluate(() => {
      document.title = "release-idle-second-window";
    });
    await harness.electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getTitle() === "release-idle-second-window")
        ?.minimize();
    });

    // The first window moves through the other threads.
    for (const title of titles.slice(1)) {
      await selectSession(firstWindow, title);
      await expect(firstWindow.getByTestId("transcript")).toContainText(`answer from ${title}`);
    }
    await expectLoadedThreads(harness, [keyOf(refs[0]!), ...refs.slice(-3).map(keyOf)]);

    // Restored, the second window still shows the thread, with its messages, and can use it.
    await harness.electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getTitle() === "release-idle-second-window")
        ?.restore();
    });
    await expect(secondWindow.getByTestId("transcript")).toContainText("answer from Thread one");
    const composer = secondWindow.getByTestId("composer");
    await composer.fill("still here");
    await expect(composer).toHaveValue("still here");
  } finally {
    await harness.close();
  }
});
