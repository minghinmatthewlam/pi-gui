import { expect, test, type Page } from "@playwright/test";
import {
  createNamedThread,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  selectSession,
  type DesktopHarness,
} from "../helpers/electron-app";

// The composer saves its draft 350 ms after the last keystroke. These specs archive the thread,
// close the window or quit straight after typing, well inside that debounce, and expect the
// draft to survive.
const draft = "Unsent draft typed just before shutdown";

async function typeDraftIntoNewThread(window: Page, title: string): Promise<void> {
  await createNamedThread(window, title);
  const composer = window.getByTestId("composer");
  await composer.click();
  await composer.pressSequentially(draft, { delay: 5 });
  await expect(composer).toHaveValue(draft);
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

for (const shutdown of ["quit", "close-last-window"] as const) {
  test(`keeps a draft typed just before ${shutdown === "quit" ? "quitting" : "closing the last window"}`, async () => {
    test.setTimeout(90_000);
    const userDataDir = await makeUserDataDir();
    const workspace = await makeWorkspace(`draft-shutdown-${shutdown}`);
    const launch = () =>
      launchDesktop(userDataDir, { initialWorkspaces: [workspace], testMode: "background" });
    const title = "Shutdown draft";

    const harness = await launch();
    const window = await harness.firstWindow();
    await typeDraftIntoNewThread(window, title);
    if (shutdown === "quit") {
      // Playwright quits through app.quit(), the same path as Cmd-Q and the Quit menu item.
      await harness.close();
    } else {
      // Title-bar close; on Linux and Windows closing the last window quits the app.
      const exited = new Promise<void>((resolve) =>
        harness.electronApp.process().once("exit", () => resolve()),
      );
      await harness.electronApp.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.close();
      });
      await exited;
    }

    await expectDraftAfterRelaunch(launch, title);
  });
}

test("keeps a draft when the thread is archived by shortcut straight after typing", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspace = await makeWorkspace("draft-archive-shortcut");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspace],
    testMode: "background",
  });
  const modifier = process.platform === "darwin" ? "Meta" : "Control";

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Kept");
    await typeDraftIntoNewThread(window, "Archived");
    await window.keyboard.press(`${modifier}+Shift+A`);
    await expect(window.locator(".chat-header__title")).toHaveText("Kept");

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
  const userDataDir = await makeUserDataDir();
  const workspace = await makeWorkspace("draft-shutdown-multi-window");
  const launch = () =>
    launchDesktop(userDataDir, { initialWorkspaces: [workspace], testMode: "background" });
  const nativeModifier = process.platform === "darwin" ? "meta" : "control";
  const drafts = { First: "Draft in the first window", Second: "Draft in the second window" };

  const harness = await launch();
  const firstWindow = await harness.firstWindow();
  await createNamedThread(firstWindow, "Second");
  await createNamedThread(firstWindow, "First");
  const opened = harness.electronApp.waitForEvent("window");
  // Same route as the multi-window spec: a native key event reaches main's shortcut handler.
  await harness.electronApp.evaluate(({ BrowserWindow }, nativeModifier) => {
    BrowserWindow.getAllWindows()[0]?.webContents.sendInputEvent({
      type: "keyDown",
      keyCode: "n",
      modifiers: [nativeModifier, "shift"],
    });
  }, nativeModifier);
  const secondWindow = await opened;
  await secondWindow.waitForFunction(() => Boolean(globalThis.window.piApp));
  await selectSession(secondWindow, "Second");

  // fill() makes each edit one input event, so both drafts are still inside their debounce.
  await secondWindow.getByTestId("composer").fill(drafts.Second);
  await firstWindow.getByTestId("composer").fill(drafts.First);
  await harness.close();

  const relaunched = await launch();
  try {
    const window = await relaunched.firstWindow();
    for (const [title, draft] of Object.entries(drafts)) {
      await selectSession(window, title);
      await expect(window.getByTestId("composer")).toHaveValue(draft);
    }
  } finally {
    await relaunched.close();
  }
});
