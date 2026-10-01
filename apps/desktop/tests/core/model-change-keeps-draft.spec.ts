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

// Issue #228: picking a model or thinking level from the composer footer must keep the prompt
// and its attachments.
test("changing model or thinking from the composer footer keeps the typed prompt and attachments", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("model-change-draft");
  await seedAgentDir(agentDir);
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Keep my prompt");
    const composer = window.getByTestId("composer");
    const footer = window.locator(".composer__bar");
    const prompt = "Refactor the parser\nand keep the tests green";
    await pasteTinyPng(window);
    const attachment = window.locator(".composer-attachment--image");
    await expect(attachment).toHaveCount(1);
    await composer.fill(prompt);
    // Wait until the draft is saved, so the picker's state update is not masked by a pending edit.
    await expect.poll(async () => (await getDesktopState(window)).composerDraft).toBe(prompt);

    await footer.getByRole("button", { name: "openai:gpt-5" }).click();
    await footer.getByRole("button", { name: "GPT-4o" }).click();
    await expect(footer.getByRole("button", { name: "openai:gpt-4o" })).toBeVisible();
    await expect(window.getByTestId("transcript")).toContainText("Model set to openai:gpt-4o");
    await expect(composer).toHaveValue(prompt);
    await expect(attachment).toHaveCount(1);

    const thinkingBadge = footer.locator(".model-selector__badge").nth(1);
    const initialThinking = (await thinkingBadge.textContent())?.trim();
    const nextThinking = initialThinking === "high" ? "Low" : "High";
    await thinkingBadge.click();
    await footer.getByRole("button", { name: new RegExp(`^${nextThinking}`) }).click();
    await expect(thinkingBadge).toHaveText(nextThinking.toLowerCase());
    await expect(composer).toHaveValue(prompt);
    await expect(attachment).toHaveCount(1);
    await expect.poll(async () => (await getDesktopState(window)).composerDraft).toBe(prompt);

    // Picking from the /model menu consumes the command text, and the saved "/model" must not return.
    await composer.fill("/model");
    await expect.poll(async () => (await getDesktopState(window)).composerDraft).toBe("/model");
    const optionsMenu = window.getByTestId("slash-options-menu");
    await optionsMenu.getByRole("button", { name: /GPT-5/ }).first().click();
    await expect(window.getByTestId("transcript")).toContainText("Model set to openai:gpt-5");
    await expect(footer.getByRole("button", { name: "openai:gpt-5" })).toBeVisible();
    await expect(composer).toHaveValue("");
    await expect.poll(async () => (await getDesktopState(window)).composerDraft).toBe("");
    await expect(composer).toHaveValue("");
  } finally {
    await harness.close();
  }
});
