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
    await composer.fill("/st");
    const slashMenu = window.getByTestId("slash-menu");
    await expect(slashMenu).toBeVisible();
    await expect(slashMenu).toContainText("Status");
    const slashMenuBox = await slashMenu.boundingBox();
    const composerBox = await composer.boundingBox();
    expect(slashMenuBox).not.toBeNull();
    expect(composerBox).not.toBeNull();
    expect((slashMenuBox?.y ?? 0) + (slashMenuBox?.height ?? 0)).toBeLessThanOrEqual((composerBox?.y ?? 0) + 2);

    await composer.press("Tab");
    await expect(window.getByTestId("slash-menu")).toHaveCount(0);
    await expect(composer).toHaveValue("/status");
    await composer.press("Enter");
    await expect(window.locator(".timeline")).toContainText("Model");
    await expect(composer).toHaveValue("");

    await composer.fill("/thinking");
    const optionsMenu = window.getByTestId("slash-options-menu");
    await expect(optionsMenu).toBeVisible();
    await expect(optionsMenu).toContainText("Low");
    await expect(optionsMenu).toContainText("Extra High");
    await composer.press("ArrowDown");
    await composer.press("ArrowDown");
    await composer.press("Enter");
    await expect(optionsMenu).toHaveCount(0);
    await expect(window.locator(".timeline")).toContainText("Thinking set to high");
    await expect(window.locator(".composer__hint")).toContainText("high");
    await expect(composer).toHaveValue("");

    await composer.fill("/model");
    await expect(optionsMenu).toBeVisible();
    await optionsMenu.getByRole("button").first().click();
    await expect(optionsMenu).toHaveCount(0);
    const stateAfterModel = await getDesktopState(window);
    const selectedWorkspace = stateAfterModel.workspaces.find((workspace) => workspace.id === stateAfterModel.selectedWorkspaceId);
    const selectedSession = selectedWorkspace?.sessions.find((session) => session.id === stateAfterModel.selectedSessionId);
    const selectedConfig = selectedSession?.config;
    expect(selectedConfig?.provider).toBeTruthy();
    expect(selectedConfig?.modelId).toBeTruthy();
    await expect(window.locator(".timeline")).toContainText(`Model set to ${selectedConfig?.provider}:${selectedConfig?.modelId}`);
    await expect(window.locator(".composer__hint")).toContainText(`${selectedConfig?.provider}:${selectedConfig?.modelId}`);
    await expect(composer).toHaveValue("");

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

    const appRegions = await window.evaluate(() => {
      const topbar = document.querySelector<HTMLElement>("[data-testid='topbar']");
      const addFolder = document.querySelector<HTMLElement>(".topbar__actions button");
      return {
        topbar: topbar ? getComputedStyle(topbar).getPropertyValue("-webkit-app-region") : "",
        addFolder: addFolder ? getComputedStyle(addFolder).getPropertyValue("-webkit-app-region") : "",
      };
    });
    expect(appRegions.topbar).toBe("drag");
    expect(appRegions.addFolder).toBe("no-drag");

    const sizeBefore = await window.evaluate(() => `${window.outerWidth}x${window.outerHeight}`);
    await window.getByTestId("topbar").dblclick({ position: { x: 140, y: 12 } });
    await expect.poll(() => window.evaluate(() => `${window.outerWidth}x${window.outerHeight}`)).not.toBe(sizeBefore);
  } finally {
    await harness.close();
  }
});
