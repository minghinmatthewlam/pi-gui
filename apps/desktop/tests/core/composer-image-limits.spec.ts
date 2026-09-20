import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  COMPOSER_IMAGE_MAX_BYTES,
  composerImageAggregateLimitMessage,
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
  type DesktopHarness,
} from "../helpers/electron-app";

test("rejects oversized drag-drop, picker, and forged IPC images with a composer error", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("composer-image-limits");
  const hugePath = join(workspacePath, "huge.png");
  const tinyPath = join(workspacePath, "tiny.png");
  const bulkPaths = [0, 1, 2, 3].map((index) => join(workspacePath, `bulk-${index}.png`));
  await writeFile(hugePath, Buffer.alloc(COMPOSER_IMAGE_MAX_BYTES + 1, 1));
  await writeTinyPng(tinyPath);
  await Promise.all(
    bulkPaths.map((filePath) => writeFile(filePath, Buffer.alloc(COMPOSER_IMAGE_MAX_BYTES, 1))),
  );

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

    await expect(window.getByTestId("composer-error-banner")).toHaveText(
      composerImageBytesLimitMessage(),
    );
    await expect(window.locator(".composer-attachment")).toHaveCount(0);
    await captureComposerProof(window, "composer_oversize_error.png");

    await attachTinyAndClear(window, harness, tinyPath);

    await stubNextOpenDialog(harness, [hugePath]);
    await window.getByRole("button", { name: "Attach files" }).click();
    await expect(window.getByTestId("composer-error-banner")).toHaveText(
      composerImageBytesLimitMessage(),
    );
    await expect(window.locator(".composer-attachment")).toHaveCount(0);

    await attachTinyAndClear(window, harness, tinyPath);

    await stubNextOpenDialog(harness, bulkPaths);
    await window.getByRole("button", { name: "Attach files" }).click();
    await expect(window.getByTestId("composer-error-banner")).toHaveText(
      composerImageAggregateLimitMessage(),
    );
    await expect(window.locator(".composer-attachment")).toHaveCount(0);

    await attachTinyAndClear(window, harness, tinyPath);

    await window.evaluate(
      async (data) => {
        const app = globalThis.window.piApp;
        if (!app) {
          throw new Error("piApp IPC bridge is unavailable");
        }
        await app.addComposerAttachments([
          {
            id: "forged",
            kind: "image",
            name: "forged.png",
            mimeType: "image/png",
            data,
          },
        ]);
      },
      Buffer.alloc(COMPOSER_IMAGE_MAX_BYTES + 1, 1).toString("base64"),
    );
    expect((await getDesktopState(window)).lastError).toBe(composerImageBytesLimitMessage());
    await expect(window.getByTestId("composer-error-banner")).toHaveText(
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
    await captureComposerProof(window, "composer_restore_skip_diagnostic.png");
    expect(await readFile(attachmentPath, "utf8")).toBe(original);
  } finally {
    await second.close();
  }
  expect(await readFile(attachmentPath, "utf8")).toBe(original);
});

async function attachTinyAndClear(
  window: Page,
  harness: DesktopHarness,
  tinyPath: string,
): Promise<void> {
  await stubNextOpenDialog(harness, [tinyPath]);
  await window.getByRole("button", { name: "Attach files" }).click();
  await expect(window.locator(".composer-attachment--image")).toHaveCount(1);
  await window.getByRole("button", { name: "Remove tiny.png" }).click();
  await expect(window.locator(".composer-attachment")).toHaveCount(0);
  await expect(window.getByTestId("composer-error-banner")).toHaveCount(0);
}

async function captureComposerProof(window: Page, fileName: string): Promise<void> {
  const captureDir =
    process.env.PI_APP_CAPTURE_ARTIFACTS ??
    (existsSync("/opt/cursor/artifacts") ? "/opt/cursor/artifacts" : undefined);
  if (!captureDir) {
    return;
  }
  await mkdir(captureDir, { recursive: true });
  await window.screenshot({ path: join(captureDir, fileName), fullPage: false });
}
