import { basename } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

test("folder rows start a new thread in that folder", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspaceA = await makeWorkspace("sidebar-new-thread-a");
  const workspaceB = await makeWorkspace("sidebar-new-thread-b");
  const harness = await launchDesktop(userDataDir, { initialWorkspaces: [workspaceA, workspaceB] });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspaceA);
    await waitForWorkspaceByPath(window, workspaceB);

    const workspacePicker = window.getByRole("combobox", { name: "Workspace" });
    for (const path of [workspaceB, workspaceA]) {
      await window.getByRole("button", { name: `New thread in ${basename(path)}` }).click();
      await expect(window.getByTestId("new-thread-composer")).toBeVisible();
      await expect(workspacePicker.locator("option:checked")).toHaveText(basename(path));
      await expect(window.getByTestId("topbar").locator(".topbar__workspace")).toHaveText(
        basename(path),
      );
    }
  } finally {
    await harness.close();
  }
});

test("the sidebar can be dragged wider, remembers its width and resets on double-click", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspace = await makeWorkspace("sidebar-width");
  const sidebarWidth = async (window: Page) =>
    Math.round((await window.locator("aside.sidebar").boundingBox())!.width);

  let harness = await launchDesktop(userDataDir, { initialWorkspaces: [workspace] });
  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspace);
    const defaultWidth = await sidebarWidth(window);

    const handle = window.getByRole("separator", { name: "Sidebar width" });
    const start = (await handle.boundingBox())!;
    await window.mouse.move(start.x + 3, start.y + 200);
    await window.mouse.down();
    await window.mouse.move(start.x + 103, start.y + 200, { steps: 10 });
    await window.mouse.up();
    await expect.poll(() => sidebarWidth(window)).toBe(defaultWidth + 100);

    // Dragging far past the limit stops at the maximum instead of swallowing the window.
    const widened = (await handle.boundingBox())!;
    await window.mouse.move(widened.x + 3, widened.y + 200);
    await window.mouse.down();
    await window.mouse.move(widened.x + 2000, widened.y + 200, { steps: 10 });
    await window.mouse.up();
    const max = Number(await handle.getAttribute("aria-valuemax"));
    expect(max).toBeGreaterThan(defaultWidth + 100);
    await expect.poll(() => sidebarWidth(window)).toBe(max);

    await handle.focus();
    await window.keyboard.press("Home");
    await expect.poll(() => sidebarWidth(window)).toBe(200);
    await window.keyboard.press("ArrowRight");
    await expect.poll(() => sidebarWidth(window)).toBe(220);
  } finally {
    await harness.close();
  }

  harness = await launchDesktop(userDataDir, { initialWorkspaces: [workspace] });
  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspace);
    await expect.poll(() => sidebarWidth(window)).toBe(220);

    await window.getByRole("separator", { name: "Sidebar width" }).dblclick();
    const defaultWidth = await window.evaluate(() =>
      Number.parseFloat(
        getComputedStyle(document.querySelector(".shell")!).getPropertyValue("--sidebar-width"),
      ),
    );
    await expect.poll(() => sidebarWidth(window)).toBe(defaultWidth);
  } finally {
    await harness.close();
  }
});
