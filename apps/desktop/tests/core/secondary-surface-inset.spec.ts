import { expect, test, type Page } from "@playwright/test";
import { launchDesktop, makeUserDataDir, makeWorkspace } from "../helpers/electron-app";

async function topOf(window: Page, selector: string): Promise<number> {
  const box = await window.locator(selector).boundingBox();
  if (!box) {
    throw new Error(`${selector} has no layout box`);
  }
  return box.y;
}

test("Back to app sits at the same offset below the window buttons as New thread", async ({}, testInfo) => {
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
    const newThreadTop = await topOf(window, ".sidebar__new");
    await window.screenshot({ path: testInfo.outputPath("threads.png") });

    for (const view of ["Settings", "Skills", "Extensions"] as const) {
      await window.getByRole("button", { name: view, exact: true }).click();
      const back = window.getByRole("button", { name: "Back to app", exact: true });
      await expect(back).toBeVisible();
      await window.screenshot({ path: testInfo.outputPath(`${view.toLowerCase()}.png`) });
      expect
        .soft(await topOf(window, ".secondary-surface__back"), view)
        .toBeCloseTo(newThreadTop, 0);
      await back.click();
      await expect(window.locator(".sidebar__new")).toBeVisible();
    }
  } finally {
    await harness.close();
  }
});
