import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  type DesktopHarness,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  seedExternalLinkSessionFixture,
  selectSession,
} from "../helpers/electron-app";

async function captureOpenedExternalUrls(
  harness: DesktopHarness,
): Promise<() => Promise<readonly string[]>> {
  await harness.electronApp.evaluate(({ shell }) => {
    const globals = globalThis as typeof globalThis & { __piGuiOpenedExternalUrls?: string[] };
    globals.__piGuiOpenedExternalUrls = [];
    shell.openExternal = async (url: string) => {
      globals.__piGuiOpenedExternalUrls?.push(url);
    };
  });

  return () =>
    harness.electronApp.evaluate(
      () =>
        (globalThis as typeof globalThis & { __piGuiOpenedExternalUrls?: string[] })
          .__piGuiOpenedExternalUrls ?? [],
    );
}

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
    const openedExternalUrls = await captureOpenedExternalUrls(harness);

    await window.getByRole("link", { name: "GitHub issue" }).click();

    await expect.poll(openedExternalUrls).toEqual([targetUrl]);
    await expect
      .poll(() =>
        harness.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
      )
      .toBe(1);
    expect(window.url()).toBe(appUrl);
    await expect(window.getByTestId("transcript")).toContainText("GitHub issue");
  } finally {
    await harness.close();
  }
});

test("refuses non-web markdown links from message content", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("unsafe-external-links-workspace");
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
    const openedExternalUrls = await captureOpenedExternalUrls(harness);

    await window.getByRole("link", { name: "email fallback" }).click();

    await expect.poll(openedExternalUrls).toEqual([]);
    await expect
      .poll(() =>
        harness.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
      )
      .toBe(1);
    expect(window.url()).toBe(appUrl);
    await expect(window.getByTestId("transcript")).toContainText("email fallback");
  } finally {
    await harness.close();
  }
});
