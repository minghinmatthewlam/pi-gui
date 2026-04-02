import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { getDesktopState, launchDesktop, makeUserDataDir, makeWorkspace, openNewThread, pasteTinyPng, seedAgentDir } from "../helpers/electron-app";

test("new thread reuses composer behaviors for slash commands, image previews, and branding", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("new-thread-composer-workspace");
  await seedAgentDir(agentDir);
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await openNewThread(window);

    const composer = window.getByTestId("new-thread-composer");
    await expect(window.getByTestId("new-thread-logo")).toBeVisible();
    await expect(window.getByRole("heading", { name: "Let's build" })).toBeVisible();
    await expect(composer).toBeFocused();

    const modelBadge = window.locator(".new-thread__hint .model-selector__badge").first();
    await expect(modelBadge).toBeVisible();
    await expect(window.locator('.new-thread input[type="file"]')).toBeHidden();

    await composer.fill("/stat");
    const slashMenu = window.getByTestId("slash-menu");
    await expect(slashMenu).toBeVisible();
    await expect(slashMenu).toContainText("Status");
    await composer.press("Tab");
    await expect(slashMenu).toHaveCount(0);
    await expect(composer).toHaveValue("/status");

    await composer.fill("Outline next steps /stat");
    await expect(slashMenu).toBeVisible();
    await expect(slashMenu).toContainText("Status");
    await composer.press("Tab");
    await expect(slashMenu).toHaveCount(0);
    await expect(composer).toHaveValue("Outline next steps /status");

    await composer.fill("");
    await pasteTinyPng(window, "new-thread-image.png", "new-thread-composer");
    const chip = window.locator(".composer-attachment");
    await expect(chip).toBeVisible();
    await expect(chip.locator(".composer-attachment__preview")).toBeVisible();
    await expect(chip.locator(".composer-attachment__name")).toContainText("new-thread-image.png");

    await window.getByRole("button", { name: "Start thread" }).click();

    await expect(window.getByTestId("composer")).toBeVisible({ timeout: 15_000 });
    await expect(window.locator(".timeline-item__attachment")).toBeVisible({ timeout: 15_000 });
    await expect(window.locator(".composer-attachment")).toHaveCount(0);
  } finally {
    await harness.close();
  }
});

test("new thread keeps onboarding notice visible until a default model is set", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("new-thread-no-default-workspace");
  await seedAgentDir(agentDir, { withDefaultModel: false });
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await openNewThread(window);

    const notice = window.getByTestId("model-onboarding-notice");
    const startButton = window.getByRole("button", { name: "Start thread" });
    const modelBadge = window.locator(".new-thread__hint .model-selector__badge").first();

    await window.getByTestId("new-thread-composer").fill("start a thread without a default");
    await expect(notice).toContainText("No default model set");
    await expect(modelBadge).toHaveText("No default model");
    await expect(startButton).toBeDisabled();

    await modelBadge.click();
    const dropdown = window.locator(".new-thread__hint .model-selector__dropdown").first();
    await expect(dropdown).toContainText("GPT-5");
    await expect(dropdown).toContainText("GPT-4o");
    await dropdown.getByRole("button", { name: /GPT-5/ }).click();

    await expect(modelBadge).toHaveText("openai:gpt-5");
    await expect(startButton).toBeEnabled();

    await startButton.click();

    await expect(window.getByTestId("composer")).toBeVisible({ timeout: 15_000 });
    await expect(window.getByTestId("model-onboarding-notice")).toContainText("No default model set");

    const composer = window.getByTestId("composer");
    await composer.fill("continue");
    await expect(window.getByTestId("send")).toBeEnabled();
  } finally {
    await harness.close();
  }
});

test("new thread routes disabled-model recovery to settings models", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("new-thread-empty-models-workspace");
  await seedAgentDir(agentDir);
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await openNewThread(window);

    const selectedWorkspaceId = (await getDesktopState(window)).selectedWorkspaceId;
    expect(selectedWorkspaceId).toBeTruthy();

    await window.evaluate(async ({ workspaceId }) => {
      const app = window.piApp;
      if (!app) {
        throw new Error("piApp IPC bridge is unavailable");
      }
      await app.setScopedModelPatterns(workspaceId, ["fake-provider/fake-model"]);
    }, { workspaceId: selectedWorkspaceId });

    await window.getByTestId("new-thread-composer").fill("try to start with all models disabled");
    const modelBadge = window.locator(".new-thread__hint .model-selector__badge").first();
    await expect(modelBadge).toBeVisible();
    await expect(modelBadge).toHaveText("No models available");
    await expect(window.getByTestId("model-onboarding-notice")).toContainText("Settings > Models");
    await expect(window.getByRole("button", { name: "Start thread" })).toBeDisabled();

    await modelBadge.click();
    const dropdown = window.locator(".new-thread__hint .model-selector__dropdown").first();
    await expect(dropdown).toBeVisible();
    await expect(dropdown).toContainText("No models available");
    await expect(dropdown).toContainText("Open Settings > Models to enable a model and choose a default.");

    await window.getByTestId("model-onboarding-notice").getByRole("button", { name: "Open Settings > Models" }).click();
    await expect(window.getByTestId("settings-surface")).toBeVisible();
    await expect(window.locator(".view-header__title")).toHaveText("Models");
  } finally {
    await harness.close();
  }
});
