import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  commitAllInGitRepo,
  initGitRepo,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  waitForWorkspaceByPath,
  writeProjectExtension,
  reviewScopeButton,
} from "../helpers/electron-app";

// A local scripted provider: "edit files" writes seven files through Pi's real write tool in
// one assistant message, and "just talk" answers without touching the checkout.
const providerExtension = String.raw`
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const FILES = ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt", "src/nested/f.txt", "src/nested/g.txt"];

export default function turnChangesFixture(pi) {
  pi.registerProvider("turn-changes-test", {
    baseUrl: "http://127.0.0.1:9/never-contact",
    apiKey: "LOCAL_TEST_CANARY",
    api: "turn-changes-test",
    models: [{
      id: "scripted", name: "Scripted turn changes", reasoning: false,
      input: ["text"], contextWindow: 128000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
    streamSimple(model, context) {
      const lastUser = context.messages.findLastIndex((message) => message.role === "user");
      const prompt = JSON.stringify(context.messages[lastUser]);
      const edits = prompt.includes("edit files");
      const finished = !edits || context.messages.slice(lastUser + 1).some((message) => message.role === "toolResult");
      const text = edits ? "Edited the files" : "Nothing to change";
      const message = {
        role: "assistant",
        content: finished ? [{ type: "text", text }] : FILES.map((path, index) => ({
          type: "toolCall", id: "write-" + index, name: "write",
          arguments: { path, content: "line one\nline two\n" },
        })),
        api: model.api, provider: model.provider, model: model.id,
        usage: {
          input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: finished ? "stop" : "toolUse", timestamp: Date.now(),
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: { ...message, content: [] } });
      if (finished) stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
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
}

test("a turn that edits files gets a changes card whose rows open that file's diff", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("turn-changes-card");
  await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: "turn-changes-test",
      defaultModel: "scripted",
      enabledModels: ["turn-changes-test/scripted"],
      packages: [],
      cacheWarming: "off",
      compaction: { enabled: false },
    }),
  );
  await initGitRepo(workspacePath);
  await writeFile(join(workspacePath, "a.txt"), "line one\nold line\n");
  await mkdir(join(workspacePath, "src", "nested"), { recursive: true });
  await writeProjectExtension(workspacePath, "turn-changes.ts", providerExtension);
  await commitAllInGitRepo(workspacePath, "Before turn changes");
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await window
      .locator(".sidebar")
      .getByRole("button", { name: "New thread", exact: true })
      .click();
    await window.getByLabel("New thread prompt", { exact: true }).fill("edit files");
    await window.getByRole("button", { name: "Start thread", exact: true }).click();
    await expectCompleted(window, "Edited the files");

    const card = window.getByTestId("turn-changes");
    await expect(card).toHaveCount(1);
    await expect(card).toContainText("Edited 7 files");
    // a.txt replaces one line; six new files add two lines each.
    await expect(card.locator(".turn-changes__header .turn-changes__stats")).toHaveText("+13-1");
    const rows = card.locator(".turn-changes__file[data-file-path]");
    await expect(rows).toHaveCount(5);
    await expect(card.locator('[data-file-path="a.txt"] .turn-changes__stats')).toHaveText("+1-1");
    await card.getByRole("button", { name: "Show 2 more", exact: true }).click();
    await expect(rows).toHaveCount(7);
    await expect(card.locator('[data-file-path="src/nested/g.txt"] .turn-changes__dir')).toHaveText(
      "src/nested/",
    );

    // The card follows the turn it belongs to, and the response's Fork action sits in the
    // flow above it instead of overlapping it.
    const response = window
      .locator(".timeline-item--assistant")
      .filter({ hasText: "Edited the files" });
    const forkBox = await response.getByTestId("fork-from-message").boundingBox();
    const cardBox = await card.boundingBox();
    expect(forkBox && cardBox && forkBox.y + forkBox.height <= cardBox.y).toBe(true);
    await expect(
      window.getByRole("button", { name: "Review changes from this response" }),
    ).toHaveCount(0);

    await card.locator('.turn-changes__file[data-file-path="src/nested/f.txt"]').click();
    const panel = window.getByRole("region", { name: "Review", exact: true });
    await expect(reviewScopeButton(window)).toHaveText("Selected Turn");
    await expect(panel.locator(".diff-panel__file")).toHaveCount(7);
    await expect(
      panel.locator('.diff-panel__file--selected[data-file-path="src/nested/f.txt"]'),
    ).toBeVisible();
    await expect(panel.getByRole("region", { name: "Diff", exact: true })).toContainText(
      "line two",
    );

    await card.getByRole("button", { name: "Review", exact: true }).click();
    await expect(
      panel.locator('.diff-panel__file--selected[data-file-path="a.txt"]'),
    ).toBeVisible();
    await expect(panel.getByRole("region", { name: "Diff", exact: true })).toContainText(
      "old line",
    );

    // A turn that changes nothing gets no card and no Review action.
    await window.getByTestId("composer").fill("just talk");
    await window.getByTestId("composer").press("Enter");
    await expectCompleted(window, "Nothing to change");
    await expect(card).toHaveCount(1);
    await expect(
      window.getByTestId("transcript").getByRole("button", { name: "Review", exact: true }),
    ).toHaveCount(1);
  } finally {
    await harness.close();
  }
});
