import { basename, join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import {
  createNamedThread,
  desktopShortcut,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  waitForWorkspaceByPath,
  writeProjectExtension,
} from "../helpers/electron-app";

const PROVIDER_ID = "ext-e2e-provider";
const MODEL_ID = "ext-e2e-model";

const EXTENSION_SOURCE = `export default async function testProviderExtension(pi) {
  pi.registerProvider(${JSON.stringify(PROVIDER_ID)}, {
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: "test-extension-key",
    api: "openai-completions",
    models: [
      {
        id: ${JSON.stringify(MODEL_ID)},
        name: "Extension E2E Model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 16384,
      },
    ],
  });
}
`;

const SCOPED_PREFIX = "ext-e2e-scoped";

function projectExtensionSource(providerId: string, modelId: string): string {
  return `export default async function projectProviderExtension(pi) {
  pi.registerProvider(${JSON.stringify(providerId)}, {
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: "test-extension-key",
    api: "openai-completions",
    models: [
      {
        id: ${JSON.stringify(modelId)},
        name: ${JSON.stringify(`Model ${modelId}`)},
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 16384,
      },
    ],
  });
}
`;
}

/** Open Settings → Models and filter the "All models" list, returning the matching rows. */
async function searchAllModels(window: Page, query: string) {
  await window.keyboard.press(desktopShortcut(","));
  await expect(window.getByTestId("settings-surface")).toBeVisible();
  await window.getByRole("button", { name: "Models", exact: true }).click();
  await expect(window.locator(".view-header__title")).toHaveText("Models");

  const allModels = window.locator(".settings-section", {
    has: window.locator(".settings-section__title", { hasText: "All models" }),
  });
  await allModels.locator(".settings-disclosure__summary").click();
  await allModels.getByLabel("Search models").fill(query);
  return allModels.locator(".settings-option");
}

test("models registered by an extension appear in settings", async () => {
  test.setTimeout(90_000);

  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("extension-provider-models-workspace");
  await seedAgentDir(agentDir);
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await writeFile(join(agentDir, "extensions", "test-provider.ts"), EXTENSION_SOURCE, "utf8");

  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await window.keyboard.press(desktopShortcut(","));
    await expect(window.getByTestId("settings-surface")).toBeVisible();
    await window.getByRole("button", { name: "Models", exact: true }).click();
    await expect(window.locator(".view-header__title")).toHaveText("Models");

    const allModels = window.locator(".settings-section", {
      has: window.locator(".settings-section__title", { hasText: "All models" }),
    });
    await allModels.locator(".settings-disclosure__summary").click();
    await allModels.getByLabel("Search models").fill(PROVIDER_ID);

    const modelRow = allModels.locator(".settings-option", {
      has: window.locator(".settings-option__meta", { hasText: `${PROVIDER_ID}:${MODEL_ID}` }),
    });
    await expect(modelRow).toHaveCount(1);
    await expect(modelRow).toContainText("Extension E2E Model");
    await expect(modelRow).not.toContainText("not logged in");
  } finally {
    await harness.close();
  }
});

test("project extension models stay scoped to the workspace that registers them", async () => {
  test.setTimeout(120_000);

  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  await seedAgentDir(agentDir);

  const alphaPath = await makeWorkspace("extension-provider-alpha");
  const betaPath = await makeWorkspace("extension-provider-beta");
  await writeProjectExtension(alphaPath, "provider.ts", projectExtensionSource(`${SCOPED_PREFIX}-alpha`, "alpha-model"));
  await writeProjectExtension(betaPath, "provider.ts", projectExtensionSource(`${SCOPED_PREFIX}-beta`, "beta-model"));

  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [alphaPath, betaPath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, alphaPath);
    await waitForWorkspaceByPath(window, betaPath);

    await createNamedThread(window, "Alpha thread", { workspaceName: basename(alphaPath) });
    let rows = await searchAllModels(window, SCOPED_PREFIX);
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(`${SCOPED_PREFIX}-alpha:alpha-model`);
    await window.keyboard.press("Escape");

    await createNamedThread(window, "Beta thread", { workspaceName: basename(betaPath) });
    rows = await searchAllModels(window, SCOPED_PREFIX);
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(`${SCOPED_PREFIX}-beta:beta-model`);
    await window.keyboard.press("Escape");

    // Back to alpha: opening beta must not have leaked its provider into alpha.
    await createNamedThread(window, "Alpha thread two", { workspaceName: basename(alphaPath) });
    rows = await searchAllModels(window, SCOPED_PREFIX);
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(`${SCOPED_PREFIX}-alpha:alpha-model`);
  } finally {
    await harness.close();
  }
});
