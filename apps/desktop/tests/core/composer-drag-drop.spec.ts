import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  dragFilesOverComposer,
  dropFilesOnComposer,
  getSelectedTranscript,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  openNewThread,
  stubNextOpenDialog,
  writeTextFile,
  writeTinyPng,
} from "../helpers/electron-app";

test("existing thread highlights and accepts dropped images and files", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("composer-drop-existing-thread");
  const imagePath = join(workspacePath, "drop-image.png");
  const filePath = join(workspacePath, "notes.txt");
  await writeTinyPng(imagePath);
  await writeTextFile(filePath, "drag-and-drop file sentinel");

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Drop attachments");

    await dragFilesOverComposer(window, [imagePath, filePath], "composer-surface");
    await expect(window.getByTestId("composer-drop-indicator")).toBeVisible();

    await dropFilesOnComposer(window, [imagePath, filePath], "composer-surface");

    await expect(window.getByTestId("composer-drop-indicator")).toHaveCount(0);
    await expect(window.locator(".composer-attachment--image")).toHaveCount(1);
    await expect(window.locator(".composer-attachment--file")).toHaveCount(1);
    await expect(window.locator(".composer-attachment__name")).toContainText([
      "drop-image.png",
      "notes.txt",
    ]);
  } finally {
    await harness.close();
  }
});

test("new thread reuses drag-drop attachments and carries them into the transcript", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("composer-drop-new-thread");
  const imagePath = join(workspacePath, "drop-image.png");
  const filePath = join(workspacePath, "notes.txt");
  await writeTinyPng(imagePath);
  await writeTextFile(filePath, "new-thread file sentinel");

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await openNewThread(window);

    await dragFilesOverComposer(window, [imagePath, filePath], "new-thread-composer-surface");
    await expect(window.getByTestId("composer-drop-indicator")).toBeVisible();

    await dropFilesOnComposer(window, [imagePath, filePath], "new-thread-composer-surface");

    await expect(window.locator(".new-thread .composer-attachment--image")).toHaveCount(1);
    await expect(window.locator(".new-thread .composer-attachment--file")).toHaveCount(1);

    await window.getByRole("button", { name: "Start thread" }).click();

    await expect(window.getByTestId("composer")).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(
        async () => {
          const transcript = await getSelectedTranscript(window);
          const userMessage = transcript?.transcript.find(
            (entry): entry is Extract<typeof entry, { kind: "message" }> =>
              entry.kind === "message" && entry.role === "user",
          );
          return (
            userMessage?.attachments
              ?.map((attachment) => attachment.kind)
              .sort()
              .join(",") ?? ""
          );
        },
        { timeout: 15_000 },
      )
      .toBe("file,image");
    await expect(window.locator(".timeline-item__attachment--image")).toHaveCount(1, {
      timeout: 15_000,
    });
    await expect(window.locator(".timeline-item__attachment--file")).toContainText("notes.txt", {
      timeout: 15_000,
    });
  } finally {
    await harness.close();
  }
});

test("attach controls add mixed attachments in both composer flows", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("composer-picker-attachments");
  const imagePath = join(workspacePath, "picker-image.png");
  const filePath = join(workspacePath, "picker-notes.txt");
  await writeTinyPng(imagePath);
  await writeTextFile(filePath, "picker file sentinel");

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Picker attachments");

    await stubNextOpenDialog(harness, [imagePath, filePath]);
    await window.getByRole("button", { name: "Attach files" }).click();
    await expect(window.locator(".composer-attachment--image")).toHaveCount(1);
    await expect(window.locator(".composer-attachment--file")).toHaveCount(1);

    await openNewThread(window);
    await window.locator('.new-thread input[type="file"]').setInputFiles([imagePath, filePath]);
    await expect(window.locator(".new-thread .composer-attachment--image")).toHaveCount(1);
    await expect(window.locator(".new-thread .composer-attachment--file")).toHaveCount(1);
  } finally {
    await harness.close();
  }
});
