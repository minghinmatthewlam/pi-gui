import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  desktopShortcut,
  launchPackagedDesktop,
  makeUserDataDir,
  makeWorkspace,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

test("packaged app opens a real integrated terminal", async () => {
  test.setTimeout(60_000);

  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("packaged-terminal");
  const harness = await launchPackagedDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await createNamedThread(window, "Packaged terminal thread");

    await window.keyboard.press(desktopShortcut("J"));
    const terminal = window.getByTestId("integrated-terminal");
    await expect(terminal).toBeVisible();
    await terminal.locator(".xterm").click();
    await window.keyboard.type("printf 'PI_PACKAGED_TERMINAL_OK\\n'");
    await window.keyboard.press("Enter");
    await expect(terminal.locator(".xterm-rows")).toContainText("PI_PACKAGED_TERMINAL_OK", { timeout: 15_000 });
  } finally {
    await harness.close();
  }
});
