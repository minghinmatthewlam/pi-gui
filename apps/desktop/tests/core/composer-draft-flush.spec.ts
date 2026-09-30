import { expect, test, type Page } from "@playwright/test";
import {
  createNamedThread,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  selectSession,
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
