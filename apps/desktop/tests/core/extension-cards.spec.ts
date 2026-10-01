import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  createNamedThread,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  selectSession,
  waitForTimelineLayout,
  waitForWorkspaceByPath,
  writeProjectExtension,
} from "../helpers/electron-app";

const PROVIDER_ID = "card-test";
const MODEL_ID = "scripted";
const THREAD_TITLE = "Extension cards";

// The real Pi loop and extension API; only model streaming is scripted. Once pi has streamed the
// first words of the reply the extension appends a card, then holds the run open on a
// confirmation so the test can look at a card that arrived while the reply was still streaming.
const extensionSource = String.raw`
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

export default function ciCards(pi) {
  let ui;
  let startReply;
  let replyStarted;
  pi.on("before_agent_start", (_event, ctx) => {
    ui = ctx.ui;
    replyStarted = new Promise((resolve) => {
      startReply = resolve;
    });
  });
  // Like a real extension, react to the reply pi has already streamed. pi tells extensions
  // first and its own listeners (pi-gui) once they return, so append on the next task.
  pi.on("message_update", (event) => {
    if (event.message.role === "assistant") setTimeout(startReply, 0);
  });
  pi.registerProvider("card-test", {
    baseUrl: "http://127.0.0.1:9/never-contact",
    apiKey: "LOCAL_TEST_CANARY",
    api: "card-test",
    models: [{
      id: "scripted",
      name: "Scripted cards",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    }],
    streamSimple(model) {
      const message = (text) => ({
        role: "assistant",
        content: [{ type: "text", text }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      });
      const stream = createAssistantMessageEventStream();
      void (async () => {
        stream.push({ type: "start", partial: message("") });
        stream.push({ type: "text_delta", contentIndex: 0, delta: "Checking CI.", partial: message("Checking CI.") });
        await replyStarted;
        pi.appendEntry("pi-gui.card", {
          title: "CI failed on main",
          subtitle: "unit-tests · 2 failed, 40 passed",
          tone: "error",
          rows: [
            { label: "Job", value: "unit-tests (ubuntu-latest)" },
            { label: "Failed", value: "search.test.ts › returns [] for a blank query" },
          ],
          actions: [{ type: "openFile", label: "Open failing line", path: "search.ts", line: 3 }],
        });
        await ui.confirm("Finish the reply?", "The card is in; the reply is still streaming.");
        const done = message("Checking CI. The search test fails on a blank query.");
        stream.push({ type: "text_delta", contentIndex: 0, delta: " The search test fails on a blank query.", partial: done });
        stream.push({ type: "done", reason: "stop", message: done });
      })();
      return stream;
    },
  });
  pi.registerCommand("deploy", {
    description: "Show a deploy result as a card",
    handler: async () => {
      pi.appendEntry("pi-gui.card", {
        title: "Deployed to production",
        subtitle: "web · v1.4.2",
        tone: "success",
        rows: [{ label: "URL", value: "https://app.example.com" }],
      });
    },
  });
  pi.registerCommand("broken-card", {
    description: "Append a card with no title",
    handler: async () => {
      pi.appendEntry("pi-gui.card", { subtitle: "no title here" });
    },
  });
}
`;

async function sendComposer(window: Page, text: string): Promise<void> {
  const composer = window.getByTestId("composer");
  await composer.click();
  await composer.fill(text);
  await expect(composer).toHaveValue(text);
  await composer.press("Enter");
  await expect(composer).toHaveValue("");
}

test("extension cards appear live beside a streaming reply, survive relaunch once, and open files", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("extension-cards");
  await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: PROVIDER_ID,
      defaultModel: MODEL_ID,
      enabledModels: [`${PROVIDER_ID}/${MODEL_ID}`],
      packages: [],
      cacheWarming: "off",
      compaction: { enabled: false },
    }),
  );
  await writeFile(
    join(workspacePath, "search.ts"),
    [
      "export function search(items: string[], query: string): string[] {",
      "  const needle = query.trim().toLowerCase();",
      "  return items.filter((item) => item.toLowerCase().includes(needle));",
      "}",
      "",
    ].join("\n"),
  );
  await writeProjectExtension(workspacePath, "ci-cards.ts", extensionSource);
  const launch = () =>
    launchDesktop(userDataDir, {
      agentDir,
      initialWorkspaces: [workspacePath],
      scrubProviderEnv: true,
      testMode: "background",
    });

  const firstRun = await launch();
  try {
    const window = await firstRun.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await createNamedThread(window, THREAD_TITLE);
    await sendComposer(window, "Check CI");

    const confirmation = window.getByRole("dialog", { name: "Finish the reply?" });
    await expect(confirmation).toBeVisible();
    const assistant = window.locator(".timeline-item--assistant .message__content");
    const card = window.getByTestId("extension-card");
    await expect(assistant).toHaveText(["Checking CI."]);
    await expect(card).toHaveCount(1);
    await expect(card).toContainText("CI failed on main");
    await expect(card.locator(".extension-card__tone")).toHaveText("Failed");
    await expect(window.getByTestId("send")).toHaveAttribute("aria-label", "Stop run");
    // Where the session file has it: pi saves the reply after the card, when the reply ends.
    await waitForTimelineLayout(window);
    const replyBox = await window.locator(".timeline-item--assistant").boundingBox();
    const cardBox = await card.boundingBox();
    expect(cardBox!.y + cardBox!.height).toBeLessThanOrEqual(replyBox!.y);

    await confirmation.getByTestId("extension-dialog-confirm").click();
    await expect(assistant).toHaveText(["Checking CI. The search test fails on a blank query."]);
    await expect(window.getByTestId("send")).not.toHaveAttribute("aria-label", "Stop run");
    await expect(card).toHaveCount(1);

    await sendComposer(window, "/deploy ");
    await expect(card).toHaveCount(2);
    await expect(card.nth(1)).toContainText("Deployed to production");
    await expect(card.nth(1).locator(".extension-card__tone")).toHaveText("Passed");

    await sendComposer(window, "/broken-card ");
    const broken = window.getByTestId("timeline-custom-message");
    await expect(broken).toContainText("pi-gui.card");
    await expect(broken).toContainText("This card was not shown");
  } finally {
    await firstRun.close();
  }

  const secondRun = await launch();
  try {
    const window = await secondRun.firstWindow();
    await selectSession(window, THREAD_TITLE);
    const card = window.getByTestId("extension-card");
    await expect(window.locator(".timeline-item--assistant .message__content")).toHaveText([
      "Checking CI. The search test fails on a blank query.",
    ]);
    await expect(card).toHaveCount(2);
    await expect(card.first()).toContainText("CI failed on main");
    await waitForTimelineLayout(window);
    const reopenedReplyBox = await window.locator(".timeline-item--assistant").boundingBox();
    const reopenedCardBox = await card.first().boundingBox();
    expect(reopenedCardBox!.y + reopenedCardBox!.height).toBeLessThanOrEqual(reopenedReplyBox!.y);
    await expect(card.nth(1)).toContainText("Deployed to production");
    await expect(window.getByTestId("timeline-custom-message")).toHaveCount(1);

    await waitForTimelineLayout(window);
    await card
      .first()
      .getByRole("button", { name: /Open failing line/ })
      .click();
    await expect(window.getByTestId("file-workbench")).toBeVisible();
    const lineThree = window.locator('[data-testid="file-line-mark"][data-line="3"]');
    await expect(lineThree).toHaveCount(1);
    await expect(lineThree).toContainText("items.filter");
  } finally {
    await secondRun.close();
  }
});
