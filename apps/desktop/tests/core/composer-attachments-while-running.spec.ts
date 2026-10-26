import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  pasteTinyPng,
  seedAgentDir,
} from "../helpers/electron-app";
import { startHangingOpenAiServer } from "../helpers/hanging-openai-server";

// The submit IPC resolves only when the agent turn ends. The composer used to hide every
// attachment until then, so an image pasted during a run was stored and sent but never shown.
test("shows an image pasted while the thread is running", async () => {
  test.setTimeout(60_000);
  const server = await startHangingOpenAiServer();
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("composer-attachments-while-running");
  await seedAgentDir(agentDir, {
    withOpenAiAuth: false,
    withDefaultModel: false,
    enabledModels: ["slow-test/slow"],
  });
  await writeFile(
    join(agentDir, "settings.json"),
    `${JSON.stringify(
      { defaultProvider: "slow-test", defaultModel: "slow", enabledModels: ["slow-test/slow"] },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(agentDir, "models.json"),
    `${JSON.stringify(
      {
        providers: {
          "slow-test": {
            baseUrl: server.baseUrl,
            api: "openai-completions",
            apiKey: "unused",
            models: [{ id: "slow", input: ["text", "image"] }],
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Paste while running");
    const composer = window.getByTestId("composer");
    const attachments = window.locator(".composer-attachment--image");

    await pasteTinyPng(window, "sent-with-first-prompt.png");
    await expect(attachments).toHaveCount(1);
    await composer.fill("Look at this screenshot");
    await composer.press("Enter");

    // The sent image leaves the composer at once, while the turn is still in flight.
    await expect(attachments).toHaveCount(0);
    await expect.poll(() => server.pendingRequestCount()).toBeGreaterThan(0);
    await expect
      .poll(async () => {
        const state = await getDesktopState(window);
        const workspace = state.workspaces.find((entry) => entry.id === state.selectedWorkspaceId);
        return workspace?.sessions.find((entry) => entry.id === state.selectedSessionId)?.status;
      })
      .toBe("running");

    await pasteTinyPng(window, "pasted-during-run.png");
    await expect
      .poll(async () => (await getDesktopState(window)).composerAttachments.map((a) => a.name))
      .toEqual(["pasted-during-run.png"]);
    await expect(attachments).toHaveCount(1);
    await expect(
      attachments.getByRole("button", { name: "Remove pasted-during-run.png" }),
    ).toBeVisible();

    // The next message, queued behind the running turn, takes the image with it.
    await composer.fill("And this one");
    await composer.press("Enter");
    await expect
      .poll(async () =>
        (await getDesktopState(window)).queuedComposerMessages.map((message) => ({
          text: message.text,
          attachments: message.attachments.map((attachment) => attachment.name),
        })),
      )
      .toEqual([{ text: "And this one", attachments: ["pasted-during-run.png"] }]);
    await expect(attachments).toHaveCount(0);
    expect((await getDesktopState(window)).composerAttachments).toEqual([]);
  } finally {
    await harness.close();
    await server.close();
  }
});
