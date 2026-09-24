import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  getSelectedTranscript,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  waitForWorkspaceByPath,
  writeProjectExtension,
} from "../helpers/electron-app";

const PROVIDER_ID = "continuation-test";
const MODEL_ID = "scripted";

// Exercise the real Pi loop and extension lifecycle. Only model streaming is
// scripted; the confirmation gives the test an observable, user-driven pause.
const extensionSource = String.raw`
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

export default function continuationExtension(pi) {
  pi.registerProvider("continuation-test", {
    baseUrl: "http://127.0.0.1:9/never-contact",
    apiKey: "LOCAL_TEST_CANARY",
    api: "continuation-test",
    models: [{
      id: "scripted",
      name: "Scripted continuation",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    }],
    streamSimple(model, context) {
      const continued = JSON.stringify(context.messages).includes("Continue without tools.");
      const text = continued ? "Continued response" : "First response";
      const message = {
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
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
      stream.push({ type: "done", reason: "stop", message });
      return stream;
    },
  });

  let continued = false;
  pi.on("agent_before_settle", async (_event, ctx) => {
    if (continued) {
      await ctx.ui.confirm("Finish the run?", "Both responses are ready to settle.");
      return;
    }
    continued = true;
    const confirmed = await ctx.ui.confirm(
      "Continue the response?",
      "The first response finished, but the same run has not settled."
    );
    if (!confirmed) return;
    return {
      entries: [{
        type: "custom_message",
        customType: "continuation-test",
        content: "Continue without tools.",
        display: false,
      }],
      continue: true,
    };
  });
}
`;

test("keeps no-tool continuation replies separate and completes only after settlement", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("extension-continuation");
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
  await writeProjectExtension(workspacePath, "continuation.ts", extensionSource);
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
      .getByRole("complementary")
      .getByRole("button", { name: "New thread", exact: true })
      .click();
    await window.getByLabel("New thread prompt", { exact: true }).fill("Exercise a continuation.");
    await window.getByRole("button", { name: "Start thread", exact: true }).click();

    const confirmation = window.getByRole("dialog", { name: "Continue the response?" });
    await expect(confirmation).toBeVisible();
    const assistantRows = window.locator(".timeline-item--assistant .message__content");
    await expect(assistantRows).toHaveText(["First response"]);
    await expect(window.locator(".session-row--active")).toHaveAttribute(
      "data-sidebar-indicator",
      "running",
    );
    await expect(window.getByTestId("send")).toHaveAttribute("aria-label", "Stop run");
    expect(
      (await getSelectedTranscript(window))?.transcript.filter((item) => item.kind === "summary"),
    ).toHaveLength(0);

    await confirmation.getByTestId("extension-dialog-confirm").click();
    await expect(confirmation).toHaveCount(0);
    const settlement = window.getByRole("dialog", { name: "Finish the run?" });
    await expect(settlement).toBeVisible();
    await expect(assistantRows).toHaveText(["First response", "Continued response"]);
    await expect(window.getByTestId("send")).toHaveAttribute("aria-label", "Stop run");
    expect(
      (await getSelectedTranscript(window))?.transcript.filter((item) => item.kind === "summary"),
    ).toHaveLength(0);

    await settlement.getByTestId("extension-dialog-confirm").click();
    await expect(settlement).toHaveCount(0);
    await expect(assistantRows).toHaveText(["First response", "Continued response"]);
    await expect(window.locator(".session-row--active")).toHaveAttribute(
      "data-sidebar-indicator",
      "none",
    );
    await expect(window.getByTestId("send")).not.toHaveAttribute("aria-label", "Stop run");
    await expect(window.getByTestId("composer-error-banner")).toHaveCount(0);
    // A no-tool run that completes cleanly adds no summary row: no failure or
    // "Completed" divider, and "Worked for" is derived by the renderer.
    expect(
      (await getSelectedTranscript(window))?.transcript.filter((item) => item.kind === "summary"),
    ).toHaveLength(0);
  } finally {
    await harness.close();
  }
});
