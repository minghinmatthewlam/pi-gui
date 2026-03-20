import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "@playwright/test";
import { getDesktopState, launchDesktop, makeWorkspace, type PiAppWindow } from "./harness";

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7ZfXQAAAAASUVORK5CYII=";

test("supports slash commands plus image draft preview and removal", async () => {
  test.setTimeout(60_000);
  const userDataDir = await mkdtemp(join(tmpdir(), "pi-app-user-data-"));
  const workspacePath = await makeWorkspace("controls-workspace");
  const harness = await launchDesktop(userDataDir, [workspacePath]);

  try {
    const window = await harness.firstWindow();
    const workspaceId = await window.evaluate(async () => {
      const app = (window as PiAppWindow).piApp;
      if (!app) throw new Error("piApp unavailable");
      const state = await app.getState();
      const workspace = state.workspaces[0];
      if (!workspace) throw new Error("Expected workspace");
      await app.createSession({ workspaceId: workspace.id, title: "Controls session" });
      return workspace.id;
    });

    await expect(window.locator(".topbar__session")).toHaveText("Controls session");

    const composer = window.getByTestId("composer");
    await composer.fill("/");
    await expect(window.locator(".slash-menu")).toBeVisible();
    await expect(window.locator(".slash-menu")).toContainText("Model");
    await expect(window.locator(".slash-menu")).toContainText("Reasoning");

    await window.evaluate(async () => {
      const app = (window as PiAppWindow).piApp;
      if (!app) throw new Error("piApp unavailable");
      await app.submitComposer("/thinking high");
    });
    await expect(window.locator(".timeline")).toContainText("Thinking set to high");
    await expect(window.locator(".composer__hint")).toContainText("high");

    await window.evaluate(async () => {
      const app = (window as PiAppWindow).piApp;
      if (!app) throw new Error("piApp unavailable");
      await app.submitComposer("/model openai gpt-5.4");
    });
    await expect(window.locator(".timeline")).toContainText("Model set to openai:gpt-5.4");
    await expect(window.locator(".composer__hint")).toContainText("openai:gpt-5.4");

    await window.evaluate(async (data) => {
      const app = (window as PiAppWindow).piApp;
      if (!app) throw new Error("piApp unavailable");
      await app.addComposerImages([
        {
          id: "img-test-1",
          name: "image.png",
          mimeType: "image/png",
          data,
        },
      ]);
    }, TINY_PNG_BASE64);

    await expect(window.locator(".composer-attachment")).toContainText("image.png");
    await window.getByRole("button", { name: "Remove image.png" }).click();
    await expect(window.locator(".composer-attachment")).toHaveCount(0);

    await window.evaluate(async (data) => {
      const app = (window as PiAppWindow).piApp;
      if (!app) throw new Error("piApp unavailable");
      await app.addComposerImages([
        {
          id: "img-test-2",
          name: "image.png",
          mimeType: "image/png",
          data,
        },
      ]);
    }, TINY_PNG_BASE64);

    await expect(window.locator(".composer-attachment")).toContainText("image.png");
    const state = await getDesktopState(window);
    expect(state.composerAttachments).toHaveLength(1);
    expect(state.composerAttachments[0]?.name).toBe("image.png");
    expect(state.workspaces.find((workspace) => workspace.id === workspaceId)?.sessions).toHaveLength(1);
  } finally {
    await harness.close();
  }
});
