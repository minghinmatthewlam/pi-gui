import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { desktopShortcut, launchDesktop, makeUserDataDir, makeWorkspace, seedAgentDir } from "../helpers/electron-app";

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
