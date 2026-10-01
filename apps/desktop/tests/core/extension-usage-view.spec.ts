import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type FrameLocator, type Page } from "@playwright/test";
import {
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  selectSession,
  waitForWorkspaceByPath,
  writeProjectExtension,
} from "../helpers/electron-app";
import { expectExtensionViewReady } from "../helpers/desktop-extension-fixture";
import { desktopExtensionExamplesDirectory as examples } from "../helpers/desktop-extension-examples";
import {
  formatCost,
  formatPercent,
  formatTokens,
  periodStart,
} from "../../../../examples/desktop-extensions/usage/model";
import {
  DEMO_THREADS,
  seedUsageSessions,
  type SeededCounts,
  type SeededUsageThread,
} from "../../../../examples/desktop-extensions/usage/test/seed-sessions";

async function openUsage(window: Page): Promise<FrameLocator> {
  const workbench = window.getByTestId("workbench");
  if (!(await workbench.isVisible())) await window.getByTestId("toggle-side-panel").click();
  const tab = workbench.getByRole("tab", { name: "Usage", exact: true });
  if (await tab.count()) await tab.click();
  else {
    const chooser = window.getByTestId("workbench-chooser");
    if (!(await chooser.isVisible())) await window.getByTestId("workbench-add-tab").click();
    await chooser.getByRole("button", { name: "Usage", exact: true }).click();
  }
  const frame = window.frameLocator('[data-testid="extension-view-frame"]');
  await expect(frame.getByRole("heading", { name: "Usage", exact: true })).toBeVisible();
  await expectExtensionViewReady(window);
  return frame;
}

const tokens = (counts: SeededCounts) =>
  counts.input + counts.output + counts.cacheRead + counts.cacheWrite;

function expectedFor(seeded: readonly SeededUsageThread[], since: number | null) {
  const active = seeded
    .map((thread) => ({ thread, counts: thread.totalsSince(since ?? -Infinity) }))
    .filter(({ counts }) => tokens(counts) > 0);
  const sum = (key: keyof SeededCounts) =>
    active.reduce((total, { counts }) => total + counts[key], 0);
  const prompt = sum("input") + sum("cacheRead") + sum("cacheWrite");
  return {
    threads: active.length,
    tokens: sum("input") + sum("output") + sum("cacheRead") + sum("cacheWrite"),
    cacheHit: sum("cacheRead") / prompt,
    cost: sum("cost"),
    input: sum("input"),
    output: sum("output"),
    cacheRead: sum("cacheRead"),
    cacheWrite: sum("cacheWrite"),
    active,
  };
}

/** Seeds real pi session files for a folder and opens the Usage view on one of them. */
async function launchUsageDemo(options: { folderName?: string } = {}) {
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspace = await makeWorkspace(options.folderName ?? "pi-gui");
  await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      packages: [],
      extensions: [join(examples, "usage", "index.ts")],
      cacheWarming: "off",
      compaction: { enabled: false },
    }),
  );
  const now = Date.now();
  const seeded = await seedUsageSessions({ cwd: workspace, agentDir, now });
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspace],
    scrubProviderEnv: true,
    testMode: "background",
  });
  return { harness, workspace, agentDir, seeded, now };
}

test("the Usage example totals real pi sessions for the folder and explains what fills context", async () => {
  test.setTimeout(120_000);
  const { harness, workspace, agentDir, seeded, now } = await launchUsageDemo();
  const shots = process.env.PI_USAGE_SCREENSHOT_DIR;
  if (shots) await mkdir(shots, { recursive: true });
  const shoot = async (window: Page, name: string) => {
    const path = shots ? join(shots, `${name}.png`) : test.info().outputPath(`${name}.png`);
    await window.screenshot({ path });
    await test.info().attach(name, { path, contentType: "image/png" });
  };
  try {
    const window = await harness.firstWindow();
    await selectSession(window, "Review the redesign PR");
    const frame = await openUsage(window);

    const all = expectedFor(seeded, null);
    await expect(frame.getByTestId("usage-threads")).toHaveText(String(DEMO_THREADS.length));
    await expect(frame.getByTestId("usage-tokens")).toHaveText(formatTokens(all.tokens));
    await expect(frame.getByTestId("usage-cache-hit")).toHaveText(formatPercent(all.cacheHit));
    await expect(frame.getByTestId("usage-cost")).toHaveText(formatCost(all.cost));
    for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
      await expect(frame.getByTestId(`usage-${key}`)).toContainText(formatTokens(all[key]));
    }
    // Tool output dominates the seeded threads' context; images and a compaction summary appear.
    const kinds = frame.getByTestId("usage-context-kinds").getByRole("listitem");
    await expect(kinds.first()).toContainText("Tool results");
    await expect(frame.getByTestId("usage-context-images")).toBeVisible();
    await expect(frame.getByTestId("usage-context-summaries")).toBeVisible();

    // Share order; eight rows until "Show more"; the hosting thread is marked.
    const rows = frame.getByTestId("usage-thread-row");
    await expect(rows).toHaveCount(8);
    const byShare = [...all.active].sort((a, b) => tokens(b.counts) - tokens(a.counts));
    await expect(rows.first()).toHaveAttribute("data-thread-title", byShare[0]!.thread.title);
    const review = frame.locator('[data-thread-title="Review the redesign PR"]');
    await expect(review).toContainText("This thread");
    const flaky = frame.locator('[data-thread-title="Root-cause the flaky tests"]');
    const flakyTotals = seeded.find(
      (thread) => thread.title === "Root-cause the flaky tests",
    )!.totals;
    await expect(flaky).toContainText(
      formatPercent(
        flakyTotals.cacheRead /
          (flakyTotals.input + flakyTotals.cacheRead + flakyTotals.cacheWrite),
      ),
    );
    await expect(flaky.locator(".warn, .low").first()).toBeAttached();
    await expect(frame.locator('[data-thread-title="Ctrl-Tab thread switcher"]')).toContainText(
      "Subscription",
    );
    await shoot(window, "usage-overview");

    await frame.getByRole("button", { name: "Show 2 more", exact: true }).click();
    await expect(rows).toHaveCount(10);
    await frame.getByRole("button", { name: "Show fewer", exact: true }).click();

    // Expand the hosting thread: its own split and the largest things in its context.
    await review.click();
    const detail = frame.getByTestId("usage-thread-detail");
    const reviewTotals = seeded.find((thread) => thread.title === "Review the redesign PR")!.totals;
    await expect(detail.locator('[data-cell="cacheRead"]')).toHaveText(
      formatTokens(reviewTotals.cacheRead),
    );
    const largest = detail.getByTestId("usage-largest");
    await expect(largest.first()).toContainText("Tool results · read");
    await expect(largest.first()).toContainText("×2");
    await expect(largest.first()).toContainText("76k");
    await review.scrollIntoViewIfNeeded();
    await shoot(window, "usage-thread-detail");

    // Period filter uses each reply's own timestamp.
    await frame.getByLabel("Period", { exact: true }).selectOption("today");
    const today = expectedFor(seeded, periodStart("today", now));
    await expect(frame.getByTestId("usage-threads")).toHaveText(String(today.threads));
    await expect(frame.getByTestId("usage-tokens")).toHaveText(formatTokens(today.tokens));

    // Sort by cache hit puts the thread that needs attention first.
    await frame.getByLabel("Period", { exact: true }).selectOption("all");
    await frame.getByLabel("Sort threads", { exact: true }).selectOption("cacheHit");
    await expect(rows.first()).toHaveAttribute("data-thread-title", "Root-cause the flaky tests");
    await shoot(window, "usage-sorted-by-cache-hit");

    // A wider panel shows every column, like the reference table.
    await frame.getByLabel("Sort threads", { exact: true }).selectOption("share");
    const handle = window.getByRole("separator", { name: "Side panel width", exact: true });
    const box = (await handle.boundingBox())!;
    await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await window.mouse.down();
    await window.mouse.move(box.x - 260, box.y + box.height / 2, { steps: 8 });
    await window.mouse.up();
    await expect(rows.first().locator('[data-cell="cache-hit"]')).toBeVisible();
    await expect(flaky.locator('[data-cell="cache-hit"]')).toHaveClass(/low/);
    await frame.getByRole("heading", { name: "Threads", exact: true }).scrollIntoViewIfNeeded();
    await shoot(window, "usage-wide");

    // A thread saved after the view opened appears on Refresh.
    const [late] = await seedUsageSessions({
      cwd: workspace,
      agentDir,
      now: Date.now(),
      threads: [
        { ...DEMO_THREADS[DEMO_THREADS.length - 1]!, title: "Late arrival", minutesAgo: 1 },
      ],
    });
    await frame.getByRole("button", { name: "Refresh usage", exact: true }).click();
    await expect(frame.getByTestId("usage-threads")).toHaveText(String(DEMO_THREADS.length + 1));
    await expect(frame.getByTestId("usage-tokens")).toHaveText(
      formatTokens(all.tokens + tokens(late!.totals)),
    );

    await window.evaluate(() => globalThis.window.piApp?.setThemeMode("dark"));
    await frame.getByRole("heading", { name: "Usage", exact: true }).scrollIntoViewIfNeeded();
    await shoot(window, "usage-dark");
    await window.evaluate(() => globalThis.window.piApp?.setThemeMode("light"));

    // Open thread switches the app to that thread, which closes this view.
    await expect(
      review.locator("xpath=..").getByRole("button", { name: "Open thread" }),
    ).toHaveCount(0);
    await flaky.click();
    await frame.getByRole("button", { name: "Open thread", exact: true }).click();
    await expect(window.locator(".chat-header__title")).toHaveText("Root-cause the flaky tests");
  } finally {
    await harness.close();
  }
});

const PROVIDER_ID = "usage-card-test";
const MODEL_ID = "scripted";

// Only model streaming is scripted: pi runs the real loop, and the example's agent_end
// handler writes the card from the run's messages.
// failFirst: the first call fails with a retryable error, so pi retries the reply in a new pass.
const scriptedProvider = (failFirst = false) => String.raw`
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

let calls = 0;

export default function scriptedProvider(pi) {
  pi.registerProvider("${PROVIDER_ID}", {
    baseUrl: "http://127.0.0.1:9/never-contact",
    apiKey: "LOCAL_TEST_CANARY",
    api: "${PROVIDER_ID}",
    models: [{
      id: "${MODEL_ID}",
      name: "Scripted reply",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 4096,
    }],
    streamSimple(model) {
      const message = {
        role: "assistant",
        content: [{ type: "text", text: "Scripted answer" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 2000, output: 400, cacheRead: 18000, cacheWrite: 0, totalTokens: 20400,
          cost: { input: 0.004, output: 0.006, cacheRead: 0.0023, cacheWrite: 0, total: 0.0123 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      };
      const stream = createAssistantMessageEventStream();
      if (${String(failFirst)} && calls++ === 0) {
        const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
        const failed = { ...message, content: [], usage, stopReason: "error", errorMessage: "Overloaded" };
        stream.push({ type: "error", reason: "error", error: failed });
        return stream;
      }
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({ type: "text_delta", contentIndex: 0, delta: "Scripted answer", partial: message });
      stream.push({ type: "done", reason: "stop", message });
      return stream;
    },
  });
}
`;

test("the Usage example adds a card after each reply with its time, cost and context", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspace = await makeWorkspace("usage-reply-card");
  await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: PROVIDER_ID,
      defaultModel: MODEL_ID,
      enabledModels: [`${PROVIDER_ID}/${MODEL_ID}`],
      packages: [],
      extensions: [join(examples, "usage", "index.ts")],
      cacheWarming: "off",
      compaction: { enabled: false },
    }),
  );
  await writeProjectExtension(workspace, "scripted-provider.ts", scriptedProvider());
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
    await window.getByLabel("New thread prompt", { exact: true }).fill("Answer briefly.");
    await window.getByRole("button", { name: "Start thread", exact: true }).click();

    await expect(window.locator(".timeline-item--assistant .message__content")).toHaveText([
      "Scripted answer",
    ]);
    const card = window.getByTestId("extension-card");
    await expect(card).toHaveCount(1);
    await expect(card).toContainText("This reply");
    await expect(card).toContainText("Scripted reply");
    await expect(card.locator(".extension-card__label")).toHaveText([
      "Time",
      "Model calls",
      "Tool calls",
      "Tokens",
      "Cost",
      "Context",
    ]);
    const values = card.locator(".extension-card__value");
    await expect(values.nth(0)).toHaveText(/^\d+\.\ds$/);
    await expect(values.nth(1)).toHaveText("1");
    await expect(values.nth(2)).toHaveText("0");
    await expect(values.nth(3)).toHaveText("20k in · 400 out · 90% cached");
    await expect(values.nth(4)).toHaveText("$0.012");
    await expect(values.nth(5)).toHaveText("10% · 20.4k of 200k");

    // The card comes after the reply it describes.
    const order = await window
      .locator(".timeline-item--assistant, [data-testid='extension-card']")
      .evaluateAll((items) =>
        items.map((item) => (item.matches("[data-testid='extension-card']") ? "card" : "reply")),
      );
    expect(order).toEqual(["reply", "card"]);

    // A second reply gets its own card.
    const composer = window.getByTestId("composer");
    await composer.fill("Again.");
    await composer.press("Enter");
    await expect(card).toHaveCount(2);
    await expect(window.locator(".timeline-item--assistant .message__content")).toHaveText([
      "Scripted answer",
      "Scripted answer",
    ]);
  } finally {
    await harness.close();
  }
});

test("the Usage example writes one card for a reply pi retried", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspace = await makeWorkspace("usage-reply-card-retry");
  await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: PROVIDER_ID,
      defaultModel: MODEL_ID,
      enabledModels: [`${PROVIDER_ID}/${MODEL_ID}`],
      packages: [],
      extensions: [join(examples, "usage", "index.ts")],
      cacheWarming: "off",
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 2, baseDelayMs: 10 },
    }),
  );
  await writeProjectExtension(workspace, "scripted-provider.ts", scriptedProvider(true));
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
    await window.getByLabel("New thread prompt", { exact: true }).fill("Answer briefly.");
    await window.getByRole("button", { name: "Start thread", exact: true }).click();
    await expect(window.locator(".timeline-item--assistant .message__content").last()).toHaveText(
      "Scripted answer",
    );
    // The failed attempt and the retry are one reply: one card that counts both calls.
    const card = window.getByTestId("extension-card");
    await expect(card).toHaveCount(1);
    const values = card.locator(".extension-card__value");
    await expect(values.nth(1)).toHaveText("2");
    await expect(values.nth(3)).toHaveText("20k in · 400 out · 90% cached");
  } finally {
    await harness.close();
  }
});
