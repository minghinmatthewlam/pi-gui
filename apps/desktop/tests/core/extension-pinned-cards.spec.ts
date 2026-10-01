import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  assertExists,
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  selectSession,
  waitForWorkspaceByPath,
  writeProjectExtension,
} from "../helpers/electron-app";

const PROVIDER_ID = "pinned-cards-test";
const MODEL_ID = "scripted";
const THREAD_TITLE = "Pinned plan";

// A plan extension in the shape of pi's todo example: `/plan N` pins the plan with N steps done
// under one key, `/plan remove` unpins it. `/widget` and `/status` drive the text dock. The
// scripted model answers every turn, including the compaction summary, with "MODEL RAN".
const extensionSource = String.raw`
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const STEPS = ["Read the code", "Write the fix", "Run the tests"];

export default function plan(pi) {
  pi.registerCommand("plan", {
    description: "Pin the plan, mark steps done, or remove it",
    handler: async (args) => {
      if (args.trim() === "remove") {
        pi.appendEntry("pi-gui.pin", { key: "plan", remove: true });
        return;
      }
      const done = Number(args.trim()) || 0;
      pi.appendEntry("pi-gui.pin", {
        key: "plan",
        title: "Plan",
        subtitle: done + " of " + STEPS.length + " done",
        tone: "warning",
        rows: STEPS.map((step, index) => ({ label: index < done ? "Done" : "To do", value: step })),
        actions: [{ type: "command", label: "Mark next step done", command: "/plan " + (done + 1) }],
      });
    },
  });
  pi.registerCommand("widget", {
    description: "Set the progress widget",
    handler: async (args, ctx) => ctx.ui.setWidget("progress", [args.trim()]),
  });
  pi.registerCommand("status", {
    description: "Set a status",
    handler: async (args, ctx) => ctx.ui.setStatus("tick", args.trim()),
  });
  pi.registerProvider("pinned-cards-test", {
    baseUrl: "http://127.0.0.1:9/never-contact",
    apiKey: "LOCAL_TEST_CANARY",
    api: "pinned-cards-test",
    models: [{
      id: "scripted",
      name: "Scripted",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    }],
    streamSimple(model) {
      const done = {
        role: "assistant",
        content: [{ type: "text", text: "MODEL RAN" }],
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
      queueMicrotask(() => {
        stream.push({ type: "start", partial: { ...done, content: [] } });
        stream.push({ type: "text_delta", contentIndex: 0, delta: "MODEL RAN", partial: done });
        stream.push({ type: "done", reason: "stop", message: done });
      });
      return stream;
    },
  });
}
`;

async function send(window: Page, text: string) {
  const composer = window.getByTestId("composer");
  await composer.click();
  await composer.fill(text);
  await composer.press("Enter");
  await expect(composer).toHaveValue("");
}

test("a pinned card stays above the composer through updates, hiding, compaction and restart", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("extension-pinned-cards");
  await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: PROVIDER_ID,
      defaultModel: MODEL_ID,
      enabledModels: [`${PROVIDER_ID}/${MODEL_ID}`],
      packages: [],
      cacheWarming: "off",
      // Manual /compact only, keeping just the latest reply so the pin's entry is summarized away.
      compaction: { enabled: false, keepRecentTokens: 1 },
    }),
  );
  await writeProjectExtension(workspacePath, "plan.ts", extensionSource);
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
    const pinned = window.getByTestId("pinned-cards").getByTestId("extension-card");
    const transcriptCards = window.getByTestId("transcript").getByTestId("extension-card");

    // The pin sits above the composer, inside its surface, and never in the timeline.
    await send(window, "/plan 1");
    await expect(pinned).toHaveCount(1);
    await expect(pinned).toContainText("1 of 3 done");
    await expect(transcriptCards).toHaveCount(0);
    const pinBox = await pinned.boundingBox();
    const composerBox = await window.getByTestId("composer").boundingBox();
    assertExists(pinBox, "Expected pinned card box");
    assertExists(composerBox, "Expected composer box");
    expect(pinBox.y + pinBox.height).toBeLessThanOrEqual(composerBox.y);
    await expect(window.locator(".composer__surface [data-testid='pinned-cards']")).toBeVisible();

    // Its command button runs the extension, whose next write updates the pin in place.
    await pinned.getByRole("button", { name: /Mark next step done/ }).click();
    await expect(pinned).toHaveCount(1);
    await expect(pinned).toContainText("2 of 3 done");
    await expect(transcriptCards).toHaveCount(0);

    // Collapse keeps the header; × hides it until the extension writes it again.
    const rows = pinned.locator(".extension-card__row");
    await expect(rows).toHaveCount(3);
    await pinned.getByTestId("pinned-card-toggle").click();
    await expect(rows).toHaveCount(0);
    await expect(pinned).toContainText("2 of 3 done");
    await pinned.getByTestId("pinned-card-toggle").click();
    await expect(rows).toHaveCount(3);
    await pinned.getByTestId("pinned-card-dismiss").click();
    await expect(pinned).toHaveCount(0);
    await send(window, "/plan 2");
    await expect(pinned).toHaveCount(1);
    await expect(pinned).toContainText("2 of 3 done");

    // Two turns, then a compaction that keeps only the latest reply: the pin's entry is
    // summarized away, but the pin reads the whole branch and stays.
    const replies = window.locator(".timeline-item--assistant");
    await send(window, "First question");
    await expect(replies).toHaveCount(1);
    await send(window, "Second question");
    await expect(replies).toHaveCount(2);
    await expect(window.getByTestId("transcript")).toContainText("First question");
    await send(window, "/compact keep the plan");
    await expect(window.getByTestId("transcript")).not.toContainText("First question");
    await expect(pinned).toHaveCount(1);
    await expect(pinned).toContainText("2 of 3 done");
  } finally {
    await firstRun.close();
  }

  const secondRun = await launch();
  try {
    const window = await secondRun.firstWindow();
    await selectSession(window, THREAD_TITLE);
    const pinned = window.getByTestId("pinned-cards").getByTestId("extension-card");
    await expect(pinned).toHaveCount(1);
    await expect(pinned).toContainText("2 of 3 done");
    await expect(window.getByTestId("transcript").getByTestId("extension-card")).toHaveCount(0);

    await send(window, "/plan remove");
    await expect(window.getByTestId("pinned-cards")).toHaveCount(0);

    // The text dock's × hides it until its widget text changes; a status tick does not count.
    const dock = window.getByTestId("extension-dock");
    await send(window, "/widget Building");
    await expect(window.getByTestId("extension-dock-summary")).toHaveText("Building");
    await window.getByTestId("extension-dock-dismiss").click();
    await expect(dock).toHaveCount(0);
    await send(window, "/status Tick 2");
    await send(window, "/widget Building");
    await expect
      .poll(async () => {
        const state = await getDesktopState(window);
        const ui =
          state.sessionExtensionUiBySession[
            `${state.selectedWorkspaceId}:${state.selectedSessionId}`
          ];
        return ui?.statuses.map((status) => status.text);
      })
      .toEqual(["Tick 2"]);
    await expect(dock).toHaveCount(0);
    await send(window, "/widget Testing");
    await expect(dock).toBeVisible();
    await expect(window.getByTestId("extension-dock-summary")).toHaveText("Tick 2");
  } finally {
    await secondRun.close();
  }
});
