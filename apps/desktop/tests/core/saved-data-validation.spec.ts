import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  desktopShortcut,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  createNamedThread,
  getDesktopState,
} from "../helpers/electron-app";

for (const legacyMigration of [false, true]) {
  test(`invalid saved attachments remain intact${legacyMigration ? " during legacy migration" : ""} and report a startup diagnostic`, async () => {
    const userDataDir = await makeUserDataDir();
    const workspacePath = await makeWorkspace("invalid-attachments");
    const first = await launchDesktop(userDataDir, {
      initialWorkspaces: [workspacePath],
      testMode: "background",
    });
    let key = "";
    try {
      const window = await first.firstWindow();
      await createNamedThread(window, "Attachment recovery");
      const state = await getDesktopState(window);
      key = `${state.selectedWorkspaceId}:${state.selectedSessionId}`;
    } finally {
      await first.close();
    }
    const attachmentDir = join(userDataDir, "attachments");
    await mkdir(attachmentDir, { recursive: true });
    const attachmentPath = join(attachmentDir, `${encodeURIComponent(key)}.json`);
    const original =
      '[{"id":"retained","kind":"image","name":"retained.png","mimeType":"image/png","data":"eA=="},null]';
    await writeFile(attachmentPath, original);
    const uiStatePath = join(userDataDir, "ui-state.json");
    if (legacyMigration) {
      const saved = JSON.parse(await readFile(uiStatePath, "utf8")) as Record<string, unknown>;
      saved.composerAttachmentsBySession = {
        [key]: [{ id: "legacy", name: "legacy.png", mimeType: "image/png", data: "eA==" }],
      };
      await writeFile(uiStatePath, JSON.stringify(saved));
    }
    const originalUi = await readFile(uiStatePath, "utf8");
    const second = await launchDesktop(userDataDir, { testMode: "background" });
    try {
      const window = await second.firstWindow();
      await expect(window.getByTestId("startup-diagnostics")).toContainText(/attachment/i);
      expect(await readFile(attachmentPath, "utf8")).toBe(original);
    } finally {
      await second.close();
    }
    expect(await readFile(attachmentPath, "utf8")).toBe(original);
    expect(await readFile(uiStatePath, "utf8")).toBe(originalUi);
  });
}

test("invalid catalog reports recovery trouble without pruning attachments across restart", async () => {
  const userDataDir = await makeUserDataDir();
  const catalogPath = join(userDataDir, "catalogs.json");
  const original = JSON.stringify({
    version: 2,
    workspaces: [],
    sessions: [null],
    worktrees: [],
    sessionFiles: {},
  });
  await writeFile(catalogPath, original);
  const attachmentPath = join(userDataDir, "attachments", "retained.json");
  await mkdir(join(userDataDir, "attachments"), { recursive: true });
  const retainedAttachment = JSON.stringify([
    {
      id: "retained",
      kind: "file",
      name: "evidence.txt",
      mimeType: "text/plain",
      fsPath: "/retained/evidence.txt",
    },
  ]);
  await writeFile(attachmentPath, retainedAttachment);

  for (let attempt = 0; attempt < 2; attempt++) {
    const harness = await launchDesktop(userDataDir, { testMode: "background" });
    try {
      const window = await harness.firstWindow();
      await expect(window.getByTestId("startup-diagnostics")).toContainText(/catalog|sessions/i);
      await expect(window.getByTestId("startup-diagnostics")).toBeVisible();
      expect(await readFile(catalogPath, "utf8")).toBe(original);
      expect(await readFile(attachmentPath, "utf8")).toBe(retainedAttachment);
    } finally {
      await harness.close();
    }
    expect(await readFile(catalogPath, "utf8")).toBe(original);
    expect(await readFile(attachmentPath, "utf8")).toBe(retainedAttachment);
  }
});

test("invalid providers show an error and cannot falsely save an endpoint", async () => {
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspace = await makeWorkspace("invalid-providers");
  await seedAgentDir(agentDir, { enabledModels: [] });
  const modelsPath = join(agentDir, "models.json");
  const original = '{"providers":[],"retained":"user data"}\n';
  await writeFile(modelsPath, original);
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspace],
    scrubProviderEnv: true,
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await window.keyboard.press(desktopShortcut(","));
    await expect(window.getByTestId("settings-surface")).toBeVisible();
    await window.getByRole("button", { name: "Providers", exact: true }).click();
    const section = window.locator(".settings-section", {
      has: window.locator(".settings-section__title", { hasText: "Custom endpoints" }),
    });
    await expect(section.locator(".settings-warning")).toContainText(/providers/i);
    await section.getByRole("button", { name: "Add endpoint", exact: true }).click();
    const dialog = window.getByTestId("custom-endpoint-dialog");
    await dialog.getByLabel("Provider ID").fill("saved-data-proof");
    await dialog.getByLabel("Base URL").fill("http://localhost:11434/v1");
    await dialog.getByLabel("Add model ID manually").fill("test-model");
    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    await dialog.getByRole("button", { name: "Add endpoint", exact: true }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(/JSON object for providers/i);
    expect(await readFile(modelsPath, "utf8")).toBe(original);
  } finally {
    await harness.close();
  }
  expect(await readFile(modelsPath, "utf8")).toBe(original);
});
