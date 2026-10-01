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
  waitForWorkspaceByPath,
  writeProjectExtension,
} from "../helpers/electron-app";

const PROVIDER_ID = "tool-labels-test";
const MODEL_ID = "scripted";
const THREAD_TITLE = "Ticket lookup";

// An extension tool whose name looks like a file read ("ticket_read") but whose label says what it
// does. The scripted model calls it once, then answers.
const extensionSource = String.raw`
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

export default function tickets(pi) {
  pi.registerTool({
    name: "ticket_read",
    label: "Look up ticket",
    description: "Look up a support ticket",
    parameters: { type: "object", properties: { ticket: { type: "string" } }, required: ["ticket"] },
    async execute(_id, input) {
      return { content: [{ type: "text", text: "Ticket " + input.ticket + ": printer on fire" }], details: {} };
    },
  });
  pi.registerProvider("tool-labels-test", {
    baseUrl: "http://127.0.0.1:9/never-contact",
    apiKey: "LOCAL_TEST_CANARY",
    api: "tool-labels-test",
    models: [{
      id: "scripted",
      name: "Scripted",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    }],
    streamSimple(model, context) {
      const called = context.messages.some((message) => message.role === "toolResult");
      const content = called
        ? [{ type: "text", text: "The printer is on fire." }]
        : [{ type: "toolCall", id: "lookup-1", name: "ticket_read", arguments: { ticket: "T-42" } }];
      const message = {
        role: "assistant",
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: called ? "stop" : "toolUse",
        timestamp: Date.now(),
      };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "start", partial: { ...message, content: [] } });
        if (called) stream.push({ type: "text_delta", contentIndex: 0, delta: content[0].text, partial: message });
        stream.push({ type: "done", reason: message.stopReason, message });
      });
      return stream;
    },
  });
}
`;

async function expectLabelledRow(window: Page) {
  const row = window.getByTestId("transcript").locator(".timeline-tool");
  await expect(row).toHaveCount(1);
  await expect(row.locator(".timeline-tool__label")).toHaveText("Look up ticket: T-42");
  // The raw tool name stays visible beside the status.
  await expect(row.locator(".timeline-tool__meta-inline")).toContainText("ticket_read");
}

test("an extension tool's row shows the label it registered, live and after restart", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("extension-tool-labels");
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
  await writeProjectExtension(workspacePath, "tickets.ts", extensionSource);
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
    const composer = window.getByTestId("composer");
    await composer.click();
    await composer.fill("What is ticket T-42 about?");
    await composer.press("Enter");
    await expect(window.locator(".timeline-item--assistant")).toContainText(
      "The printer is on fire.",
    );
    await expectLabelledRow(window);
    // The reply summary counts it as a tool, not as an explored file.
    await expect(window.getByTestId("transcript")).toContainText("Used 1 tool");
    await expect(window.getByTestId("transcript")).not.toContainText("Explored");
  } finally {
    await firstRun.close();
  }

  // Reopened from the saved session after a restart, the row keeps its label.
  const secondRun = await launch();
  try {
    const window = await secondRun.firstWindow();
    await selectSession(window, THREAD_TITLE);
    await expect(window.locator(".timeline-item--assistant")).toContainText(
      "The printer is on fire.",
    );
    await expectLabelledRow(window);
  } finally {
    await secondRun.close();
  }
});
