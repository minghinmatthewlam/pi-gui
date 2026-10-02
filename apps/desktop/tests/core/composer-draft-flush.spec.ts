import { expect, test, type Page } from "@playwright/test";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  selectSession,
  type DesktopHarness,
} from "../helpers/electron-app";

// The composer saves its draft 350 ms after the last keystroke. These specs pause the renderer's
// timers so that save cannot happen on its own, confirm main has not received the draft, and
// then archive the thread, close the window or quit. The draft must survive anyway.
const draft = "Unsent draft typed just before shutdown";

/** Freezes renderer timers, so a debounced draft save waits until something flushes it. */
async function pauseRendererTimers(window: Page): Promise<void> {
  await window.clock.install();
  await window.clock.pauseAt(Date.now() + 1_000);
}

async function expectDraftNotSaved(window: Page): Promise<void> {
  expect((await getDesktopState(window)).composerDraft).toBe("");
}

async function typeUnsavedDraft(window: Page, text = draft): Promise<void> {
  const composer = window.getByTestId("composer");
  await composer.click();
  await composer.pressSequentially(text, { delay: 5 });
  await expect(composer).toHaveValue(text);
  // Longer than the debounce in real time: the save stays pending however slow the runner is.
  await window.waitForTimeout(500);
  await expectDraftNotSaved(window);
}

async function expectDraftAfterRelaunch(
  launch: () => Promise<DesktopHarness>,
  title: string,
): Promise<void> {
  const harness = await launch();
  try {
    const window = await harness.firstWindow();
    await selectSession(window, title);
    await expect(window.getByTestId("composer")).toHaveValue(draft);
  } finally {
    await harness.close();
  }
}

/** Keeps a real-time clock usable after the page clock is paused. Call before pausing. */
async function keepRealClock(window: Page): Promise<void> {
  await window.evaluate(() => {
    (globalThis as { realNow?: () => number }).realNow = Date.now.bind(Date);
  });
}

/**
 * Blocks the renderer for a second in a task that starts as soon as this returns, so main's
 * flush request queues behind it. With `draftAtEnd`, the task ends by calling the composer's
 * change handler outside any DOM event, which React commits in a later task: the text is in
 * the composer but not yet in a pending write when the flush request runs.
 */
async function holdRendererBusy(window: Page, draftAtEnd?: string): Promise<void> {
  await window.evaluate((nextDraft) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      const realNow = (globalThis as { realNow?: () => number }).realNow;
      if (!realNow) throw new Error("real clock unavailable");
      const until = realNow() + 1_000;
      while (realNow() < until) {
        // Busy on purpose.
      }
      if (nextDraft === null) return;
      const composer = document.querySelector("[data-testid='composer']");
      const propsKey =
        composer && Object.keys(composer).find((key) => key.startsWith("__reactProps$"));
      if (!composer || !propsKey) throw new Error("composer change handler unavailable");
      const props = (composer as unknown as Record<string, { onChange(event: unknown): void }>)[
        propsKey
      ];
      props.onChange({ target: { value: nextDraft } });
    };
    channel.port2.postMessage(null);
  }, draftAtEnd ?? null);
}

function launcher(name: string): () => Promise<DesktopHarness> {
  const setup = Promise.all([makeUserDataDir(), makeWorkspace(name)]);
  return async () => {
    const [userDataDir, workspace] = await setup;
    return launchDesktop(userDataDir, { initialWorkspaces: [workspace], testMode: "background" });
  };
}

function processExit(harness: DesktopHarness): Promise<void> {
  return new Promise((resolve) => harness.electronApp.process().once("exit", () => resolve()));
}

async function closeFirstWindow(harness: DesktopHarness): Promise<void> {
  await harness.electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.close();
  });
}

test("keeps a draft typed just before quitting", async () => {
  test.setTimeout(90_000);
  const launch = launcher("draft-shutdown-quit");
  const harness = await launch();
  const window = await harness.firstWindow();
  await createNamedThread(window, "Quit draft");
  await pauseRendererTimers(window);
  await typeUnsavedDraft(window);
  // Playwright quits through app.quit(), the same path as Cmd-Q and the Quit menu item.
  await harness.close();

  await expectDraftAfterRelaunch(launch, "Quit draft");
});

test("keeps a draft typed just before closing the last window", async () => {
  test.setTimeout(90_000);
  const launch = launcher("draft-shutdown-close");
  const harness = await launch();
  const window = await harness.firstWindow();
  await createNamedThread(window, "Close draft");
  await pauseRendererTimers(window);
  await typeUnsavedDraft(window);
  // Title-bar close; on Linux and Windows closing the last window quits the app.
  const exited = processExit(harness);
  await closeFirstWindow(harness);
  await exited;

  await expectDraftAfterRelaunch(launch, "Close draft");
});

test("keeps a draft when the window is closed while quit is saving drafts", async () => {
  test.setTimeout(90_000);
  const launch = launcher("draft-shutdown-close-during-quit");
  const harness = await launch();
  const window = await harness.firstWindow();
  await createNamedThread(window, "Close during quit");
  await keepRealClock(window);
  await pauseRendererTimers(window);
  await typeUnsavedDraft(window);
  // Quit is still waiting for this renderer's draft when the window is closed.
  await holdRendererBusy(window);
  const exited = processExit(harness);
  await harness.electronApp.evaluate(({ app }) => app.quit());
  await closeFirstWindow(harness);
  await exited;

  await expectDraftAfterRelaunch(launch, "Close during quit");
});

test("keeps an edit React has not committed yet when quitting", async () => {
  test.setTimeout(90_000);
  const launch = launcher("draft-shutdown-uncommitted-edit");
  const harness = await launch();
  const window = await harness.firstWindow();
  await createNamedThread(window, "Uncommitted edit");
  await keepRealClock(window);
  await pauseRendererTimers(window);
  await holdRendererBusy(window, draft);
  const exited = processExit(harness);
  await harness.electronApp.evaluate(({ app }) => app.quit());
  await exited;

  await expectDraftAfterRelaunch(launch, "Uncommitted edit");
});

test("keeps a draft when the thread is archived by shortcut straight after typing", async () => {
  test.setTimeout(90_000);
  const harness = await launcher("draft-archive-shortcut")();
  const modifier = process.platform === "darwin" ? "Meta" : "Control";

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Kept");
    await createNamedThread(window, "Archived");
    await pauseRendererTimers(window);
    await typeUnsavedDraft(window);
    await window.keyboard.press(`${modifier}+Shift+A`);
    await expect(window.locator(".chat-header__title")).toHaveText("Kept");
    await window.clock.resume();

    await window.locator(".archived-thread-group__toggle").click();
    const archivedRow = window.locator(".session-list--archived .session-row", {
      hasText: "Archived",
    });
    await archivedRow.hover();
    await archivedRow.getByLabel(/^Restore Archived/).click();
    await expect(window.locator(".archived-thread-group")).toHaveCount(0);
    await selectSession(window, "Archived");
    await expect(window.getByTestId("composer")).toHaveValue(draft);
  } finally {
    await harness.close();
  }
});

test("keeps the drafts of every window when quitting straight after typing", async () => {
  test.setTimeout(90_000);
  const launch = launcher("draft-shutdown-multi-window");
  const nativeModifier = process.platform === "darwin" ? "meta" : "control";
  const drafts = { First: "Draft in the first window", Second: "Draft in the second window" };

  const harness = await launch();
  const firstWindow = await harness.firstWindow();
  await createNamedThread(firstWindow, "Second");
  await createNamedThread(firstWindow, "First");
  const opened = harness.electronApp.waitForEvent("window");
  // Same route as the multi-window spec: a native key event reaches main's shortcut handler.
  await harness.electronApp.evaluate(({ BrowserWindow }, modifier) => {
    BrowserWindow.getAllWindows()[0]?.webContents.sendInputEvent({
      type: "keyDown",
      keyCode: "n",
      modifiers: [modifier, "shift"],
    });
  }, nativeModifier);
  const secondWindow = await opened;
  await secondWindow.waitForFunction(() => Boolean(globalThis.window.piApp));
  await selectSession(secondWindow, "Second");

  await pauseRendererTimers(secondWindow);
  await typeUnsavedDraft(secondWindow, drafts.Second);
  await pauseRendererTimers(firstWindow);
  await typeUnsavedDraft(firstWindow, drafts.First);
  await harness.close();

  const relaunched = await launch();
  try {
    const window = await relaunched.firstWindow();
    for (const [title, text] of Object.entries(drafts)) {
      await selectSession(window, title);
      await expect(window.getByTestId("composer")).toHaveValue(text);
    }
  } finally {
    await relaunched.close();
  }
});
