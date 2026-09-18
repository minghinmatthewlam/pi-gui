import { expect, test } from "@playwright/test";
import {
  createSessionViaIpc,
  getDesktopState,
  getRealAuthConfig,
  getTimelineScrollMetrics,
  jumpTimelineToBottom,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  scrollTimelineAwayFromBottom,
  seedTranscriptMessages,
} from "../helpers/electron-app";

test("real stream stays pinned, then a wheel unsticks without snap-back", async () => {
  test.setTimeout(180_000);
  const realAuth = getRealAuthConfig();
  test.skip(!realAuth.enabled, realAuth.skipReason);

  const provider = process.env.PI_GUI_PROVIDER?.trim() || "openai-codex";
  const model = process.env.PI_GUI_MODEL?.trim() || "gpt-5.6-luna";
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("live-streaming-scroll");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
    realAuthSourceDir: realAuth.sourceDir,
    enabledModels: [`${provider}/${model}`],
  });

  try {
    const window = await harness.firstWindow();
    const state = await getDesktopState(window);
    const workspaceId = state.selectedWorkspaceId ?? state.workspaces[0]?.id;
    if (!workspaceId) {
      throw new Error("No workspace available");
    }
    await createSessionViaIpc(window, workspaceId, "Live streaming scroll");
    await seedTranscriptMessages(harness, window, {
      count: 24,
      textFactory: (index) => `Live scroll seed row ${index} `.repeat(8),
    });
    await jumpTimelineToBottom(window);
    await expect
      .poll(async () => (await getTimelineScrollMetrics(window)).remainingFromBottom)
      .toBeLessThanOrEqual(16);

    const composer = window.getByTestId("composer");
    await composer.fill(
      "Do not use tools. Write 50 numbered lines about keeping a chat timeline stuck to new tokens, at least 10 words per line. Begin with SCROLL_BEGIN and finish with SCROLL_DONE.",
    );
    await composer.press("Enter");
    await expect(window.getByTestId("send")).toHaveAttribute("aria-label", "Stop run", {
      timeout: 30_000,
    });

    const assistant = window.locator(".timeline-item--assistant .message__content");
    const pinnedSamples: number[] = [];
    await expect
      .poll(
        async () => {
          if (await window.getByTestId("composer-error-banner").count()) {
            throw new Error(await window.getByTestId("composer-error-banner").innerText());
          }
          const text = ((await assistant.last().textContent()) ?? "").trim();
          pinnedSamples.push((await getTimelineScrollMetrics(window)).remainingFromBottom);
          return text.includes("SCROLL_BEGIN") && text.length > 400;
        },
        { timeout: 90_000 },
      )
      .toBe(true);

    const stillRunning = await window.getByTestId("send").getAttribute("aria-label");
    expect(stillRunning).toBe("Stop run");
    const midRemaining = (await getTimelineScrollMetrics(window)).remainingFromBottom;
    expect(
      midRemaining,
      `expected stick-to-bottom while streaming, remaining=${midRemaining}, samples=${pinnedSamples.slice(-8).join(",")}`,
    ).toBeLessThanOrEqual(48);

    await scrollTimelineAwayFromBottom(window, 240);
    await expect
      .poll(async () => (await getTimelineScrollMetrics(window)).remainingFromBottom)
      .toBeGreaterThan(100);
    const awayTop = (await getTimelineScrollMetrics(window)).scrollTop;
    await window.waitForTimeout(900);
    const afterAway = await getTimelineScrollMetrics(window);
    expect(Math.abs(afterAway.scrollTop - awayTop)).toBeLessThanOrEqual(48);
    await expect(window.getByTestId("timeline-jump")).toHaveCount(1);

    await expect(assistant.last()).toContainText("SCROLL_DONE", { timeout: 120_000 });
  } finally {
    await harness.close();
  }
});
