import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  stubNextOpenDialog,
  writeTinyPng,
} from "../helpers/electron-app";
import { startScriptedOpenAiServer } from "../helpers/scripted-openai-server";

// Synthetic folder on a network share. macOS SMB volumes report Hangul names
// decomposed (NFD), so the percent-encoded session key for this workspace is
// longer than the 255-byte file name limit. Composer attachments are persisted
// under that key when they are added and again on every send.
const LONG_WORKSPACE_NAME = "공유 자료/디자인팀/작업 폴더".normalize("NFD");
const REPLY = "Reply from the long workspace path.";

test("attaches and sends in a workspace whose path encodes past the file name limit", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace(LONG_WORKSPACE_NAME);
  expect(encodeURIComponent(workspacePath).length).toBeGreaterThan(255);

  const server = await startScriptedOpenAiServer((request) =>
    request.toolNames.length === 0 ? { text: "Thread title" } : { text: REPLY },
  );
  await seedAgentDir(agentDir, {
    withOpenAiAuth: false,
    withDefaultModel: false,
    enabledModels: ["scripted-test/scripted"],
  });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: "scripted-test",
      defaultModel: "scripted",
      enabledModels: ["scripted-test/scripted"],
    }),
  );
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "scripted-test": {
          baseUrl: server.baseUrl,
          api: "openai-completions",
          apiKey: "unused",
          models: [{ id: "scripted", input: ["text", "image"] }],
        },
      },
    }),
  );
  const imageDir = await mkdtemp(join(tmpdir(), "pi-gui-long-path-image-"));
  const imagePath = join(imageDir, "screenshot.png");
  await writeTinyPng(imagePath);

  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Long path thread");

    await stubNextOpenDialog(harness, [imagePath]);
    await window.getByRole("button", { name: "Attach files" }).click();
    await expect(window.getByRole("button", { name: "View screenshot.png" })).toBeVisible();

    const composer = window.getByTestId("composer");
    await composer.fill("Describe the attachment.");
    await composer.press("Enter");

    await expect(window.getByTestId("transcript")).toContainText(REPLY);
    await expect(window.locator(".composer-attachment")).toHaveCount(0);
  } finally {
    await harness.close();
    await server.close();
  }
});
