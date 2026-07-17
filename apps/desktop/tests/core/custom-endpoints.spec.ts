import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  desktopShortcut,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  type PiAppWindow,
  seedAgentDir,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

async function readModelsJson(agentDir: string): Promise<Record<string, unknown>> {
  const raw = await readFile(join(agentDir, "models.json"), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

async function startModelListServer(modelCount: number): Promise<{
  readonly baseUrl: string;
  readonly authorization: () => string | undefined;
  readonly close: () => Promise<void>;
}> {
  let authorization: string | undefined;
  const server = createServer((request, response) => {
    authorization = request.headers.authorization;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      data: Array.from({ length: modelCount }, (_, index) => ({ id: `detected-model-${index + 1}` })),
    }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    authorization: () => authorization,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
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
  const otherWorkspacePath = await makeWorkspace("custom-endpoints-other-workspace");
  await seedAgentDir(agentDir, { enabledModels: [] });

  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath, otherWorkspacePath],
    scrubProviderEnv: true,
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    const otherWorkspace = await waitForWorkspaceByPath(window, otherWorkspacePath);
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
      piGuiCustomEndpoint: true,
      models: [{ id: "llama3.1" }],
    });
    await expect.poll(async () => {
      const state = await getDesktopState(window);
      return (
        state.runtimeByWorkspace[otherWorkspace.id]?.providers.some((provider) => provider.id === "ollama-local")
        ?? false
      );
    }).toBe(true);

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
    await expect.poll(async () => {
      const state = await getDesktopState(window);
      return (
        state.runtimeByWorkspace[otherWorkspace.id]?.providers.some((provider) => provider.id === "ollama-local")
        ?? false
      );
    }).toBe(false);
  } finally {
    await harness.close();
  }
});

test("custom endpoints keep legacy managed entries separate from built-in overrides", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("custom-endpoints-ownership-workspace");
  await seedAgentDir(agentDir, { enabledModels: [] });
  await writeFile(
    join(agentDir, "models.json"),
    `${JSON.stringify(
      {
        providers: {
          openai: {
            baseUrl: "https://proxy.example.test/v1",
            api: "openai-completions",
            apiKey: "test-openai-key",
            models: [{ id: "proxy-model" }],
          },
          deepseek: {
            baseUrl: "https://deepseek-proxy.example.test/v1",
            api: "openai-completions",
            apiKey: "test-deepseek-key",
            models: [{ id: "deepseek-chat" }],
          },
          "legacy-local": {
            baseUrl: "http://localhost:11434/v1",
            api: "openai-completions",
            apiKey: "unused",
            models: [{ id: "llama3.1" }],
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    const workspace = await waitForWorkspaceByPath(window, workspacePath);
    await openProvidersSettings(window);

    const customEndpoints = window.locator(".settings-section", {
      has: window.locator(".settings-section__title", { hasText: "Custom endpoints" }),
    });
    await expect(customEndpoints).toContainText("legacy-local");
    await expect(
      customEndpoints.locator(".settings-row", {
        has: window.locator(".settings-row__title", { hasText: /^openai$/ }),
      }),
    ).toHaveCount(0);
    await expect(
      customEndpoints.locator(".settings-row", {
        has: window.locator(".settings-row__title", { hasText: /^deepseek$/ }),
      }),
    ).toHaveCount(0);

    const blockedState = await window.evaluate(async ({ workspaceId }) => {
      const app = (window as PiAppWindow).piApp;
      if (!app) {
        throw new Error("piApp IPC bridge is unavailable");
      }
      return app.setCustomProvider(workspaceId, {
        providerId: "openai",
        baseUrl: "http://localhost:11434/v1",
        models: [{ id: "should-not-save" }],
      });
    }, { workspaceId: workspace.id });
    expect(blockedState.lastError).toContain("conflicts with a built-in provider");

    await window.evaluate(async ({ workspaceId }) => {
      const app = (window as PiAppWindow).piApp;
      if (!app) {
        throw new Error("piApp IPC bridge is unavailable");
      }
      await app.deleteCustomProvider(workspaceId, "openai");
    }, { workspaceId: workspace.id });
    const afterBlockedDelete = await readModelsJson(agentDir);
    expect((afterBlockedDelete.providers as Record<string, unknown>).openai).toBeDefined();
    expect((afterBlockedDelete.providers as Record<string, unknown>).deepseek).toBeDefined();

    const legacyRow = customEndpoints.locator(".settings-row", {
      has: window.locator(".settings-row__title", { hasText: /^legacy-local$/ }),
    });
    await legacyRow.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(customEndpoints).toContainText("No custom endpoints yet.");

    const afterLegacyDelete = await readModelsJson(agentDir);
    const providers = afterLegacyDelete.providers as Record<string, unknown>;
    expect(providers.openai).toBeDefined();
    expect(providers["legacy-local"]).toBeUndefined();
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

test("custom endpoint dialog keeps long detected model lists and actions reachable", async () => {
  test.setTimeout(60_000);
  const modelServer = await startModelListServer(50);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("custom-endpoints-long-model-list-workspace");
  await seedAgentDir(agentDir, { enabledModels: [] });

  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await harness.electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(900, 600);
    });
    await expect.poll(() => window.evaluate(() => window.innerHeight)).toBe(600);
    await openProvidersSettings(window);

    const customEndpoints = window.locator(".settings-section", {
      has: window.locator(".settings-section__title", { hasText: "Custom endpoints" }),
    });
    await customEndpoints.getByRole("button", { name: "Add endpoint", exact: true }).click();

    const dialog = window.getByTestId("custom-endpoint-dialog");
    await dialog.getByLabel("Provider ID").fill("many-models");
    await dialog.getByLabel("Base URL").fill(modelServer.baseUrl);
    await dialog.getByLabel("API key").fill("test-api-key");
    await dialog.getByRole("button", { name: "Detect models", exact: true }).click();

    const modelList = dialog.locator(".custom-endpoint-model-list");
    await expect(modelList.locator("li")).toHaveCount(50);
    expect(modelServer.authorization()).toBe("Bearer test-api-key");
    const layout = await dialog.evaluate((element) => {
      const list = element.querySelector<HTMLElement>(".custom-endpoint-model-list");
      const rect = element.getBoundingClientRect();
      return {
        dialogBottom: rect.bottom,
        dialogTop: rect.top,
        listClientHeight: list?.clientHeight ?? 0,
        listScrollHeight: list?.scrollHeight ?? 0,
        viewportHeight: window.innerHeight,
      };
    });
    expect(layout.dialogTop).toBeGreaterThanOrEqual(23);
    expect(layout.dialogBottom).toBeLessThanOrEqual(layout.viewportHeight - 23);
    expect(layout.listScrollHeight).toBeGreaterThan(layout.listClientHeight);

    await modelList.hover();
    await window.mouse.wheel(0, 5_000);
    await window.mouse.wheel(0, 5_000);
    const addEndpoint = dialog.getByRole("button", { name: "Add endpoint", exact: true });
    await expect(addEndpoint).toBeInViewport();
  } finally {
    await harness.close();
    await modelServer.close();
  }
});
