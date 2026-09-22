import { expect, test, type Page } from "@playwright/test";
import {
  createNamedThread,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  selectSidePanel,
} from "../helpers/electron-app";

async function quickSwitch(window: Page): Promise<void> {
  await window.keyboard.down("Control");
  await window.keyboard.press("Tab");
  await window.keyboard.up("Control");
}

function switcherRows(window: Page) {
  return window.getByTestId("thread-switcher").getByRole("option");
}

async function expectSwitcherSelection(window: Page, title: string): Promise<void> {
  await expect(
    window.getByTestId("thread-switcher").getByRole("option", { selected: true }),
  ).toContainText(title);
}

test("Ctrl-Tab switches threads in most-recently-used order and keeps it across restart", async () => {
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("thread-switcher-workspace");
  const threadTitle = (window: Page) => window.locator(".chat-header__title");

  const firstRun = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await firstRun.firstWindow();
    await createNamedThread(window, "Thread one");
    await createNamedThread(window, "Thread two");
    await createNamedThread(window, "Thread three");
    await expect(threadTitle(window)).toHaveText("Thread three");

    // A quick tap swaps to the previous thread, and again swaps back.
    const composer = window.getByTestId("composer");
    await composer.fill("draft stays put");
    await quickSwitch(window);
    await expect(threadTitle(window)).toHaveText("Thread two");
    await expect(window.getByTestId("thread-switcher")).toHaveCount(0);
    await quickSwitch(window);
    await expect(threadTitle(window)).toHaveText("Thread three");
    await expect(window.getByTestId("composer")).toHaveValue("draft stays put");

    // Holding Control shows the list; Tab and Shift-Tab step; release opens.
    await window.keyboard.down("Control");
    await window.keyboard.press("Tab");
    await expect(switcherRows(window)).toHaveText([/Thread three/, /Thread two/, /Thread one/]);
    await expectSwitcherSelection(window, "Thread two");
    await window.keyboard.press("Tab");
    await expectSwitcherSelection(window, "Thread one");
    await window.keyboard.press("Shift+Tab");
    await expectSwitcherSelection(window, "Thread two");
    await window.keyboard.press("Tab");
    await window.keyboard.up("Control");
    await expect(window.getByTestId("thread-switcher")).toHaveCount(0);
    await expect(threadTitle(window)).toHaveText("Thread one");

    // Escape cancels without switching.
    await window.keyboard.down("Control");
    await window.keyboard.press("Tab");
    await expect(window.getByTestId("thread-switcher")).toBeVisible();
    await window.keyboard.press("Escape");
    await window.keyboard.up("Control");
    await expect(window.getByTestId("thread-switcher")).toHaveCount(0);
    await expect(threadTitle(window)).toHaveText("Thread one");

    // The terminal does not swallow the chord.
    await selectSidePanel(window, "Terminal");
    const terminal = window.getByTestId("integrated-terminal");
    await terminal.locator(".xterm").click();
    await quickSwitch(window);
    await expect(threadTitle(window)).toHaveText("Thread three");

    // Archived threads leave the list.
    const threadTwoRow = window
      .locator(".session-list > .session-row")
      .filter({ hasText: "Thread two" })
      .first();
    await threadTwoRow.hover();
    await threadTwoRow.getByLabel("Archive Thread two").click();
    await expect(
      window.locator(".session-list > .session-row").filter({ hasText: "Thread two" }),
    ).toHaveCount(0);
    await expect(threadTitle(window)).toHaveText("Thread three");
    await window.keyboard.down("Control");
    await window.keyboard.press("Tab");
    await expect(switcherRows(window)).toHaveText([/Thread three/, /Thread one/]);
    await window.keyboard.press("Escape");
    await window.keyboard.up("Control");
  } finally {
    await firstRun.close();
  }

  const secondRun = await launchDesktop(userDataDir, { testMode: "background" });
  try {
    const window = await secondRun.firstWindow();
    await expect(threadTitle(window)).toHaveText("Thread three", { timeout: 15_000 });
    await quickSwitch(window);
    await expect(threadTitle(window)).toHaveText("Thread one");
    await quickSwitch(window);
    await expect(threadTitle(window)).toHaveText("Thread three");
  } finally {
    await secondRun.close();
  }
});
