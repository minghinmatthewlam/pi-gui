import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  seedExternalLinkSessionFixture,
  selectSession,
} from "../helpers/electron-app";

test("opens markdown web links externally without leaving the current session", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("external-links-workspace");
  const targetUrl = "https://github.com/minghinmatthewlam/pi-gui/issues/20";
  await seedAgentDir(agentDir);
  await seedExternalLinkSessionFixture(agentDir, workspacePath);

  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await selectSession(window, "External link fixture session");
    const appUrl = window.url();

    await harness.electronApp.evaluate(({ shell }) => {
      const globals = globalThis as typeof globalThis & { __piGuiOpenedExternalUrls?: string[] };
      globals.__piGuiOpenedExternalUrls = [];
      shell.openExternal = async (url: string) => {
        globals.__piGuiOpenedExternalUrls?.push(url);
      };
    });

    await window.getByRole("link", { name: "GitHub issue" }).click();

    await expect
      .poll(() =>
        harness.electronApp.evaluate(
          () =>
            (globalThis as typeof globalThis & { __piGuiOpenedExternalUrls?: string[] })
              .__piGuiOpenedExternalUrls ?? [],
        ),
      )
      .toEqual([targetUrl]);
    await expect
      .poll(() => harness.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length))
      .toBe(1);
    expect(window.url()).toBe(appUrl);
    await expect(window.getByTestId("transcript")).toContainText("GitHub issue");
  } finally {
    await harness.close();
  }
});
