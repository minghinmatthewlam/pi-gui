import { expect, test, type Page } from "@playwright/test";
import { launchDesktop, makeUserDataDir, makeWorkspace } from "../helpers/electron-app";

interface ControlLayout {
  readonly top: number;
  readonly height: number;
  readonly labelCenter: number;
}

async function layoutOf(
  window: Page,
  buttonSelector: string,
  label: string,
): Promise<ControlLayout> {
  const button = await window.locator(buttonSelector).boundingBox();
  const text = await window
    .locator(buttonSelector)
    .locator("span", { hasText: label })
    .boundingBox();
  if (!button || !text) {
    throw new Error(`${buttonSelector} has no layout box`);
  }
  return { top: button.y, height: button.height, labelCenter: text.y + text.height / 2 };
}

test("Back to app lines up with New thread below the window buttons", async ({}, testInfo) => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("secondary-surface-inset-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await expect(window.locator(".sidebar__new")).toBeVisible();
    const newThread = await layoutOf(window, ".sidebar__new", "New thread");
    await window.screenshot({ path: testInfo.outputPath("threads.png") });

    for (const view of ["Settings", "Skills", "Extensions"] as const) {
      await window.getByRole("button", { name: view, exact: true }).click();
      const back = window.getByRole("button", { name: "Back to app", exact: true });
      await expect(back).toBeVisible();
      await window.screenshot({ path: testInfo.outputPath(`${view.toLowerCase()}.png`) });
      const backToApp = await layoutOf(window, ".secondary-surface__back", "Back to app");
      expect.soft(backToApp.top, `${view} top`).toBeCloseTo(newThread.top, 0);
      expect.soft(backToApp.height, `${view} height`).toBeCloseTo(newThread.height, 0);
      expect.soft(backToApp.labelCenter, `${view} label`).toBeCloseTo(newThread.labelCenter, 0);
      await back.click();
      await expect(window.locator(".sidebar__new")).toBeVisible();
    }
  } finally {
    await harness.close();
  }
});
