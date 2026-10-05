import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { expect, type Page } from "@playwright/test";
import type { DesktopHarness } from "./desktop-harness";

export const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const desktopModifierKey = process.platform === "darwin" ? "Meta" : "Control";

export function desktopShortcut(keyChord: string): string {
  return `${desktopModifierKey}+${keyChord}`;
}

export async function pasteTinyPngViaClipboard(
  harness: DesktopHarness,
  window: Page,
  composerTestId = "composer",
): Promise<void> {
  const composer = window.getByTestId(composerTestId);
  await composer.click();
  await expect(composer).toBeFocused();
  await harness.clipboard.writeImage(TINY_PNG_BASE64);
  await composer.press(desktopShortcut("V"));
  await expect(window.locator(".composer-attachment")).toBeVisible();
}

export async function pasteTinyPngFromClipboardFiles(
  window: Page,
  fileName = "screenshot.png",
  composerTestId = "composer",
): Promise<void> {
  await dispatchTinyPngPaste(window, fileName, composerTestId, "files");
}

export async function pasteTinyPng(
  window: Page,
  fileName = "screenshot.png",
  composerTestId = "composer",
): Promise<void> {
  await dispatchTinyPngPaste(window, fileName, composerTestId, "data-transfer");
}

export async function dragFilesOverComposer(
  window: Page,
  filePaths: readonly string[],
  composerSurfaceTestId = "composer-surface",
): Promise<void> {
  const files = await Promise.all(filePaths.map(loadComposerDragFile));
  await dispatchComposerDragEvent(window, "dragenter", files, composerSurfaceTestId);
  await dispatchComposerDragEvent(window, "dragover", files, composerSurfaceTestId);
}

export async function dropFilesOnComposer(
  window: Page,
  filePaths: readonly string[],
  composerSurfaceTestId = "composer-surface",
): Promise<void> {
  const files = await Promise.all(filePaths.map(loadComposerDragFile));
  await dispatchComposerDragEvent(window, "drop", files, composerSurfaceTestId);
}

async function dispatchTinyPngPaste(
  window: Page,
  fileName: string,
  composerTestId: string,
  mode: "files" | "data-transfer",
): Promise<void> {
  await window.evaluate(
    ({ encodedPng, name, testId, clipboardMode }) => {
      const composer = document.querySelector<HTMLTextAreaElement>(`[data-testid='${testId}']`);
      if (!composer) {
        throw new Error(`Composer was unavailable for test id: ${testId}`);
      }

      const bytes = Uint8Array.from(atob(encodedPng), (char) => char.charCodeAt(0));
      const file = new File([bytes], name, { type: "image/png" });
      const event = new Event("paste", { bubbles: true, cancelable: true });
      const clipboardData =
        clipboardMode === "files"
          ? { items: [], files: [file], types: ["Files"] }
          : (() => {
              const transfer = new DataTransfer();
              transfer.items.add(file);
              return transfer;
            })();

      Object.defineProperty(event, "clipboardData", { configurable: true, value: clipboardData });
      composer.focus();
      composer.dispatchEvent(event);
    },
    { encodedPng: TINY_PNG_BASE64, name: fileName, testId: composerTestId, clipboardMode: mode },
  );
}

async function dispatchComposerDragEvent(
  window: Page,
  eventType: "dragenter" | "dragover" | "drop",
  files: readonly {
    readonly encoded: string;
    readonly mimeType: string;
    readonly name: string;
    readonly path: string;
  }[],
  composerSurfaceTestId: string,
): Promise<void> {
  await window.evaluate(
    ({ eventName, entries, surfaceTestId }) => {
      const surface = document.querySelector<HTMLElement>(`[data-testid='${surfaceTestId}']`);
      if (!surface) {
        throw new Error(`Composer surface was unavailable for test id: ${surfaceTestId}`);
      }

      const transfer = new DataTransfer();
      for (const entry of entries) {
        const bytes = Uint8Array.from(atob(entry.encoded), (char) => char.charCodeAt(0));
        const file = new File([bytes], entry.name, { type: entry.mimeType });
        Object.defineProperty(file, "path", { configurable: true, value: entry.path });
        transfer.items.add(file);
      }

      const event = new Event(eventName, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { configurable: true, value: transfer });
      surface.dispatchEvent(event);
    },
    { eventName: eventType, entries: files, surfaceTestId: composerSurfaceTestId },
  );
}

async function loadComposerDragFile(filePath: string): Promise<{
  readonly encoded: string;
  readonly mimeType: string;
  readonly name: string;
  readonly path: string;
}> {
  const buffer = await readFile(filePath);
  return {
    encoded: buffer.toString("base64"),
    mimeType: mimeTypeForTestFile(filePath),
    name: basename(filePath),
    path: filePath,
  };
}

function mimeTypeForTestFile(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".txt":
    case ".md":
      return "text/plain";
    case ".json":
      return "application/json";
    default:
      return "application/octet-stream";
  }
}

export async function stubNextOpenDialogResult(
  harness: DesktopHarness,
  result: { readonly canceled: boolean; readonly filePaths: readonly string[] },
): Promise<void> {
  await harness.dialogs.stubNextOpenDialog(result);
}

export async function stubNextOpenDialog(
  harness: DesktopHarness,
  filePaths: readonly string[],
): Promise<void> {
  await stubNextOpenDialogResult(harness, { canceled: false, filePaths });
}

export async function getOpenDialogInvocationCount(harness: DesktopHarness): Promise<number> {
  return harness.dialogs.openDialogCount();
}

export async function triggerNativeOpenFolderShortcut(harness: DesktopHarness): Promise<void> {
  await harness.keyboard.send({ keyCode: "o", modifiers: ["meta"] });
}

export async function getApplicationMenuItemInfo(
  harness: DesktopHarness,
  menuItemId: string,
): Promise<{ id: string; label: string; accelerator: string; parentLabel: string | null } | null> {
  return harness.menu.item(menuItemId);
}

export async function triggerApplicationMenuItem(
  harness: DesktopHarness,
  menuItemId: string,
): Promise<boolean> {
  return harness.menu.click(menuItemId);
}
