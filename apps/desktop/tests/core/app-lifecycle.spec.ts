import { expect, test } from "@playwright/test";
import { launchDesktop, makeUserDataDir, type DesktopHarness } from "../helpers/electron-app";

const VALID_TEST_MODES = ["background", "foreground"] as const;
const NORMAL_LIFECYCLE_CASES = [
  { label: "unset", value: undefined },
  { label: "empty", value: "" },
  { label: "invalid", value: "unsupported" },
] as const;
const STAYS_OPEN_ASSERTION_MS = 750;

async function launchLifecycleApp(testMode: string | undefined): Promise<DesktopHarness> {
  const userDataDir = await makeUserDataDir("pi-gui-lifecycle-");
  const harness = await launchDesktop(userDataDir, {
    envOverrides: { PI_APP_TEST_MODE: testMode },
  });
  await harness.firstWindow();
  return harness;
}

async function closeLastWindow(harness: DesktopHarness): Promise<void> {
  await harness.electronApp.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length !== 1) {
      throw new Error(`Expected one app window before close, received ${windows.length}.`);
    }
    windows[0]?.close();
  });
}

async function appClosesWithin(harness: DesktopHarness, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    harness.electronApp.waitForEvent("close").then(() => true),
    new Promise<false>((resolve) => {
      setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
}

async function quitDesktop(harness: DesktopHarness): Promise<void> {
  const closed = harness.electronApp.waitForEvent("close");
  await harness.electronApp.evaluate(({ app }) => app.quit());
  await closed;
}

test.describe("macOS last-window lifecycle", () => {
  test.skip(
    process.platform !== "darwin",
    "macOS keeps a normal app alive after its last window closes.",
  );

  for (const mode of VALID_TEST_MODES) {
    test(`quits after the last window closes in ${mode} test mode`, async () => {
      test.setTimeout(30_000);
      const harness = await launchLifecycleApp(mode);
      let appClosed = false;
      harness.electronApp.on("close", () => {
        appClosed = true;
      });

      try {
        const closed = harness.electronApp.waitForEvent("close");
        await closeLastWindow(harness);
        await closed;
      } finally {
        if (!appClosed) {
          await quitDesktop(harness);
        }
      }
    });
  }

  for (const { label, value } of NORMAL_LIFECYCLE_CASES) {
    test(`retains normal behavior when PI_APP_TEST_MODE is ${label}`, async () => {
      test.setTimeout(30_000);
      const harness = await launchLifecycleApp(value);
      let appClosed = false;
      harness.electronApp.on("close", () => {
        appClosed = true;
      });

      try {
        await closeLastWindow(harness);
        expect(await appClosesWithin(harness, STAYS_OPEN_ASSERTION_MS)).toBe(false);
        expect(
          await harness.electronApp.evaluate(({ app, BrowserWindow }) => ({
            appReady: app.isReady(),
            windowCount: BrowserWindow.getAllWindows().length,
          })),
        ).toEqual({
          appReady: true,
          windowCount: 0,
        });

        const reopenedWindow = harness.electronApp.waitForEvent("window");
        await harness.electronApp.evaluate(({ app }) => {
          app.emit("activate");
        });
        await expect(await reopenedWindow).toHaveURL(/index\.html/);
      } finally {
        if (!appClosed) {
          await quitDesktop(harness);
        }
      }
    });
  }
});
