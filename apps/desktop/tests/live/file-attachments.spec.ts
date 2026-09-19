import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  openNewThread,
  writeTextFile,
} from "../helpers/electron-app";

test("attached files reach the real runtime as usable context", async () => {
  test.setTimeout(180_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("live-file-attachments");
  const sentinel = `FILE-SENTINEL-${Date.now()}`;
  const filePath = join(workspacePath, "attached-context.txt");
  await writeTextFile(filePath, `The attached sentinel is ${sentinel}.\n`);

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await openNewThread(window);

    await window.locator('.new-thread input[type="file"]').setInputFiles([filePath]);
    await expect(window.locator(".new-thread .composer-attachment--file")).toContainText(
      "attached-context.txt",
    );

    await window
      .getByLabel("New thread prompt")
      .fill(
        "Read the attached file from disk and reply with only the exact sentinel string it contains.",
      );
    await window.getByRole("button", { name: "Start thread" }).click();

    await expect(window.locator(".timeline-item__attachment--file")).toContainText(
      "attached-context.txt",
      { timeout: 15_000 },
    );
    await expect(window.getByTestId("transcript")).toContainText(sentinel, { timeout: 150_000 });
  } finally {
    await harness.close();
  }
});
