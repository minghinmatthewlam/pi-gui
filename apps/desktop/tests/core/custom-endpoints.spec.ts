import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  desktopShortcut,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
} from "../helpers/electron-app";

async function readModelsJson(agentDir: string): Promise<Record<string, unknown>> {
  const raw = await readFile(join(agentDir, "models.json"), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

async function openProvidersSettings(window: Awaited<ReturnType<Awaited<ReturnType<typeof launchDesktop>>["firstWindow"]>>) {
  await window.keyboard.press(desktopShortcut(","));
  await expect(window.getByTestId("settings-surface")).toBeVisible();
  await window.getByRole("button", { name: "Providers", exact: true }).click();
  await expect(window.locator(".view-header__title")).toHaveText("Providers");
}

test("settings lets the user add, edit, and delete an OpenAI-compatible custom endpoint", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("custom-endpoints-add-workspace");
  await seedAgentDir(agentDir, { enabledModels: [] });

  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await openProvidersSettings(window);

    const customEndpoints = window.locator(".settings-section", {
      has: window.locator(".settings-section__title", { hasText: "Custom endpoints" }),
    });
    await expect(customEndpoints).toContainText("No custom endpoints yet.");
    await customEndpoints.getByRole("button", { name: "Add endpoint", exact: true }).click();

    const dialog = window.getByTestId("custom-endpoint-dialog");
    await expect(dialog).toBeVisible();

    await dialog.getByLabel("Provider ID").fill("ollama-local");
    await dialog.getByLabel("Base URL").fill("http://localhost:11434/v1");
    await dialog.getByLabel("Add model ID manually").fill("llama3.1");
    await dialog.getByRole("button", { name: "Add", exact: true }).click();

    await dialog.getByRole("button", { name: "Add endpoint", exact: true }).click();
    await expect(dialog).toHaveCount(0);

    const entryRow = customEndpoints.locator(".settings-row", {
      has: window.locator(".settings-row__title", { hasText: /^ollama-local$/ }),
    });
    await expect(entryRow).toContainText("http://localhost:11434/v1");
    await expect(entryRow).toContainText("1 model");

    const savedModels = await readModelsJson(agentDir);
    const savedProviders = savedModels.providers as Record<string, Record<string, unknown>>;
    expect(savedProviders["ollama-local"]).toMatchObject({
      baseUrl: "http://localhost:11434/v1",
      api: "openai-completions",
      apiKey: "unused",
      models: [{ id: "llama3.1" }],
    });

    // Edit flow: change base URL.
    await entryRow.getByRole("button", { name: "Edit", exact: true }).click();
    const editDialog = window.getByTestId("custom-endpoint-dialog");
    await expect(editDialog).toBeVisible();
    await expect(editDialog.getByLabel("Provider ID")).toBeDisabled();
    const baseUrlInput = editDialog.getByLabel("Base URL");
    await baseUrlInput.fill("http://localhost:8000/v1");
    await editDialog.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(editDialog).toHaveCount(0);
    await expect(entryRow).toContainText("http://localhost:8000/v1");

    const editedModels = await readModelsJson(agentDir);
    const editedProviders = editedModels.providers as Record<string, Record<string, unknown>>;
    expect(editedProviders["ollama-local"]).toMatchObject({
      baseUrl: "http://localhost:8000/v1",
    });

    // Delete flow.
    await entryRow.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(customEndpoints).toContainText("No custom endpoints yet.");

    const afterDelete = await readModelsJson(agentDir);
    const afterDeleteProviders = (afterDelete.providers as Record<string, unknown>) ?? {};
    expect(afterDeleteProviders["ollama-local"]).toBeUndefined();
  } finally {
    await harness.close();
  }
});

test("custom endpoint dialog blocks colliding provider IDs and invalid base URLs", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("custom-endpoints-validation-workspace");
  await seedAgentDir(agentDir, { enabledModels: [] });

  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await openProvidersSettings(window);

    const customEndpoints = window.locator(".settings-section", {
      has: window.locator(".settings-section__title", { hasText: "Custom endpoints" }),
    });
    await customEndpoints.getByRole("button", { name: "Add endpoint", exact: true }).click();

    const dialog = window.getByTestId("custom-endpoint-dialog");
    await expect(dialog).toBeVisible();

    // Collides with the seeded openai provider.
    await dialog.getByLabel("Provider ID").fill("openai");
    await expect(dialog).toContainText("already in use");
    const saveButton = dialog.getByRole("button", { name: "Add endpoint", exact: true });
    await expect(saveButton).toBeDisabled();

    // Switch to a unique ID so ID validation no longer blocks save.
    await dialog.getByLabel("Provider ID").fill("my-endpoint");
    await dialog.getByLabel("Base URL").fill("ftp://not-allowed");
    await dialog.getByLabel("Add model ID manually").fill("test-model");
    await dialog.getByRole("button", { name: "Add", exact: true }).click();

    await saveButton.click();
    await expect(dialog).toContainText("Base URL must start with http:// or https://");
    await expect(dialog).toBeVisible();

    // ESC closes the dialog without saving.
    await dialog.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(customEndpoints).toContainText("No custom endpoints yet.");
  } finally {
    await harness.close();
  }
});
