import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  createNamedThread,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  reloadDesktopRenderer,
  writeProjectExtension,
} from "../helpers/electron-app";
import { readOptionalLog } from "../helpers/notification-events";
import { setSessionVisibilityOverride } from "../helpers/session-event-test-helpers";

const notifyExtensionSource = String.raw`
export default function notifyLevelsExtension(pi) {
  pi.registerCommand("notify-levels", {
    description: "Notify at every level",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Build started", "info");
      ctx.ui.notify("Cache is stale", "warning");
      ctx.ui.notify("Deploy failed", "error");
    },
  });
}
`;

// Main removes a notice 6 s after it arrives; allow for a slow runner on top.
const NOTICE_EXPIRY_TIMEOUT_MS = 15_000;

async function runNotifyLevels(window: Page) {
  const composer = window.getByTestId("composer");
  await composer.fill("/notify-levels ");
  await composer.press("Enter");
}

test("extension notify shows toasts above the composer that expire, and only errors stay in the transcript", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("extension-notices-workspace");
  await writeProjectExtension(workspacePath, "notify-levels.ts", notifyExtensionSource);
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Notify session");
    await runNotifyLevels(window);

    const notices = window.getByTestId("extension-notice");
    await expect(notices).toHaveText([
      "Build started",
      "Warning:Cache is stale",
      "Error:Deploy failed",
    ]);

    // Main owns the lifetime: a renderer reload redraws live notices, then they expire.
    // Reload straight away so the redraw check runs well inside the 6 s lifetime.
    await reloadDesktopRenderer(window);
    await expect(notices).toHaveCount(3);
    await expect(notices.nth(2).locator(".extension-notice__level")).toHaveText("Error:");

    const timeline = window.locator(".timeline");
    await expect(timeline).toContainText("Deploy failed");
    await expect(timeline).not.toContainText("Build started");
    await expect(timeline).not.toContainText("Cache is stale");
    await expect(notices).toHaveCount(0, { timeout: NOTICE_EXPIRY_TIMEOUT_MS });

    await reloadDesktopRenderer(window);
    await expect(window.locator(".timeline")).toContainText("Deploy failed");
    await expect(window.getByTestId("extension-notice")).toHaveCount(0);
  } finally {
    await harness.close();
  }
});

test("warning and error notices raise an OS notification when the thread is not in view; info does not", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const notificationLogPath = join(userDataDir, "notifications.jsonl");
  const workspacePath = await makeWorkspace("extension-notices-os-workspace");
  await writeProjectExtension(workspacePath, "notify-levels.ts", notifyExtensionSource);
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    notificationLogPath,
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Background notify session");
    await setSessionVisibilityOverride(harness, "inactive");
    await runNotifyLevels(window);

    await expect
      .poll(() => readOptionalLog(notificationLogPath), { timeout: 30_000 })
      .toContain('"body":"Error: Deploy failed"');
    const log = await readOptionalLog(notificationLogPath);
    expect(log).toContain('"body":"Warning: Cache is stale"');
    expect(log).not.toContain("Build started");
  } finally {
    await harness.close();
  }
});
