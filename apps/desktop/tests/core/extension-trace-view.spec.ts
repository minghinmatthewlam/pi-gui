import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type FrameLocator, type Page } from "@playwright/test";
import {
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  waitForWorkspaceByPath,
  writeProjectExtension,
} from "../helpers/electron-app";
import { expectExtensionViewReady } from "../helpers/desktop-extension-fixture";
import { desktopExtensionExamplesDirectory as examples } from "../helpers/desktop-extension-examples";

const PROVIDER_ID = "trace-test";
const MODEL_ID = "scripted";

async function openTrace(window: Page): Promise<FrameLocator> {
  const workbench = window.getByTestId("workbench");
  if (!(await workbench.isVisible())) await window.getByTestId("toggle-side-panel").click();
  const chooser = window.getByTestId("workbench-chooser");
  if (!(await chooser.isVisible())) await window.getByTestId("workbench-add-tab").click();
  await chooser.getByRole("button", { name: "Trace", exact: true }).click();
  const frame = window.frameLocator('[data-testid="extension-view-frame"]');
  await expect(frame.getByRole("heading", { name: "Trace", exact: true })).toBeVisible();
  await expectExtensionViewReady(window);
  return frame;
}

// Only model streaming is scripted: pi runs the real loop and the real read tool, and the
// example records pi's own events. The first call asks for read; the second waits for a
// file the test writes, so the test can see the reply while it is still running.
const scriptedProvider = (gate: string) => String.raw`
import { existsSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default function scriptedProvider(pi) {
  pi.registerProvider("${PROVIDER_ID}", {
    baseUrl: "http://127.0.0.1:9/never-contact",
    apiKey: "LOCAL_TEST_CANARY",
    api: "${PROVIDER_ID}",
    models: [{
      id: "${MODEL_ID}",
      name: "Scripted trace",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 4096,
    }],
    streamSimple(model, context) {
      const lastUser = context.messages.findLastIndex((message) => message.role === "user");
      const answered = context.messages.slice(lastUser + 1).some((message) => message.role === "toolResult");
      const content = answered
        ? [{ type: "text", text: "The notes say hello." }]
        : [{ type: "toolCall", id: "read-" + lastUser, name: "read", arguments: { path: "notes.txt" } }];
      const usage = answered
        ? { input: 2000, output: 80, cacheRead: 10000, cacheWrite: 0, totalTokens: 12080 }
        : { input: 10000, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 10050 };
      const message = {
        role: "assistant",
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: { ...usage, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: answered ? "stop" : "toolUse",
        timestamp: Date.now(),
      };
      const stream = createAssistantMessageEventStream();
      void (async () => {
        if (answered) while (!existsSync(${JSON.stringify(gate)})) await wait(50);
        await wait(150);
        stream.push({ type: "start", partial: { ...message, content: [] } });
        if (answered) stream.push({ type: "text_delta", contentIndex: 0, delta: "The notes say hello.", partial: message });
        stream.push({ type: "done", reason: message.stopReason, message });
      })();
      return stream;
    },
  });
}
`;

test("the Trace example shows a live waterfall of the reply's model calls and tools with context", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspace = await makeWorkspace("trace-example");
  const gate = join(userDataDir, "trace-gate");
  await writeFile(join(workspace, "notes.txt"), "hello from the notes file\n");
  await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: PROVIDER_ID,
      defaultModel: MODEL_ID,
      enabledModels: [`${PROVIDER_ID}/${MODEL_ID}`],
      packages: [],
      extensions: [join(examples, "trace", "index.ts")],
      cacheWarming: "off",
      compaction: { enabled: false },
    }),
  );
  await writeProjectExtension(workspace, "scripted-provider.ts", scriptedProvider(gate));
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspace],
    scrubProviderEnv: true,
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspace);
    await window
      .getByRole("complementary")
      .getByRole("button", { name: "New thread", exact: true })
      .click();
    await window.getByLabel("New thread prompt", { exact: true }).fill("What do the notes say?");
    await window.getByRole("button", { name: "Start thread", exact: true }).click();
    await expect(window.locator(".chat-header__title")).toBeVisible();

    const frame = await openTrace(window);
    const rows = frame.getByTestId("trace-row");
    const status = frame.getByTestId("trace-status");

    // While the second model call waits, the reply, Turn 2 and that call are open and growing.
    await expect(status).toContainText("Running");
    await expect(rows).toHaveCount(6);
    const shape = () =>
      rows.evaluateAll((items) =>
        items.map((item) => {
          const row = item as HTMLElement;
          return `${row.dataset.depth}:${row.dataset.title}:${row.dataset.open}`;
        }),
      );
    expect(await shape()).toEqual([
      "0:Reply 1:true",
      "1:Turn 1:false",
      "2:Model call:false",
      "2:read:false",
      "1:Turn 2:true",
      "2:Model call:true",
    ]);
    const liveDuration = rows.nth(5).locator(".dur");
    const before = await liveDuration.textContent();
    await expect(liveDuration).not.toHaveText(before ?? "");
    await expect(frame.getByTestId("trace-run-picker")).toHaveValue(/.+/);
    await expect(frame.locator("option")).toHaveText(["Reply 1 · live"]);

    await writeFile(gate, "go");
    await expect(status).toContainText("Done");
    await expect(window.locator(".timeline-item--assistant .message__content").last()).toHaveText(
      "The notes say hello.",
    );
    expect(await shape()).toEqual([
      "0:Reply 1:false",
      "1:Turn 1:false",
      "2:Model call:false",
      "2:read:false",
      "1:Turn 2:false",
      "2:Model call:false",
    ]);
    for (let index = 0; index < 6; index += 1)
      await expect(rows.nth(index).locator(".dur")).toHaveText(/^\d+(ms|\.\ds)$/);
    await expect(rows.nth(2).locator(".meta")).toHaveText("10k · 5%");
    await expect(rows.nth(3).locator(".meta")).toHaveText("notes.txt");
    await expect(rows.nth(5).locator(".meta")).toHaveText("12k · 6%");
    await expect(frame.getByTestId("trace-model-calls")).toHaveText("2");
    await expect(frame.getByTestId("trace-tool-calls")).toHaveText("1");
    await expect(frame.getByTestId("trace-peak-context")).toHaveText("12k · 6%");

    // The selected span's details: the tool's arguments and result, the call's context.
    const detail = frame.getByTestId("trace-detail");
    await rows.nth(3).click();
    await expect(detail.getByTestId("trace-args")).toContainText('"path": "notes.txt"');
    await expect(detail.getByTestId("trace-result")).toContainText("hello from the notes file");
    await rows.nth(5).click();
    await expect(detail.getByTestId("trace-detail-context")).toHaveText("12k of 200k · 6%");
    await expect(detail.getByTestId("trace-detail-tokens")).toHaveText(
      "2k new · 10k cached · 80 out",
    );
    await expect(detail.getByTestId("trace-first-response")).toContainText("streaming");

    // A new reply gets its own trace, and the view follows it.
    const composer = window.getByTestId("composer");
    await composer.fill("Again.");
    await composer.press("Enter");
    await expect(frame.locator("option")).toHaveText(["Reply 2", "Reply 1"]);
    await expect(rows.first()).toHaveAttribute("data-title", "Reply 2");
    await expect(status).toContainText("Done");

    // An older reply stays readable.
    await frame.getByTestId("trace-run-picker").selectOption({ label: "Reply 1" });
    await expect(rows.first()).toHaveAttribute("data-title", "Reply 1");
  } finally {
    await harness.close();
  }
});
