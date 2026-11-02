import { expect, test } from "@playwright/test";
import { launchDesktop, makeUserDataDir, type DesktopHarness } from "../helpers/electron-app";

const modifier = process.platform === "darwin" ? "meta" : "control";

async function readZoomLevel(harness: DesktopHarness): Promise<number> {
  return harness.electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) {
      throw new Error("pi-gui had no window to read the zoom level from");
    }
    return window.webContents.getZoomLevel();
  });
}

// Playwright's page.keyboard does not reach before-input-event; the app routes
// its shortcuts from there, so send the keys the way Electron does for the menu.
async function pressZoomKey(harness: DesktopHarness, keyCode: string): Promise<void> {
  await harness.electronApp.evaluate(
    ({ BrowserWindow }, input) => {
      BrowserWindow.getAllWindows()[0]?.webContents.sendInputEvent({
        type: "keyDown",
        keyCode: input.keyCode,
        modifiers: [input.modifier],
      });
    },
    { keyCode, modifier },
  );
}

test("Ctrl or Cmd with plus, minus and zero zooms the window", async () => {
  const userDataDir = await makeUserDataDir();
  const harness = await launchDesktop(userDataDir, { testMode: "background" });

  try {
    await harness.firstWindow();
    expect(await readZoomLevel(harness)).toBe(0);

    // Plain "=" is the chord the default menu misses: it only binds the plus key.
    await pressZoomKey(harness, "=");
    await expect.poll(() => readZoomLevel(harness)).toBe(0.5);

    await pressZoomKey(harness, "-");
    await expect.poll(() => readZoomLevel(harness)).toBe(0);

    await pressZoomKey(harness, "-");
    await pressZoomKey(harness, "-");
    await expect.poll(() => readZoomLevel(harness)).toBe(-1);

    await pressZoomKey(harness, "0");
    await expect.poll(() => readZoomLevel(harness)).toBe(0);
  } finally {
    await harness.close();
  }
});
