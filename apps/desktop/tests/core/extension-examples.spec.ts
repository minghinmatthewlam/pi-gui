import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type FrameLocator, type Page } from "@playwright/test";
import {
  createNamedThread,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  selectSession,
  writeProjectExtension,
} from "../helpers/electron-app";

import { expectExtensionViewReady } from "../helpers/desktop-extension-fixture";
import {
  createExamplePrFixture,
  desktopExtensionExamplesDirectory as examples,
} from "../helpers/desktop-extension-examples";

async function openExample(window: Page, title: string): Promise<FrameLocator> {
  const workbench = window.getByTestId("workbench");
  if (!(await workbench.isVisible())) await window.getByTestId("toggle-side-panel").click();
  const tab = workbench.getByRole("tab", { name: title, exact: true });
  if (await tab.count()) await tab.click();
  else {
    const chooser = window.getByTestId("workbench-chooser");
    if (!(await chooser.isVisible())) await window.getByTestId("workbench-add-tab").click();
    await chooser.getByRole("button", { name: title, exact: true }).click();
  }
  const frame = window.frameLocator('[data-testid="extension-view-frame"]');
  await expect(frame.getByRole("heading", { name: title, exact: true })).toBeVisible();
  await expectExtensionViewReady(window);
  return frame;
}

test("the actual Test Runs example streams real processes, retains closed-tab work and isolates tasks", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspace = await makeWorkspace("test-runs-example");
  await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      packages: [],
      extensions: [join(examples, "test-runs", "index.ts")],
      cacheWarming: "off",
    }),
  );
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspace],
    scrubProviderEnv: true,
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Example test history");
    let frame = await openExample(window, "Test Runs");
    await expect(frame.getByRole("heading", { name: "No runs yet", exact: true })).toBeVisible();
    await frame.getByLabel("Test suite", { exact: true }).selectOption("passing");
    await frame.getByRole("button", { name: "Run suite", exact: true }).click();
    await expect(
      frame.getByRole("heading", {
        name: "Passing fixture · Command completed · exit 0",
        exact: true,
      }),
    ).toBeVisible();
    await expect(frame.getByLabel("Test output", { exact: true })).toContainText("# pass 2");
    await frame.getByLabel("Test suite", { exact: true }).selectOption("failing");
    await frame.getByRole("button", { name: "Run suite", exact: true }).click();
    await expect(
      frame.getByRole("heading", {
        name: "Failing fixture · Command failed · exit 1",
        exact: true,
      }),
    ).toBeVisible();
    await expect(frame.getByLabel("Test output", { exact: true })).toContainText(
      "expected to fail",
    );

    await frame.getByLabel("Test suite", { exact: true }).selectOption("slow");
    await frame.getByRole("button", { name: "Run suite", exact: true }).click();
    await expect(frame.getByLabel("Test output", { exact: true })).toContainText(
      "Slow test started",
    );
    await expect(frame.getByRole("button", { name: "Stop run", exact: true })).toBeEnabled();
    await window.getByRole("button", { name: "Close Test Runs tab", exact: true }).click();
    frame = await openExample(window, "Test Runs");
    await expect(
      frame.getByRole("heading", { name: "Slow fixture · try Stop · Running", exact: true }),
    ).toBeVisible();
    await frame.getByRole("button", { name: "Stop run", exact: true }).click();
    await expect(
      frame.getByRole("heading", { name: "Slow fixture · try Stop · Cancelled", exact: true }),
    ).toBeVisible();
    await frame.getByLabel("Test suite", { exact: true }).selectOption("timeout");
    await frame.getByRole("button", { name: "Run suite", exact: true }).click();
    await expect(
      frame.getByRole("heading", { name: "Timeout fixture · Timed out", exact: true }),
    ).toBeVisible();
    const screenshot = test.info().outputPath("test-runs-example.png");
    await window.screenshot({ path: screenshot, fullPage: true });
    await test
      .info()
      .attach("Test Runs actual example", { path: screenshot, contentType: "image/png" });

    await window.getByRole("button", { name: "Reload view", exact: true }).click();
    await expect(
      frame.getByRole("heading", { name: "Timeout fixture · Timed out", exact: true }),
    ).toBeVisible();
    await expect(
      frame.getByRole("navigation", { name: "Recent test runs", exact: true }).getByRole("button"),
    ).toHaveCount(4);
    const oldFrameUrl = await window.getByTestId("extension-view-frame").getAttribute("src");
    // Runtime refresh also works before a model has been configured.
    await window.getByRole("button", { name: "Extensions", exact: true }).click();
    await window.getByRole("button", { name: "Refresh", exact: true }).click();
    await window.getByRole("button", { name: "Back to app", exact: true }).click();
    await expect(window.getByTestId("extension-view-frame")).not.toHaveAttribute(
      "src",
      oldFrameUrl!,
    );
    await expect(
      frame.getByRole("heading", { name: "Timeout fixture · Timed out", exact: true }),
    ).toBeVisible();
    await createNamedThread(window, "Separate example task");
    frame = await openExample(window, "Test Runs");
    await expect(frame.getByRole("heading", { name: "No runs yet", exact: true })).toBeVisible();
    await selectSession(window, "Example test history");
    frame = await openExample(window, "Test Runs");
    await expect(
      frame.getByRole("navigation", { name: "Recent test runs", exact: true }).getByRole("button"),
    ).toHaveCount(4);
  } finally {
    await harness.close();
  }
});

// Local deterministic provider: Pi dispatches the actual example's read and record
// tools. This proves wiring and durable results; it does not test model judgment.
const reviewProvider = String.raw`
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
export default function exampleReviewProvider(pi) {
  pi.registerProvider("example-review-core", {
    baseUrl: "http://127.0.0.1:9/never-contact", apiKey: "LOCAL_TEST_CANARY", api: "example-review-core",
    models: [{ id: "scripted", name: "Scripted example review", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context) {
      const lastUser = context.messages.findLastIndex(message => message.role === "user");
      const prompt = JSON.stringify(context.messages[lastUser]);
      const reviewId = prompt.match(/\[pr-review:([a-zA-Z0-9_-]+)\]/)?.[1];
      const head = prompt.match(/at head ([a-f0-9]{40,64})/)?.[1];
      if (!reviewId || !head) throw new Error("Expected a PR review request");
      const results = context.messages.slice(lastUser + 1).filter(message => message.role === "toolResult");
      const content = results.length === 0 ? [{ type: "toolCall", id: "read-snapshot", name: "pr_review_read", arguments: { kind: "diff", path: "search.ts" } }]
        : results.length === 1 ? [{ type: "toolCall", id: "record-findings", name: "pr_review_record", arguments: { reviewId, head, summary: "One deterministic fixture finding.", findings: [{ priority: "P2", title: "Retain the empty-query guard", body: "The fixture change removes the guard for an empty search query.", path: "search.ts", line: 1 }] } }]
        : [{ type: "text", text: "Fixture review recorded." }];
      const message = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: results.length < 2 ? "toolUse" : "stop", timestamp: Date.now() };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: { ...message, content: [] } });
      if (results.length >= 2) stream.push({ type: "text_delta", contentIndex: 0, delta: "Fixture review recorded.", partial: message });
      stream.push({ type: "done", reason: message.stopReason, message });
      return stream;
    },
  });
}
`;

test("the actual PR Review example records a Pi review, opens files, prepares a draft and rejects stale fixes", async () => {
  test.skip(
    process.platform === "win32",
    "The offline gh fixture uses a POSIX executable; Windows has a separate native verification lane.",
  );
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspace = await makeWorkspace("pr-review-example");
  await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: "example-review-core",
      defaultModel: "scripted",
      enabledModels: ["example-review-core/scripted"],
      extensions: [join(examples, "pr-review", "index.ts")],
      packages: [],
      cacheWarming: "off",
      compaction: { enabled: false },
    }),
  );
  await writeProjectExtension(workspace, "example-review-provider.ts", reviewProvider);
  const fixture = await createExamplePrFixture({
    workspacePath: workspace,
    artifactDir: userDataDir,
  });
  const { head } = fixture;
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspace],
    scrubProviderEnv: true,
    testMode: "background",
    envOverrides: fixture.envOverrides,
  });
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Example PR source task");
    let frame = await openExample(window, "PR Review");
    await frame.getByRole("button", { name: "Refresh PR", exact: true }).click();
    await expect(frame.getByText("#142 · Search fixture", { exact: true })).toBeVisible();
    await expect(
      frame.getByText(`PR head ${head.slice(0, 8)} · committed changes only`, { exact: true }),
    ).toBeVisible();
    await frame.getByRole("button", { name: "Review with Pi", exact: true }).click();
    await expect(
      frame.getByRole("heading", { name: "Review · completed", exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      window
        .locator(".timeline-item--assistant .message__content")
        .filter({ hasText: "Fixture review recorded." }),
    ).toBeVisible();
    await expect(window.getByTestId("send")).not.toHaveAttribute("aria-label", "Stop run");
    // Background windows may keep a completed result unread; both are idle states.
    await expect(window.locator(".session-row--active")).toHaveAttribute(
      "data-sidebar-indicator",
      /^(none|unseen)$/,
    );
    await expect(window.getByTestId("composer-error-banner")).toHaveCount(0);
    await expect(
      frame.getByRole("heading", { name: "[P2] Retain the empty-query guard", exact: true }),
    ).toBeVisible();
    const screenshot = test.info().outputPath("pr-review-example.png");
    await window.screenshot({ path: screenshot, fullPage: true });
    await test
      .info()
      .attach("PR Review actual example", { path: screenshot, contentType: "image/png" });
    await frame.getByRole("button", { name: "search.ts:1", exact: true }).click();
    await expect(window.getByTestId("file-workbench")).toBeVisible();
    await expect(window.locator('[data-testid="file-line-mark"][data-line="1"]')).toContainText(
      "export const search",
    );
    frame = await openExample(window, "PR Review");
    await window.getByTestId("composer").fill("Unsent source task draft");
    await frame.getByRole("button", { name: "Prepare fix task", exact: true }).click();
    await expect(window.locator(".chat-header__title")).toHaveText(
      "PR #142: Retain the empty-query guard",
    );
    await expect(window.getByTestId("composer")).toHaveValue(new RegExp(`Reviewed head: ${head}`));
    await expect(window.getByTestId("composer")).toHaveValue(
      /Recheck the finding against the current checkout/,
    );
    await selectSession(window, "Example PR source task");
    await expect(window.getByTestId("composer")).toHaveValue("Unsent source task draft");
    frame = await openExample(window, "PR Review");
    await window.getByRole("button", { name: "Reload view", exact: true }).click();
    await expect(
      frame.getByRole("heading", { name: "Review · completed", exact: true }),
    ).toBeVisible();
    await expectExtensionViewReady(window);
    await fixture.advanceHead("export const search = (query) => query ? [query] : [];\n");
    await frame.getByRole("button", { name: "Refresh PR", exact: true }).click();
    await expect(
      frame.getByRole("heading", { name: "Previous review · completed", exact: true }),
    ).toBeVisible();
    await expect(
      frame.getByRole("button", { name: "Prepare fix task", exact: true }),
    ).toBeDisabled();
  } finally {
    await harness.close();
  }
});
