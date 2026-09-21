import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  createNamedThread,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
} from "../helpers/electron-app";

async function expectConversationFileExplorerSplit(window: Page): Promise<void> {
  const conversation = window.locator(".canvas--thread");
  const editor = window.getByTestId("file-editor");
  const explorer = window.getByTestId("file-explorer");
  await expect(conversation).toBeVisible();
  await expect(editor).toBeVisible();
  await expect(explorer).toBeVisible();

  const conversationBox = await conversation.boundingBox();
  const editorBox = await editor.boundingBox();
  const explorerBox = await explorer.boundingBox();
  expect(conversationBox).not.toBeNull();
  expect(editorBox).not.toBeNull();
  expect(explorerBox).not.toBeNull();
  if (!conversationBox || !editorBox || !explorerBox) {
    throw new Error("Expected conversation, editor, and explorer boxes");
  }

  expect(conversationBox.x + conversationBox.width).toBeLessThanOrEqual(editorBox.x + 2);
  expect(editorBox.x + editorBox.width).toBeLessThanOrEqual(explorerBox.x + 2);
  expect(Math.abs(editorBox.y - explorerBox.y)).toBeLessThan(8);
  await expect(window.locator(".diff-panel")).toHaveCount(0);
}

test("Files workbench puts the explorer to the right of an open file pane", async () => {
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

    const workbench = window.getByTestId("file-workbench");
    await expect(workbench).toBeVisible();
    await expect(window.locator(".diff-panel")).toHaveCount(0);
    await expect(window.getByTestId("file-workbench-filter")).toHaveAttribute(
      "placeholder",
      "Filter files…",
    );
    await expectConversationFileExplorerSplit(window);

    const tree = window.getByTestId("file-workbench-tree");
    await expect(
      tree.locator('.file-workbench__tree-row--file[data-file-path="README.md"]'),
    ).toBeVisible();
    await expect(
      tree.locator('.file-workbench__tree-row--file[data-file-path="src/app.ts"]'),
    ).toHaveCount(0);

    await tree.locator(".file-workbench__tree-row--dir", { hasText: "src" }).click();
    await expect(
      tree.locator('.file-workbench__tree-row--file[data-file-path="src/app.ts"]'),
    ).toBeVisible();
    await tree.locator('.file-workbench__tree-row--file[data-file-path="src/app.ts"]').click();

    const editor = window.getByTestId("file-editor");
    await expect(editor.getByTestId("file-workbench-tab")).toContainText("app.ts");
    await expect(editor.getByTestId("file-editor-breadcrumb")).toContainText("src");
    await expect(editor.getByTestId("file-workbench-preview")).toContainText("export const ready");
    await expect(
      window.getByTestId("file-explorer").getByTestId("file-workbench-preview"),
    ).toHaveCount(0);

    await window.getByTestId("file-workbench-filter").fill("app.ts");
    await expect(
      tree.locator('.file-workbench__tree-row--file[data-file-path="README.md"]'),
    ).toHaveCount(0);
    await expect(
      tree.locator('.file-workbench__tree-row--file[data-file-path="src/app.ts"]'),
    ).toBeVisible();
  } finally {
    await harness.close();
  }
});
