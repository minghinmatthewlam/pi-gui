import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  commitAllInGitRepo,
  initGitRepo,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  selectSidePanel,
  waitForWorkspaceByPath,
  writeProjectExtension,
} from "../helpers/electron-app";

// The provider is local and deterministic; Pi still executes its actual write
// tool, persists native transcript entries, and invokes the awaited capture hooks.
const providerExtension = String.raw`
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

export default function capturedReviewFixture(pi) {
  pi.registerProvider("captured-review-test", {
    baseUrl: "http://127.0.0.1:9/never-contact",
    apiKey: "LOCAL_TEST_CANARY",
    api: "captured-review-test",
    models: [{
      id: "scripted", name: "Scripted captured review", reasoning: false,
      input: ["text"], contextWindow: 128000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
    streamSimple(model, context) {
      const lastUser = context.messages.findLastIndex((message) => message.role === "user");
      const prompt = JSON.stringify(context.messages[lastUser]);
      const second = prompt.includes("capture second");
      const finishedWrite = context.messages.slice(lastUser + 1).some((message) => message.role === "toolResult");
      const text = second ? "Second capture complete" : "First capture complete";
      const message = {
        role: "assistant",
        content: finishedWrite ? [{ type: "text", text }] : [{
          type: "toolCall", id: second ? "capture-write-second" : "capture-write-first",
          name: "write", arguments: {
            path: "result.txt",
            content: second ? "SECOND_TURN_OUTPUT\n" : "FIRST_TURN_OUTPUT\n",
          },
        }],
        api: model.api, provider: model.provider, model: model.id,
        usage: {
          input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: finishedWrite ? "stop" : "toolUse", timestamp: Date.now(),
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: { ...message, content: [] } });
      if (finishedWrite) stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
      stream.push({ type: "done", reason: message.stopReason, message });
      return stream;
    },
  });
}
`;

async function expectCompleted(window: Page, text: string): Promise<void> {
  await expect(
    window.locator(".timeline-item--assistant .message__content").filter({ hasText: text }),
  ).toBeVisible();
  await expect(window.getByTestId("send")).not.toHaveAttribute("aria-label", "Stop run");
  await expect(window.locator(".session-row--active")).toHaveAttribute(
    "data-sidebar-indicator",
    "none",
  );
  await expect(window.getByTestId("composer-error-banner")).toHaveCount(0);
}

async function openCapturedFile(window: Page): Promise<Locator> {
  const panel = window.getByRole("region", { name: "Changes review", exact: true });
  await expect(panel.locator(".diff-panel__file")).toHaveCount(1);
  const row = panel.locator('.diff-panel__file[data-file-path="result.txt"]');
  await expect(row).toBeVisible();
  if (!(await row.getAttribute("class"))?.includes("diff-panel__file--selected")) {
    await row.locator(".diff-panel__file-name").click();
  }
  await expect(panel.getByTestId("review-comparison-identity")).toContainText("Captured");
  await expect(panel.getByRole("button", { name: /^(Stage|Staged|Unstage)$/ })).toHaveCount(0);
  return panel.getByRole("region", { name: "Combined changes", exact: true });
}

test("Last turn captures actual tool edits and a response pins its own saved comparison", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("captured-review");
  await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: "captured-review-test",
      defaultModel: "scripted",
      enabledModels: ["captured-review-test/scripted"],
      packages: [],
      cacheWarming: "off",
      compaction: { enabled: false },
    }),
  );
  await initGitRepo(workspacePath);
  await writeFile(join(workspacePath, "result.txt"), "INITIAL_CONTENT\n");
  await writeFile(join(workspacePath, "manual.txt"), "committed manual file\n");
  await writeProjectExtension(workspacePath, "captured-review.ts", providerExtension);
  await commitAllInGitRepo(workspacePath, "Before captured turns");
  await writeFile(join(workspacePath, "manual.txt"), "pre-existing manual edit\n");
  const options = {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background" as const,
  };
  let harness = await launchDesktop(userDataDir, options);
  try {
    let window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await window
      .locator(".sidebar")
      .getByRole("button", { name: "New thread", exact: true })
      .click();
    await window.getByLabel("New thread prompt", { exact: true }).fill("capture first");
    await window.getByRole("button", { name: "Start thread", exact: true }).click();
    await expectCompleted(window, "First capture complete");
    expect(await readFile(join(workspacePath, "result.txt"), "utf8")).toBe("FIRST_TURN_OUTPUT\n");
    await selectSidePanel(window, "Changes");
    await window.getByLabel("Review scope", { exact: true }).selectOption("turn");
    let patch = await openCapturedFile(window);
    await expect(patch).toContainText("INITIAL_CONTENT");
    await expect(patch).toContainText("FIRST_TURN_OUTPUT");
    await expect(window.locator('.diff-panel__file[data-file-path="manual.txt"]')).toHaveCount(0);

    await window.getByTestId("composer").fill("capture second");
    await window.getByTestId("composer").press("Enter");
    await expectCompleted(window, "Second capture complete");
    expect(await readFile(join(workspacePath, "result.txt"), "utf8")).toBe("SECOND_TURN_OUTPUT\n");
    await window.getByLabel("Review scope", { exact: true }).selectOption("uncommitted");
    await window.getByLabel("Review scope", { exact: true }).selectOption("turn");
    patch = await openCapturedFile(window);
    await expect(patch).toContainText("FIRST_TURN_OUTPUT");
    await expect(patch).toContainText("SECOND_TURN_OUTPUT");
    await expect(patch).not.toContainText("INITIAL_CONTENT");

    // Later editor activity must not rewrite either captured interval.
    await writeFile(join(workspacePath, "result.txt"), "LATER_MANUAL_EDIT\n");
    await window
      .getByRole("region", { name: "Changes review", exact: true })
      .getByRole("button", { name: "Refresh", exact: true })
      .click();
    patch = await openCapturedFile(window);
    await expect(patch).toContainText("SECOND_TURN_OUTPUT");
    await expect(patch).not.toContainText("LATER_MANUAL_EDIT");

    // Each turn's card pins its own saved comparison, not the latest one.
    const cards = window.getByTestId("turn-changes");
    await expect(cards).toHaveCount(2);
    await cards.first().getByRole("button", { name: "Review", exact: true }).click();
    await expect(window.getByLabel("Review scope", { exact: true })).toHaveValue("selected-turn");
    await expect(
      window.locator('.diff-panel__file--selected[data-file-path="result.txt"]'),
    ).toBeVisible();

    // The card's exact checkpoint survives a restart.
    await harness.close();
    harness = await launchDesktop(userDataDir, options);
    window = await harness.firstWindow();
    await expect(window.getByLabel("Review scope", { exact: true })).toHaveValue("selected-turn");
    patch = await openCapturedFile(window);
    await expect(patch).toContainText("INITIAL_CONTENT");
    await expect(patch).toContainText("FIRST_TURN_OUTPUT");
    await expect(patch).not.toContainText("SECOND_TURN_OUTPUT");
    await expect(patch).not.toContainText("LATER_MANUAL_EDIT");
    expect(await readFile(join(workspacePath, "manual.txt"), "utf8")).toBe(
      "pre-existing manual edit\n",
    );
    await window.screenshot({ path: testInfo.outputPath("saved-turn-after-restart.png") });
  } finally {
    await harness.close();
  }
});
