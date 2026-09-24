import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { expect, test, type Page } from "@playwright/test";
import {
  COMPOSER_IMAGE_MAX_BYTES,
  COMPOSER_IMAGE_MAX_DIMENSION,
  composerImageAggregateLimitMessage,
  composerImageBytesLimitMessage,
  composerImagePixelsLimitMessage,
  composerImageSavedSkipMessage,
} from "../../contracts/composer-attachments";
import {
  TINY_PNG_BASE64,
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  openNewThread,
  seedAgentDir,
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
    await expect(window.locator(".composer-attachment__preview")).toHaveAttribute(
      "title",
      "tiny.png",
    );
    await captureComposerProof(window, "composer_restore_skip_diagnostic.png");
    expect(await readFile(attachmentPath, "utf8")).toBe(original);
  } finally {
    await second.close();
  }
  expect(await readFile(attachmentPath, "utf8")).toBe(original);
});

test("relaunch skips oversize-pixel saved images without rewriting the attachment file", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("composer-image-restore-pixels");
  const first = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  let sessionRef = { workspaceId: "", sessionId: "" };
  const widePng = createRgbPng(COMPOSER_IMAGE_MAX_DIMENSION + 1, 1);
  const wideData = widePng.toString("base64");
  try {
    const window = await first.firstWindow();
    await createNamedThread(window, "Restore pixel limits");
    const size = await first.electronApp.evaluate(({ nativeImage }, data) => {
      const image = nativeImage.createFromBuffer(Buffer.from(data, "base64"));
      return { empty: image.isEmpty(), ...image.getSize() };
    }, wideData);
    expect(size.empty).toBe(false);
    expect(size.width).toBe(COMPOSER_IMAGE_MAX_DIMENSION + 1);
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
        data: TINY_PNG_BASE64,
      },
      {
        id: "wide",
        kind: "image",
        name: "wide.png",
        mimeType: "image/png",
        data: wideData,
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
    await expect(window.locator(".composer-attachment__preview")).toHaveAttribute(
      "title",
      "tiny.png",
    );
    await expect(window.getByRole("button", { name: "View wide.png" })).toHaveCount(0);
    await captureComposerProof(window, "composer_restore_pixel_skip.png");
    expect(await readFile(attachmentPath, "utf8")).toBe(original);
  } finally {
    await second.close();
  }
  expect(await readFile(attachmentPath, "utf8")).toBe(original);
});

test("legacy migration skips oversize-pixel images before the composer map", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("composer-image-legacy-pixels");
  const first = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  let sessionKey = "";
  const wideData = createRgbPng(COMPOSER_IMAGE_MAX_DIMENSION + 1, 1).toString("base64");
  try {
    const window = await first.firstWindow();
    await createNamedThread(window, "Legacy pixel limits");
    const state = await getDesktopState(window);
    sessionKey = `${state.selectedWorkspaceId}:${state.selectedSessionId}`;
  } finally {
    await first.close();
  }

  const attachmentPath = join(userDataDir, "attachments", `${encodeURIComponent(sessionKey)}.json`);
  try {
    await unlink(attachmentPath);
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }

  const uiStatePath = join(userDataDir, "ui-state.json");
  const saved = JSON.parse(await readFile(uiStatePath, "utf8")) as Record<string, unknown>;
  saved.composerAttachmentsBySession = {
    [sessionKey]: [
      {
        id: "tiny",
        kind: "image",
        name: "tiny.png",
        mimeType: "image/png",
        data: TINY_PNG_BASE64,
      },
      {
        id: "wide",
        kind: "image",
        name: "wide.png",
        mimeType: "image/png",
        data: wideData,
      },
    ],
  };
  await writeFile(uiStatePath, `${JSON.stringify(saved, null, 2)}\n`);

  const second = await launchDesktop(userDataDir, { testMode: "background" });
  try {
    const window = await second.firstWindow();
    await expect(window.getByTestId("startup-diagnostics")).toContainText(
      composerImageSavedSkipMessage(1),
    );
    await expect(window.locator(".composer-attachment")).toHaveCount(1);
    await expect(window.locator(".composer-attachment__preview")).toHaveAttribute(
      "title",
      "tiny.png",
    );
    await expect(window.getByRole("button", { name: "View wide.png" })).toHaveCount(0);
    const migrated = JSON.parse(await readFile(attachmentPath, "utf8")) as Array<{
      readonly id: string;
    }>;
    expect(migrated.map((attachment) => attachment.id)).toEqual(["tiny"]);
  } finally {
    await second.close();
  }
});

test("startThread rejects oversize-pixel images without clearing the new-thread draft", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("composer-image-start-thread-pixels");
  await seedAgentDir(agentDir);
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  const wideData = createRgbPng(COMPOSER_IMAGE_MAX_DIMENSION + 1, 1).toString("base64");

  try {
    const window = await harness.firstWindow();
    await openNewThread(window);
    const composer = window.getByTestId("new-thread-composer");
    await composer.fill("keep this draft");
    const before = await getDesktopState(window);

    const result = await window.evaluate(async (data) => {
      const app = globalThis.window.piApp;
      if (!app) {
        throw new Error("piApp IPC bridge is unavailable");
      }
      const state = await app.getState();
      const workspace =
        state.workspaces.find((entry) => entry.id === state.selectedWorkspaceId) ??
        state.workspaces[0];
      if (!workspace) {
        throw new Error("No workspace available for startThread");
      }
      try {
        await app.startThread({
          rootWorkspaceId: workspace.rootWorkspaceId ?? workspace.id,
          environment: "local",
          prompt: "keep this draft",
          attachments: [
            {
              id: "wide",
              kind: "image",
              name: "wide.png",
              mimeType: "image/png",
              data,
            },
          ],
        });
        return { resolved: true, message: "" };
      } catch (error: unknown) {
        return {
          resolved: false,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }, wideData);

    expect(result.resolved).toBe(false);
    expect(result.message).toContain(composerImagePixelsLimitMessage());
    await expect(composer).toHaveValue("keep this draft");
    await expect(window.getByTestId("new-thread-composer")).toBeVisible();
    const after = await getDesktopState(window);
    expect(after.activeView).toBe("new-thread");
    expect(after.selectedSessionId).toBe(before.selectedSessionId);
    await captureComposerProof(window, "composer_start_thread_pixel_reject.png");
  } finally {
    await harness.close();
  }
});

function createRgbPng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows = Buffer.alloc(height * (1 + width * 3));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(rows, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, checksum]);
}

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
