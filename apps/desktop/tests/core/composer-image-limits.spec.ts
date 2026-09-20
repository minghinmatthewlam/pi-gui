import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  COMPOSER_IMAGE_MAX_BYTES,
  composerImageBytesLimitMessage,
  composerImageSavedSkipMessage,
} from "../../contracts/composer-attachments";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  stubNextOpenDialog,
  writeTinyPng,
} from "../helpers/electron-app";

test("rejects oversized drag-drop, picker, and forged IPC images with a composer error", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("composer-image-limits");
  const hugePath = join(workspacePath, "huge.png");
  const tinyPath = join(workspacePath, "tiny.png");
  await writeFile(hugePath, Buffer.alloc(COMPOSER_IMAGE_MAX_BYTES + 1, 1));
  await writeTinyPng(tinyPath);

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Image limits");

    await window.evaluate(
      ({ surfaceTestId, byteLength }) => {
        const surface = document.querySelector<HTMLElement>(`[data-testid='${surfaceTestId}']`);
        if (!surface) {
          throw new Error(`Composer surface was unavailable for test id: ${surfaceTestId}`);
        }
        const file = new File([new Uint8Array(byteLength)], "huge.png", { type: "image/png" });
        const transfer = new DataTransfer();
        transfer.items.add(file);
        const event = new Event("drop", { bubbles: true, cancelable: true });
        Object.defineProperty(event, "dataTransfer", { configurable: true, value: transfer });
        surface.dispatchEvent(event);
      },
      { surfaceTestId: "composer-surface", byteLength: COMPOSER_IMAGE_MAX_BYTES + 1 },
    );

    await expect(window.getByTestId("composer-error-banner")).toContainText(
      composerImageBytesLimitMessage(),
    );
    await expect(window.locator(".composer-attachment")).toHaveCount(0);

    await stubNextOpenDialog(harness, [hugePath]);
    await window.getByRole("button", { name: "Attach files" }).click();
    await expect(window.getByTestId("composer-error-banner")).toContainText(
      composerImageBytesLimitMessage(),
    );
    await expect(window.locator(".composer-attachment")).toHaveCount(0);

    const ipcError = await window.evaluate(
      async (data) => {
        try {
          await window.piApp?.addComposerAttachments([
            {
              id: "forged",
              kind: "image",
              name: "forged.png",
              mimeType: "image/png",
              data,
            },
          ]);
          return null;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
      Buffer.alloc(COMPOSER_IMAGE_MAX_BYTES + 1, 1).toString("base64"),
    );
    expect(ipcError).toContain("larger than 10 MB");
    await expect(window.getByTestId("composer-error-banner")).toContainText(
      composerImageBytesLimitMessage(),
    );
    await expect(window.locator(".composer-attachment")).toHaveCount(0);

    await stubNextOpenDialog(harness, [tinyPath]);
    await window.getByRole("button", { name: "Attach files" }).click();
    await expect(window.locator(".composer-attachment--image")).toHaveCount(1);
  } finally {
    await harness.close();
  }
});

test("relaunch skips oversized saved images without halting startup", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("composer-image-restore-limits");
  const first = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  let sessionRef = { workspaceId: "", sessionId: "" };
  try {
    const window = await first.firstWindow();
    await createNamedThread(window, "Restore limits");
    const state = await getDesktopState(window);
    sessionRef = {
      workspaceId: state.selectedWorkspaceId,
      sessionId: state.selectedSessionId,
    };
  } finally {
    await first.close();
  }

  const attachmentDir = join(userDataDir, "attachments");
  await mkdir(attachmentDir, { recursive: true });
  const attachmentPath = join(
    attachmentDir,
    `${encodeURIComponent(`${sessionRef.workspaceId}:${sessionRef.sessionId}`)}.json`,
  );
  const original = `${JSON.stringify(
    [
      {
        id: "tiny",
        kind: "image",
        name: "tiny.png",
        mimeType: "image/png",
        data: "eA==",
      },
      {
        id: "huge",
        kind: "image",
        name: "huge.png",
        mimeType: "image/png",
        data: Buffer.alloc(COMPOSER_IMAGE_MAX_BYTES + 1, 1).toString("base64"),
      },
    ],
    null,
    2,
  )}\n`;
  await writeFile(attachmentPath, original);

  const second = await launchDesktop(userDataDir, { testMode: "background" });
  try {
    const window = await second.firstWindow();
    await expect(window.getByTestId("startup-diagnostics")).toContainText(
      composerImageSavedSkipMessage(1),
    );
    await expect(window.locator(".composer-attachment")).toHaveCount(1);
    await expect(window.locator(".composer-attachment__name")).toContainText("tiny.png");
    expect(await readFile(attachmentPath, "utf8")).toBe(original);
  } finally {
    await second.close();
  }
  expect(await readFile(attachmentPath, "utf8")).toBe(original);
});
