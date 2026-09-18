import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  commitAllInGitRepo,
  createSessionViaIpc,
  desktopShortcut,
  getDesktopState,
  getTimelineScrollMetrics,
  initGitRepo,
  jumpTimelineToBottom,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  scrollTimelineAwayFromBottom,
  selectSession,
  seedTranscriptMessages,
  streamAssistantDeltas,
} from "../helpers/electron-app";
import { appendMessagesToSessionFile, sessionFilePathFromCatalog } from "../helpers/session-file";

const multilineDraft = ["line 1", "line 2", "line 3", "line 4", "line 5", "line 6"].join("\n");

const TIMELINE_NEAR_BOTTOM_PX = 32;

async function expectRowVisibleAboveComposer(
  window: Page,
  row: Locator,
  composerShell: Locator,
): Promise<void> {
  await expect
    .poll(async () => {
      const [rowBox, composerBox, paneBox] = await Promise.all([
        row.boundingBox(),
        composerShell.boundingBox(),
        window.getByTestId("timeline-pane").boundingBox(),
      ]);
      if (!rowBox || !composerBox || !paneBox) {
        return { gapToComposer: -999, fullyVisibleWithinPane: false };
      }
      const rowTop = rowBox.y;
      const rowBottom = rowBox.y + rowBox.height;
      const paneTop = paneBox.y;
      const paneBottom = paneBox.y + paneBox.height;
      return {
        gapToComposer: composerBox.y - rowBottom,
        fullyVisibleWithinPane: rowTop >= paneTop - 1 && rowBottom <= paneBottom + 1,
      };
    })
    .toMatchObject({
      gapToComposer: expect.any(Number),
      fullyVisibleWithinPane: true,
    });
  await expect
    .poll(async () => {
      const [rowBox, composerBox] = await Promise.all([
        row.boundingBox(),
        composerShell.boundingBox(),
      ]);
      if (!rowBox || !composerBox) {
        return -999;
      }
      return composerBox.y - (rowBox.y + rowBox.height);
    })
    .toBeGreaterThanOrEqual(-1);
}

interface TimelineStabilitySample {
  readonly virtualized: boolean;
  readonly visibleItemCount: number;
  readonly renderedTextLength: number;
  readonly remainingFromBottom: number;
  readonly sentinelVisible: boolean;
}

async function sampleTimelineStability(
  window: Page,
  sentinelRow: Locator,
): Promise<TimelineStabilitySample> {
  const [rowBox, paneBox, renderMetrics, scrollMetrics] = await Promise.all([
    sentinelRow.boundingBox(),
    window.getByTestId("timeline-pane").boundingBox(),
    window.evaluate(() => {
      const transcript = document.querySelector<HTMLElement>("[data-testid='transcript']");
      return {
        virtualized: Boolean(document.querySelector(".timeline--virtualized")),
        visibleItemCount: document.querySelectorAll(".timeline-item").length,
        renderedTextLength: (transcript?.textContent ?? "").trim().length,
      };
    }),
    getTimelineScrollMetrics(window),
  ]);

  const sentinelVisible = Boolean(
    rowBox &&
    paneBox &&
    rowBox.y >= paneBox.y - 1 &&
    rowBox.y + rowBox.height <= paneBox.y + paneBox.height + 1,
  );

  return {
    ...renderMetrics,
    remainingFromBottom: scrollMetrics.remainingFromBottom,
    sentinelVisible,
  };
}

async function sampleTimelineCollapseWindow(
  window: Page,
  frameCount = 24,
): Promise<Pick<TimelineStabilitySample, "visibleItemCount" | "renderedTextLength">> {
  return window.evaluate(async (targetFrameCount) => {
    const samples: Array<{ visibleItemCount: number; renderedTextLength: number }> = [];
    await new Promise<void>((resolve) => {
      let remainingFrames = targetFrameCount;
      const captureFrame = () => {
        const transcript = document.querySelector<HTMLElement>("[data-testid='transcript']");
        samples.push({
          visibleItemCount: document.querySelectorAll(".timeline-item").length,
          renderedTextLength: (transcript?.textContent ?? "").trim().length,
        });
        remainingFrames -= 1;
        if (remainingFrames <= 0) {
          resolve();
          return;
        }
        globalThis.window.requestAnimationFrame(captureFrame);
      };

      globalThis.window.requestAnimationFrame(captureFrame);
    });

    return samples.reduce(
      (minimums, sample) => ({
        visibleItemCount: Math.min(minimums.visibleItemCount, sample.visibleItemCount),
        renderedTextLength: Math.min(minimums.renderedTextLength, sample.renderedTextLength),
      }),
      {
        visibleItemCount: Number.POSITIVE_INFINITY,
        renderedTextLength: Number.POSITIVE_INFINITY,
      },
    );
  }, frameCount);
}

async function waitForStableVirtualizedBottom(
  window: Page,
  sentinelRow: Locator,
): Promise<Pick<TimelineStabilitySample, "visibleItemCount" | "renderedTextLength">> {
  let consecutiveStableSamples = 0;
  let baselineSample: TimelineStabilitySample | null = null;
  let lastSample: TimelineStabilitySample | null = null;

  for (let index = 0; index < 150; index += 1) {
    const sample = await sampleTimelineStability(window, sentinelRow);
    lastSample = sample;
    if (
      sample.virtualized &&
      sample.remainingFromBottom < TIMELINE_NEAR_BOTTOM_PX &&
      sample.sentinelVisible
    ) {
      consecutiveStableSamples += 1;
      baselineSample = sample;
      if (consecutiveStableSamples >= 5 && baselineSample) {
        return {
          visibleItemCount: baselineSample.visibleItemCount,
          renderedTextLength: baselineSample.renderedTextLength,
        };
      }
    } else {
      consecutiveStableSamples = 0;
      baselineSample = null;
    }
    await window.waitForTimeout(100);
  }

  throw new Error(
    `Timeline never reached a stable virtualized bottom state. Last sample: ${JSON.stringify(lastSample)}`,
  );
}

async function expectStableTimelineWindow(
  window: Page,
  sentinelRow: Locator,
  baseline: Pick<TimelineStabilitySample, "visibleItemCount" | "renderedTextLength">,
): Promise<void> {
  const minimumVisibleItems = Math.max(1, Math.floor(baseline.visibleItemCount * 0.6));
  const minimumRenderedTextLength = Math.max(1, Math.floor(baseline.renderedTextLength * 0.6));

  for (let index = 0; index < 8; index += 1) {
    const sample = await sampleTimelineStability(window, sentinelRow);
    expect(sample.virtualized).toBe(true);
    expect(sample.sentinelVisible).toBe(true);
    expect(sample.remainingFromBottom).toBeLessThan(TIMELINE_NEAR_BOTTOM_PX);
    expect(sample.visibleItemCount).toBeGreaterThanOrEqual(minimumVisibleItems);
    expect(sample.renderedTextLength).toBeGreaterThanOrEqual(minimumRenderedTextLength);
    await window.waitForTimeout(100);
  }
}

async function expectNoTimelineCollapseWindow(
  window: Page,
  baseline: Pick<TimelineStabilitySample, "visibleItemCount" | "renderedTextLength">,
): Promise<void> {
  const minimumVisibleItems = Math.max(1, Math.floor(baseline.visibleItemCount * 0.6));
  const minimumRenderedTextLength = Math.max(1, Math.floor(baseline.renderedTextLength * 0.6));

  const sample = await sampleTimelineCollapseWindow(window);
  expect(sample.visibleItemCount).toBeGreaterThanOrEqual(minimumVisibleItems);
  expect(sample.renderedTextLength).toBeGreaterThanOrEqual(minimumRenderedTextLength);
}

async function setDesktopActiveView(window: Page, view: "threads" | "settings"): Promise<void> {
  await window.evaluate(async (nextView) => {
    const app = globalThis.window.piApp;
    if (!app) {
      throw new Error("piApp IPC bridge is unavailable");
    }
    await app.setActiveView(nextView);
  }, view);
}

async function createTimelineSession(
  window: Parameters<typeof getDesktopState>[0],
  title: string,
): Promise<void> {
  const state = await getDesktopState(window);
  const workspaceId = state.selectedWorkspaceId || state.workspaces[0]?.id;
  if (!workspaceId) {
    throw new Error("No selected workspace available for timeline pinning test");
  }

  await window.evaluate(
    async ({ targetTitle, targetWorkspaceId }) => {
      const app = globalThis.window.piApp;
      if (!app) {
        throw new Error("piApp IPC bridge is unavailable");
      }

      const beforeState = await app.getState();
      const beforeWorkspace = beforeState.workspaces.find(
        (workspace) => workspace.id === targetWorkspaceId,
      );
      const beforeIds = new Set(beforeWorkspace?.sessions.map((session) => session.id) ?? []);
      const nextState = await app.createSession({
        workspaceId: targetWorkspaceId,
        title: targetTitle,
      });
      const nextWorkspace = nextState.workspaces.find(
        (workspace) => workspace.id === targetWorkspaceId,
      );
      const session =
        nextWorkspace?.sessions.find(
          (entry) => !beforeIds.has(entry.id) && entry.title === targetTitle,
        ) ?? nextWorkspace?.sessions.find((entry) => entry.title === targetTitle);
      if (!session) {
        throw new Error(`Session not found after createSession: ${targetTitle}`);
      }

      await app.selectSession({ workspaceId: targetWorkspaceId, sessionId: session.id });
      await app.setActiveView("threads");
    },
    { targetTitle: title, targetWorkspaceId: workspaceId },
  );

  await expect
    .poll(async () => {
      const nextState = await getDesktopState(window);
      return {
        activeView: nextState.activeView,
        selectedSessionId: nextState.selectedSessionId,
      };
    })
    .toMatchObject({ activeView: "threads" });
  await expect(window.getByTestId("composer")).toBeVisible({ timeout: 15_000 });
}

test("keeps the latest assistant content visible when the composer grows at the bottom of a thread", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("timeline-pinning-bottom");
  await initGitRepo(workspacePath);
  await commitAllInGitRepo(workspacePath, "init");
  await writeFile(join(workspacePath, "README.md"), "# timeline pinning\nupdated\n", "utf8");

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createTimelineSession(window, "Bottom pinning session");

    const finalMarker = "PIN_FINAL_ROW";
    const finalText = `${finalMarker} ${"visible above composer with width reflow ".repeat(10)}`;
    const { messages } = await seedTranscriptMessages(harness, window, {
      count: 14,
      textFactory: (index) => (index === 13 ? finalText : `Pinned seed row ${index} `.repeat(8)),
    });
    await expect(window.getByTestId("transcript")).toContainText(messages.at(-1) ?? finalText);

    await jumpTimelineToBottom(window);
    await expect
      .poll(() => getTimelineScrollMetrics(window))
      .toMatchObject({
        remainingFromBottom: expect.any(Number),
      });
    await expect
      .poll(async () => {
        const metrics = await getTimelineScrollMetrics(window);
        return {
          overflowed: metrics.scrollHeight > metrics.clientHeight + 32,
          scrolled: metrics.scrollTop > 0,
          remaining: metrics.remainingFromBottom,
        };
      })
      .toMatchObject({
        overflowed: true,
        scrolled: true,
        remaining: expect.any(Number),
      });
    await expect
      .poll(async () => (await getTimelineScrollMetrics(window)).remainingFromBottom)
      .toBeLessThanOrEqual(16);

    const composer = window.getByTestId("composer");
    const composerShell = window.locator(".composer");
    const finalRow = window.locator(".timeline-item--assistant", { hasText: finalMarker });

    const beforeComposerHeight = (await composerShell.boundingBox())?.height ?? 0;
    expect(beforeComposerHeight).toBeGreaterThan(0);

    await composer.fill(multilineDraft);
    await expect(composer).toHaveValue(multilineDraft);
    await expect
      .poll(async () => ((await composerShell.boundingBox())?.height ?? 0) - beforeComposerHeight)
      .toBeGreaterThan(40);

    await expectRowVisibleAboveComposer(window, finalRow, composerShell);
    await expect
      .poll(async () => (await getTimelineScrollMetrics(window)).remainingFromBottom)
      .toBeLessThanOrEqual(16);

    const diffPanel = window.locator(".diff-panel");
    await window.keyboard.press(desktopShortcut("D"));
    await expect(diffPanel).toBeVisible();
    await expect(diffPanel.locator(".diff-panel__file-name")).toContainText("README.md");
    await expect(window.getByTestId("timeline-pane")).toBeVisible();
    await expect(composerShell).toBeVisible();
    await expectRowVisibleAboveComposer(window, finalRow, composerShell);
    await expect
      .poll(async () => (await getTimelineScrollMetrics(window)).remainingFromBottom)
      .toBeLessThanOrEqual(32);
    await expect(window.getByTestId("timeline-jump")).toHaveCount(0);
  } finally {
    await harness.close();
  }
});

test("restores bottom pinning after leaving and returning to the thread surface", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("timeline-pinning-remount");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createTimelineSession(window, "Remount pinning session");

    const finalMarker = "REMOUNT_FINAL_ROW";
    const finalText = `${finalMarker} ${"should remain visible after view remount ".repeat(4)}`;
    await seedTranscriptMessages(harness, window, {
      count: 18,
      textFactory: (index) => (index === 17 ? finalText : `Remount seed row ${index} `.repeat(8)),
    });
    await expect(window.getByTestId("transcript")).toContainText(finalMarker);

    await jumpTimelineToBottom(window);
    await expect
      .poll(async () => (await getTimelineScrollMetrics(window)).remainingFromBottom)
      .toBeLessThanOrEqual(16);

    const composer = window.getByTestId("composer");
    const composerShell = window.locator(".composer");
    const finalRow = window.locator(".timeline-item--assistant", { hasText: finalMarker });
    await composer.fill(multilineDraft);
    await expect(composer).toHaveValue(multilineDraft);
    await expectRowVisibleAboveComposer(window, finalRow, composerShell);

    await setDesktopActiveView(window, "settings");
    await expect.poll(async () => (await getDesktopState(window)).activeView).toBe("settings");
    await expect(window.getByTestId("timeline-pane")).toHaveCount(0);
    await expect(window.getByTestId("composer")).toHaveCount(0);

    await setDesktopActiveView(window, "threads");
    await expect.poll(async () => (await getDesktopState(window)).activeView).toBe("threads");
    await expect(window.getByTestId("timeline-pane")).toBeVisible();
    await expect(window.getByTestId("composer")).toBeVisible();
    await expectRowVisibleAboveComposer(window, finalRow, composerShell);
    await expect
      .poll(async () => (await getTimelineScrollMetrics(window)).remainingFromBottom)
      .toBeLessThanOrEqual(16);
    await expect(window.getByTestId("timeline-jump")).toHaveCount(0);
  } finally {
    await harness.close();
  }
});

test("restores the true bottom when reopening a virtualized thread with oversized late rows", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("timeline-pinning-virtualized-reopen");
  let harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    let window = await harness.firstWindow();
    const targetTitle = "Virtualized restore target";
    await createTimelineSession(window, targetTitle);

    const finalMarker = "VIRTUALIZED_RESTORE_FINAL_ROW";
    const oversizedLateRow = `VIRTUALIZED_RESTORE_OVERSIZED ${"wrapped restore content ".repeat(420)}`;
    const seeded = await seedTranscriptMessages(harness, window, {
      count: 110,
      textFactory: (index) => {
        if (index === 94 || index === 103) {
          return oversizedLateRow;
        }
        if (index === 109) {
          return `${finalMarker} ${"should stay visible at the real bottom ".repeat(8)}`;
        }
        return `Virtualized restore row ${index} `.repeat(8);
      },
    });
    // Transcripts are restored from pi's session file, so the seeded rows must
    // exist there for them to survive the relaunch.
    await appendMessagesToSessionFile(
      await sessionFilePathFromCatalog(userDataDir, seeded.sessionRef),
      seeded.messages.map((text) => ({ role: "assistant" as const, text })),
    );

    await harness.close();

    harness = await launchDesktop(userDataDir, { testMode: "background" });
    window = await harness.firstWindow();
    await expect(window.locator(".topbar__session")).toHaveText(targetTitle);
    await expect(
      window.locator(".timeline-item--assistant", { hasText: finalMarker }),
    ).toBeVisible();
    await expect
      .poll(async () => (await getTimelineScrollMetrics(window)).remainingFromBottom)
      .toBeLessThanOrEqual(16);

    await createTimelineSession(window, "Neighbor session");
    await expect(window.locator(".topbar__session")).toHaveText("Neighbor session");

    await selectSession(window, targetTitle);
    const finalRow = window.locator(".timeline-item--assistant", { hasText: finalMarker });
    await expect(finalRow).toBeVisible();
    await expect
      .poll(async () => (await getTimelineScrollMetrics(window)).remainingFromBottom)
      .toBeLessThanOrEqual(16);
  } finally {
    await harness.close();
  }
});

test("keeps a virtualized thread off-bottom after switching sessions", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("timeline-pinning-virtualized-mid-history-reopen");
  let harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    let window = await harness.firstWindow();
    const targetTitle = "Virtualized mid-history restore target";
    await createTimelineSession(window, targetTitle);

    const finalMarker = "VIRTUALIZED_MIDDLE_RESTORE_FINAL_ROW";
    await seedTranscriptMessages(harness, window, {
      count: 110,
      textFactory: (index) => {
        if (index === 109) {
          return `${finalMarker} ${"should stay offscreen when reopening mid-history ".repeat(6)}`;
        }
        return `Virtualized mid-history row ${index} `.repeat(8);
      },
    });

    await scrollTimelineAwayFromBottom(window, 1_600);
    const preReopenMetrics = await getTimelineScrollMetrics(window);
    expect(preReopenMetrics.remainingFromBottom).toBeGreaterThan(500);

    await createTimelineSession(window, "Neighbor session");
    await expect(window.locator(".topbar__session")).toHaveText("Neighbor session");

    await selectSession(window, targetTitle);
    await expect(window.locator(".topbar__session")).toHaveText(targetTitle);
    await expect
      .poll(async () => (await getTimelineScrollMetrics(window)).remainingFromBottom)
      .toBeGreaterThan(500);
  } finally {
    await harness.close();
  }
});

test("restores a thread's saved off-bottom scroll position after switching sessions", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("timeline-pinning-session-switch-scroll");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    const targetTitle = "Saved scroll restore target";
    const neighborTitle = "Saved scroll neighbor";
    await createTimelineSession(window, targetTitle);
    await createTimelineSession(window, neighborTitle);
    await expect(window.locator(".topbar__session")).toHaveText(neighborTitle);
    await selectSession(window, targetTitle);
    await expect(window.locator(".topbar__session")).toHaveText(targetTitle);

    const finalMarker = "SESSION_SWITCH_SCROLL_FINAL_ROW";
    await seedTranscriptMessages(harness, window, {
      count: 78,
      textFactory: (index) => {
        if (index === 77) {
          return `${finalMarker} ${"should stay below the restored viewport ".repeat(20)}`;
        }
        return `Saved scroll restore row ${index} `.repeat(20);
      },
    });

    await jumpTimelineToBottom(window);
    await expect
      .poll(async () => {
        const metrics = await getTimelineScrollMetrics(window);
        return metrics.scrollHeight - metrics.clientHeight;
      })
      .toBeGreaterThan(700);
    await expect
      .poll(async () => (await getTimelineScrollMetrics(window)).remainingFromBottom)
      .toBeLessThanOrEqual(16);
    await window.waitForTimeout(800);

    await scrollTimelineAwayFromBottom(window, 1_600);
    const savedMetrics = await getTimelineScrollMetrics(window);
    expect(savedMetrics.remainingFromBottom).toBeGreaterThan(700);
    await window.waitForTimeout(250);
    await expect
      .poll(async () => (await getTimelineScrollMetrics(window)).remainingFromBottom)
      .toBeGreaterThan(700);

    await selectSession(window, neighborTitle);
    await expect(window.locator(".topbar__session")).toHaveText(neighborTitle);

    await selectSession(window, targetTitle);
    await expect(window.locator(".topbar__session")).toHaveText(targetTitle);
    await expect
      .poll(async () => (await getTimelineScrollMetrics(window)).remainingFromBottom)
      .toBeGreaterThan(300);
    await expect(window.getByTestId("timeline-jump")).toHaveCount(0);

    const restoredRemaining = (await getTimelineScrollMetrics(window)).remainingFromBottom;
    await expect
      .poll(async () => {
        await window.evaluate((distance) => {
          const pane = document.querySelector<HTMLDivElement>("[data-testid='timeline-pane']");
          if (!pane) {
            throw new Error("Timeline pane was unavailable");
          }
          pane.dispatchEvent(
            new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: distance }),
          );
          pane.scrollTop = Math.min(
            pane.scrollHeight - pane.clientHeight,
            pane.scrollTop + distance,
          );
          pane.dispatchEvent(new Event("scroll", { bubbles: true }));
        }, 520);
        return restoredRemaining - (await getTimelineScrollMetrics(window)).remainingFromBottom;
      })
      .toBeGreaterThan(120);
    const userAdjustedRemaining = (await getTimelineScrollMetrics(window)).remainingFromBottom;
    await window.waitForTimeout(2_300);
    await expect
      .poll(async () => (await getTimelineScrollMetrics(window)).remainingFromBottom)
      .toBeLessThanOrEqual(userAdjustedRemaining + 80);
  } finally {
    await harness.close();
  }
});

test("lands a reopened bottom-pinned thread without a smooth scroll from the top", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("timeline-pinning-open-no-smooth-scroll");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    const targetTitle = "Open no smooth scroll target";
    await createTimelineSession(window, targetTitle);

    const finalMarker = "OPEN_NO_SMOOTH_FINAL_ROW";
    await seedTranscriptMessages(harness, window, {
      count: 24,
      textFactory: (index) =>
        index === 23
          ? `${finalMarker} ${"should be at the bottom immediately ".repeat(6)}`
          : `Open no smooth row ${index} `.repeat(8),
    });

    await jumpTimelineToBottom(window);
    await expect
      .poll(async () => (await getTimelineScrollMetrics(window)).remainingFromBottom)
      .toBeLessThanOrEqual(16);

    await createTimelineSession(window, "Open no smooth neighbor");
    await expect(window.locator(".topbar__session")).toHaveText("Open no smooth neighbor");
    await selectSession(window, targetTitle);
    await expect(window.getByTestId("transcript")).toContainText(finalMarker);
    await expect
      .poll(async () => {
        const metrics = await getTimelineScrollMetrics(window);
        return metrics.scrollHeight > metrics.clientHeight + 32;
      })
      .toBe(true);

    const samples: number[] = [];
    for (let index = 0; index < 12; index += 1) {
      samples.push((await getTimelineScrollMetrics(window)).remainingFromBottom);
      await window.waitForTimeout(16);
    }
    const maxSample = Math.max(...samples);
    expect(
      maxSample,
      `remaining-from-bottom samples after reopen: ${samples.join(", ")}`,
    ).toBeLessThan(60);

    await expect(
      window.locator(".timeline-item--assistant", { hasText: finalMarker }),
    ).toBeVisible();
    await expect
      .poll(async () => (await getTimelineScrollMetrics(window)).remainingFromBottom)
      .toBeLessThanOrEqual(16);
  } finally {
    await harness.close();
  }
});

test("keeps a reopened virtualized long transcript stable", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("timeline-pinning-virtualized-stable-reopen");
  let harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    let window = await harness.firstWindow();
    const targetTitle = "Virtualized stable reopen target";
    await createTimelineSession(window, targetTitle);

    const finalMarker = "VIRTUALIZED_STABLE_FINAL_ROW";
    const seeded = await seedTranscriptMessages(harness, window, {
      count: 110,
      textFactory: (index) =>
        index === 109
          ? `${finalMarker} ${"should remain visible after reopen ".repeat(6)}`
          : `Virtualized stable row ${index} `.repeat(8),
    });
    // Transcripts are restored from pi's session file, so the seeded rows must
    // exist there for them to survive the relaunch.
    await appendMessagesToSessionFile(
      await sessionFilePathFromCatalog(userDataDir, seeded.sessionRef),
      seeded.messages.map((text) => ({ role: "assistant" as const, text })),
    );
    const finalRow = window.locator(".timeline-item--assistant", { hasText: finalMarker });
    const preReopenBaseline = await waitForStableVirtualizedBottom(window, finalRow);

    await harness.close();

    harness = await launchDesktop(userDataDir, { testMode: "background" });
    window = await harness.firstWindow();
    await expect(window.locator(".topbar__session")).toHaveText(targetTitle);
    const reopenedFinalRow = window.locator(".timeline-item--assistant", { hasText: finalMarker });

    await expectNoTimelineCollapseWindow(window, preReopenBaseline);
    const baseline = await waitForStableVirtualizedBottom(window, reopenedFinalRow);
    await expectStableTimelineWindow(window, reopenedFinalRow, baseline);

    const composer = window.getByTestId("composer");
    await composer.fill(multilineDraft);
    await expect(composer).toHaveValue(multilineDraft);
    await expectNoTimelineCollapseWindow(window, baseline);
    const postComposerBaseline = await waitForStableVirtualizedBottom(window, reopenedFinalRow);
    await expectStableTimelineWindow(window, reopenedFinalRow, postComposerBaseline);

    const pinnedStream = await streamAssistantDeltas(harness, window, [
      "VIRTUALIZED_REOPEN_STREAM_A ",
      "VIRTUALIZED_REOPEN_STREAM_B ",
      "VIRTUALIZED_REOPEN_STREAM_C",
    ]);
    const streamedRow = window.locator(".timeline-item--assistant", {
      hasText: pinnedStream.fullText,
    });
    await expect(streamedRow).toBeVisible();
    const streamedCompletionRow = window
      .locator(".timeline-summary", { hasText: "Worked for" })
      .last();
    const streamedBaseline = await waitForStableVirtualizedBottom(window, streamedCompletionRow);
    await expectStableTimelineWindow(window, streamedCompletionRow, streamedBaseline);
  } finally {
    await harness.close();
  }
});

test("keeps the mid-thread viewport stable when the composer grows away from the bottom", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("timeline-pinning-middle");
  await initGitRepo(workspacePath);
  await commitAllInGitRepo(workspacePath, "init");
  await writeFile(join(workspacePath, "README.md"), "# mid-thread pinning\nupdated\n", "utf8");

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createTimelineSession(window, "Mid-thread pinning session");

    const sentinelMarker = "MID_SENTINEL_ROW";
    const sentinelText = `${sentinelMarker} ${"should stay put during width reflow ".repeat(10)}`;
    const finalText = `MID_FINAL_ROW ${"at thread bottom with wrapping text ".repeat(10)}`;
    await seedTranscriptMessages(harness, window, {
      count: 16,
      textFactory: (index) => {
        if (index === 5) return sentinelText;
        if (index === 15) return finalText;
        return `Mid-thread seed row ${index} `.repeat(8);
      },
    });
    await expect(window.getByTestId("transcript")).toContainText(finalText);

    await jumpTimelineToBottom(window);
    await expect
      .poll(async () => (await getTimelineScrollMetrics(window)).remainingFromBottom)
      .toBeLessThanOrEqual(16);

    await scrollTimelineAwayFromBottom(window, 220);
    await expect
      .poll(async () => (await getTimelineScrollMetrics(window)).remainingFromBottom)
      .toBeGreaterThan(100);

    const composer = window.getByTestId("composer");
    const composerShell = window.locator(".composer");
    const sentinelRow = window.locator(".timeline-item--assistant", { hasText: sentinelMarker });
    await expect(sentinelRow).toBeVisible();

    const beforeComposerHeight = (await composerShell.boundingBox())?.height ?? 0;
    const beforeSentinelY = (await sentinelRow.boundingBox())?.y ?? 0;
    const beforeScrollTop = (await getTimelineScrollMetrics(window)).scrollTop;

    await composer.fill(multilineDraft);
    await expect(composer).toHaveValue(multilineDraft);
    await expect
      .poll(async () => ((await composerShell.boundingBox())?.height ?? 0) - beforeComposerHeight)
      .toBeGreaterThan(40);

    await expect
      .poll(async () => {
        const rowBox = await sentinelRow.boundingBox();
        return rowBox ? Math.abs(rowBox.y - beforeSentinelY) : Number.POSITIVE_INFINITY;
      })
      .toBeLessThanOrEqual(12);
    await expect
      .poll(async () => {
        const metrics = await getTimelineScrollMetrics(window);
        return Math.abs(metrics.scrollTop - beforeScrollTop);
      })
      .toBeLessThanOrEqual(12);
    await expect(window.getByTestId("timeline-jump")).toHaveCount(0);

    const diffPanel = window.locator(".diff-panel");
    const beforeDiffSentinelY = (await sentinelRow.boundingBox())?.y ?? 0;
    const beforeDiffScrollTop = (await getTimelineScrollMetrics(window)).scrollTop;
    await window.keyboard.press(desktopShortcut("D"));
    await expect(diffPanel).toBeVisible();
    await expect(diffPanel.locator(".diff-panel__file-name")).toContainText("README.md");
    await expect
      .poll(async () => {
        const rowBox = await sentinelRow.boundingBox();
        return rowBox ? Math.abs(rowBox.y - beforeDiffSentinelY) : Number.POSITIVE_INFINITY;
      })
      .toBeLessThanOrEqual(12);
    await expect
      .poll(async () => {
        const metrics = await getTimelineScrollMetrics(window);
        return Math.abs(metrics.scrollTop - beforeDiffScrollTop);
      })
      .toBeLessThanOrEqual(12);
    await expect(window.getByTestId("timeline-jump")).toHaveCount(0);
  } finally {
    await harness.close();
  }
});

test("keeps transcript pinning semantics while assistant deltas stream into the same row", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("timeline-pinning-streaming");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createTimelineSession(window, "Streaming pinning session");

    const finalSeedMarker = "Streaming seed row 23";
    await seedTranscriptMessages(harness, window, {
      count: 24,
      textFactory: (index) => `Streaming seed row ${index} `.repeat(8),
    });
    await expect(window.getByTestId("transcript")).toContainText(finalSeedMarker);

    await jumpTimelineToBottom(window);
    await expect
      .poll(async () => {
        const metrics = await getTimelineScrollMetrics(window);
        return {
          overflowed: metrics.scrollHeight > metrics.clientHeight + 32,
          scrolled: metrics.scrollTop > 0,
          remaining: metrics.remainingFromBottom,
        };
      })
      .toMatchObject({
        overflowed: true,
        scrolled: true,
        remaining: expect.any(Number),
      });
    await expect
      .poll(async () => (await getTimelineScrollMetrics(window)).remainingFromBottom)
      .toBeLessThanOrEqual(16);

    const pinnedStream = await streamAssistantDeltas(harness, window, [
      "PINNED_STREAM_CHUNK_A ",
      "PINNED_STREAM_CHUNK_B ",
      "PINNED_STREAM_CHUNK_C",
    ]);
    await expect(window.getByTestId("transcript")).toContainText(pinnedStream.fullText);
    await expect
      .poll(async () => (await getTimelineScrollMetrics(window)).remainingFromBottom)
      .toBeLessThanOrEqual(16);

    await scrollTimelineAwayFromBottom(window, 220);
    await expect
      .poll(async () => (await getTimelineScrollMetrics(window)).remainingFromBottom)
      .toBeGreaterThan(100);
    const beforeScrollTop = (await getTimelineScrollMetrics(window)).scrollTop;

    const awayStream = await streamAssistantDeltas(harness, window, [
      "AWAY_STREAM_CHUNK_A ",
      "AWAY_STREAM_CHUNK_B ",
      "AWAY_STREAM_CHUNK_C",
    ]);
    await expect(window.getByTestId("transcript")).toContainText(awayStream.fullText);
    await expect
      .poll(async () => {
        const metrics = await getTimelineScrollMetrics(window);
        return Math.abs(metrics.scrollTop - beforeScrollTop);
      })
      .toBeLessThanOrEqual(12);
    await expect(window.getByTestId("timeline-jump")).toHaveCount(1);
  } finally {
    await harness.close();
  }
});

test("lands an opened thread at the bottom without a smooth scroll from the top", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("timeline-pinning-short-open-no-smooth-scroll");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    const targetTitle = "Short open no smooth scroll";
    const initialState = await getDesktopState(window);
    const workspaceId = initialState.selectedWorkspaceId ?? initialState.workspaces[0]?.id ?? "";
    if (!workspaceId) {
      throw new Error("No workspace available");
    }
    await createSessionViaIpc(window, workspaceId, targetTitle);

    const finalMarker = "SHORT_OPEN_NO_SMOOTH_FINAL_ROW";
    await seedTranscriptMessages(harness, window, {
      count: 20,
      textFactory: (index) => (index === 19 ? finalMarker : `Short open row ${index} `.repeat(6)),
    });

    await jumpTimelineToBottom(window);
    await expect
      .poll(async () => (await getTimelineScrollMetrics(window)).remainingFromBottom)
      .toBeLessThanOrEqual(16);

    await createSessionViaIpc(window, workspaceId, "Short open neighbor");
    await selectSession(window, "Short open neighbor");
    await selectSession(window, targetTitle);

    // Sample the scroll position over ~12 frames after the open.
    const samples: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      samples.push((await getTimelineScrollMetrics(window)).remainingFromBottom);
      await window.waitForTimeout(16);
    }
    const maxSample = Math.max(...samples);
    expect(
      maxSample,
      `scroll samples after open: ${samples.join(", ")} (max ${maxSample})`,
    ).toBeLessThan(60);

    await expect(
      window.locator(".timeline-item--assistant", { hasText: finalMarker }),
    ).toBeVisible();
    await expect
      .poll(async () => (await getTimelineScrollMetrics(window)).remainingFromBottom, {
        timeout: 5_000,
      })
      .toBeLessThanOrEqual(16);
  } finally {
    await harness.close();
  }
});
