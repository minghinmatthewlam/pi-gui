import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  stubNextOpenDialog,
  writeTinyPng,
} from "../helpers/electron-app";

test("attaches an image from a stubbed picker result and shows the attachment chip", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("native-attach-image-workspace");
  const imageDir = await mkdtemp(join(tmpdir(), "pi-gui-native-image-"));
  const imagePath = join(imageDir, "screenshot.png");
  await writeTinyPng(imagePath);

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Image attach session");

    await stubNextOpenDialog(harness, [imagePath]);
    await window.getByRole("button", { name: "Attach files" }).click();

    const thumb = window.getByRole("button", { name: "View screenshot.png" });
    await expect(thumb).toBeVisible();
    await expect(window.locator(".composer-attachment__name")).toHaveCount(0);

    const viewer = window.getByTestId("image-viewer");
    await thumb.click();
    await expect(viewer).toBeVisible();
    await expect(viewer.getByRole("img", { name: "screenshot.png" })).toBeVisible();
    await window.keyboard.press("Shift+Tab");
    await expect(viewer.getByRole("button", { name: "Close image" })).toBeFocused();
    await window.keyboard.press("Escape");
    await expect(viewer).toHaveCount(0);
    await expect(thumb).toBeFocused();

    await thumb.click();
    await expect(viewer).toBeVisible();
    await viewer.click({ position: { x: 8, y: 8 } });
    await expect(viewer).toHaveCount(0);

    await window.getByRole("button", { name: "Remove screenshot.png" }).click();
    await expect(window.locator(".composer-attachment")).toHaveCount(0);
  } finally {
    await harness.close();
  }
});
