import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
} from "../helpers/electron-app";

test("Files panel lists a normal folder workspace that is not a git repo", async () => {
  test.setTimeout(45_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("plain-files-workspace");
  await mkdir(join(workspacePath, "src"), { recursive: true });
  await writeFile(join(workspacePath, "src", "app.ts"), "export const ready = true;\n", "utf8");

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Plain folder files");
    await window.locator(".topbar__actions").getByLabel("Toggle files").click();

    const diffPanel = window.locator(".diff-panel");
    await expect(diffPanel.locator(".diff-panel__title")).toHaveText("Files");
    await expect(diffPanel.getByTestId("file-workbench-tree")).toBeVisible();
    await expect(diffPanel.locator(".file-workbench__section-header")).toContainText("2");
    await expect(
      diffPanel.locator('.file-workbench__tree-row--file[data-file-path="README.md"]'),
    ).toBeVisible();
    await expect(
      diffPanel.locator('.file-workbench__tree-row--file[data-file-path="src/app.ts"]'),
    ).toBeVisible();
    await expect(
      diffPanel.locator(".file-workbench__section--tree .diff-panel__empty"),
    ).toHaveCount(0);

    await diffPanel.locator('.file-workbench__tree-row--file[data-file-path="src/app.ts"]').click();
    await expect(diffPanel.getByTestId("file-workbench-preview")).toContainText(
      "export const ready",
    );
  } finally {
    await harness.close();
  }
});
