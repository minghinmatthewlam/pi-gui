import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  commitAllInGitRepo,
  createNamedThread,
  desktopShortcut,
  initGitRepo,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
} from "../helpers/electron-app";

test("shows workspace file mentions from the composer and inserts the selected file", async () => {
  test.setTimeout(30_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("mention-workspace");
  await initGitRepo(workspacePath);
  await commitAllInGitRepo(workspacePath, "init");
  await mkdir(join(workspacePath, "src"), { recursive: true });
  await writeFile(join(workspacePath, "src", "App.tsx"), "export default App;\n", "utf8");
  await commitAllInGitRepo(workspacePath, "add src");

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Mention test");

    const composer = window.getByTestId("composer");
    await composer.click();
    await composer.pressSequentially("@");

    const mentionMenu = window.getByTestId("mention-menu");
    await expect(mentionMenu).toBeVisible();
    await expect(mentionMenu.locator(".mention-menu__section-title")).toHaveText([
      "Extensions",
      "Files",
    ]);
    await expect(mentionMenu.locator(".mention-menu__item")).toHaveCount(4);
    await expect(mentionMenu).toContainText("Thread orchestration");
    await expect(mentionMenu).toContainText("Scheduled tasks");

    await composer.pressSequentially("README");
    await expect(mentionMenu.locator(".mention-menu__item")).toHaveCount(1);
    await expect(mentionMenu.locator(".mention-menu__filename")).toContainText("README.md");

    await composer.press("Tab");
    await expect(mentionMenu).toHaveCount(0);
    await expect(composer).toHaveValue("@README.md ");

    await composer.click();
    await composer.press(desktopShortcut("A"));
    await composer.press("Backspace");
    await expect(composer).toHaveValue("");
    await composer.pressSequentially("@src");
    await expect(mentionMenu).toBeVisible();
    await composer.press("Escape");
    await expect(mentionMenu).toHaveCount(0);
    await expect(composer).toHaveValue("@src");
  } finally {
    await harness.close();
  }
});

test("toggles the diff panel from the keyboard shortcut and renders changed files on the right", async () => {
  test.setTimeout(30_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("diff-workspace");
  await initGitRepo(workspacePath);
  await commitAllInGitRepo(workspacePath, "init");
  await writeFile(join(workspacePath, "README.md"), "# diff-workspace\nnew line\n", "utf8");

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Diff test");

    const topbarActions = window.locator(".topbar__actions");
    await expect(topbarActions.locator(".topbar__icon")).toHaveCount(1);
    await expect(topbarActions.getByLabel("Toggle side panel")).toBeVisible();
    await expect(topbarActions.getByLabel("Toggle terminal")).toHaveCount(0);
    await expect(topbarActions.getByLabel("Toggle changes")).toHaveCount(0);
    await expect(topbarActions.getByLabel("Toggle files")).toHaveCount(0);
    await expect(topbarActions.getByLabel(/prompt navigation/i)).toHaveCount(0);
    await expect(topbarActions.getByLabel(/Evidence|Workbench|Open folder/i)).toHaveCount(0);

    const diffPanel = window.locator(".diff-panel");
    await expect(diffPanel).toBeVisible();
    await window.getByTestId("toggle-side-panel").click();
    await expect(diffPanel).toHaveCount(0);

    await window.keyboard.press(desktopShortcut("D"));
    await expect(diffPanel).toBeVisible();
    await expect(diffPanel.locator(".diff-panel__title")).toContainText("Changes");
    await expect(diffPanel.locator(".diff-panel__file-name")).toContainText("README.md");

    const mainBox = await window.locator(".main").boundingBox();
    const panelBox = await diffPanel.boundingBox();
    expect(mainBox).not.toBeNull();
    expect(panelBox).not.toBeNull();
    expect(panelBox?.x ?? 0).toBeGreaterThan((mainBox?.x ?? 0) + (mainBox?.width ?? 0) / 2);

    await diffPanel.locator(".diff-panel__file-name").click();
    const combined = diffPanel.getByRole("region", { name: "Combined changes", exact: true });
    await expect(combined.locator(".diff-inline")).toBeVisible();
    await expect(combined.locator(".diff-line--added")).toHaveCount(1);

    await window.getByTestId("toggle-side-panel").click();
    await expect(diffPanel).toHaveCount(0);
  } finally {
    await harness.close();
  }
});
