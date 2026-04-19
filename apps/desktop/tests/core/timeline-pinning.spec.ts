import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  commitAllInGitRepo,
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

const multilineDraft = [
  "line 1",
  "line 2",
  "line 3",
  "line 4",
  "line 5",
  "line 6",
].join("\n");

async function expectRowVisibleAboveComposer(window: Page, row: Locator, composerShell: Locator): Promise<void> {
  await expect.poll(async () => {
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
  }).toMatchObject({
    gapToComposer: expect.any(Number),
    fullyVisibleWithinPane: true,
  });
  await expect.poll(async () => {
    const [rowBox, composerBox] = await Promise.all([row.boundingBox(), composerShell.boundingBox()]);
    if (!rowBox || !composerBox) {
      return -999;
    }
    return composerBox.y - (rowBox.y + rowBox.height);
  }).toBeGreaterThanOrEqual(-1);
}

async function setDesktopActiveView(window: Page, view: "threads" | "settings"): Promise<void> {
  await window.evaluate(async (nextView) => {
    const app = window.piApp;
    if (!app) {
      throw new Error("piApp IPC bridge is unavailable");
    }
    await app.setActiveView(nextView);
  }, view);
}

async function createTimelineSession(window: Parameters<typeof getDesktopState>[0], title: string): Promise<void> {
  const state = await getDesktopState(window);
  const workspaceId = state.selectedWorkspaceId || state.workspaces[0]?.id;
  if (!workspaceId) {
    throw new Error("No selected workspace available for timeline pinning test");
  }

  await window.evaluate(async ({ targetTitle, targetWorkspaceId }) => {
    const app = window.piApp;
    if (!app) {
      throw new Error("piApp IPC bridge is unavailable");
    }

    const beforeState = await app.getState();
    const beforeWorkspace = beforeState.workspaces.find((workspace) => workspace.id === targetWorkspaceId);
    const beforeIds = new Set(beforeWorkspace?.sessions.map((session) => session.id) ?? []);
    const nextState = await app.createSession({ workspaceId: targetWorkspaceId, title: targetTitle });
    const nextWorkspace = nextState.workspaces.find((workspace) => workspace.id === targetWorkspaceId);
    const session = nextWorkspace?.sessions.find((entry) => !beforeIds.has(entry.id) && entry.title === targetTitle)
      ?? nextWorkspace?.sessions.find((entry) => entry.title === targetTitle);
    if (!session) {
      throw new Error(`Session not found after createSession: ${targetTitle}`);
    }

    await app.selectSession({ workspaceId: targetWorkspaceId, sessionId: session.id });
    await app.setActiveView("threads");
  }, { targetTitle: title, targetWorkspaceId: workspaceId });

  await expect.poll(async () => {
    const nextState = await getDesktopState(window);
    return {
      activeView: nextState.activeView,
      selectedSessionId: nextState.selectedSessionId,
    };
  }).toMatchObject({ activeView: "threads" });
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
    await expect.poll(() => getTimelineScrollMetrics(window)).toMatchObject({
      remainingFromBottom: expect.any(Number),
    });
    await expect.poll(async () => {
      const metrics = await getTimelineScrollMetrics(window);
      return {
        overflowed: metrics.scrollHeight > metrics.clientHeight + 32,
        scrolled: metrics.scrollTop > 0,
        remaining: metrics.remainingFromBottom,
      };
    }).toMatchObject({
      overflowed: true,
      scrolled: true,
      remaining: expect.any(Number),
    });
    await expect.poll(async () => (await getTimelineScrollMetrics(window)).remainingFromBottom).toBeLessThanOrEqual(16);

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
    await expect.poll(async () => (await getTimelineScrollMetrics(window)).remainingFromBottom).toBeLessThanOrEqual(16);

    const diffPanel = window.locator(".diff-panel");
    await window.keyboard.press(desktopShortcut("D"));
    await expect(diffPanel).toBeVisible();
    await expect(diffPanel.locator(".diff-panel__file-name")).toContainText("README.md");
    await expect(window.getByTestId("timeline-pane")).toBeVisible();
    await expect(composerShell).toBeVisible();
    await expectRowVisibleAboveComposer(window, finalRow, composerShell);
    await expect.poll(async () => (await getTimelineScrollMetrics(window)).remainingFromBottom).toBeLessThanOrEqual(32);
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
    await expect.poll(async () => (await getTimelineScrollMetrics(window)).remainingFromBottom).toBeLessThanOrEqual(16);

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
    await expect.poll(async () => (await getTimelineScrollMetrics(window)).remainingFromBottom).toBeLessThanOrEqual(16);
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
    await seedTranscriptMessages(harness, window, {
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

    await harness.close();

    harness = await launchDesktop(userDataDir, { testMode: "background" });
    window = await harness.firstWindow();
    await expect(window.locator(".topbar__session")).toHaveText(targetTitle);
    await expect(window.locator(".timeline-item--assistant", { hasText: finalMarker })).toBeVisible();
    await expect.poll(async () => (await getTimelineScrollMetrics(window)).remainingFromBottom).toBeLessThanOrEqual(16);

    await createTimelineSession(window, "Neighbor session");
    await expect(window.locator(".topbar__session")).toHaveText("Neighbor session");

    await selectSession(window, targetTitle);
    const finalRow = window.locator(".timeline-item--assistant", { hasText: finalMarker });
    await expect(finalRow).toBeVisible();
    await expect.poll(async () => (await getTimelineScrollMetrics(window)).remainingFromBottom).toBeLessThanOrEqual(16);
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
    await expect.poll(async () => (await getTimelineScrollMetrics(window)).remainingFromBottom).toBeLessThanOrEqual(16);

    await scrollTimelineAwayFromBottom(window, 220);
    await expect.poll(async () => (await getTimelineScrollMetrics(window)).remainingFromBottom).toBeGreaterThan(100);

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

    await expect.poll(async () => {
      const rowBox = await sentinelRow.boundingBox();
      return rowBox ? Math.abs(rowBox.y - beforeSentinelY) : Number.POSITIVE_INFINITY;
    }).toBeLessThanOrEqual(12);
    await expect.poll(async () => {
      const metrics = await getTimelineScrollMetrics(window);
      return Math.abs(metrics.scrollTop - beforeScrollTop);
    }).toBeLessThanOrEqual(12);
    await expect(window.getByTestId("timeline-jump")).toHaveCount(0);

    const diffPanel = window.locator(".diff-panel");
    const beforeDiffSentinelY = (await sentinelRow.boundingBox())?.y ?? 0;
    const beforeDiffScrollTop = (await getTimelineScrollMetrics(window)).scrollTop;
    await window.keyboard.press(desktopShortcut("D"));
    await expect(diffPanel).toBeVisible();
    await expect(diffPanel.locator(".diff-panel__file-name")).toContainText("README.md");
    await expect.poll(async () => {
      const rowBox = await sentinelRow.boundingBox();
      return rowBox ? Math.abs(rowBox.y - beforeDiffSentinelY) : Number.POSITIVE_INFINITY;
    }).toBeLessThanOrEqual(12);
    await expect.poll(async () => {
      const metrics = await getTimelineScrollMetrics(window);
      return Math.abs(metrics.scrollTop - beforeDiffScrollTop);
    }).toBeLessThanOrEqual(12);
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
    await expect.poll(async () => {
      const metrics = await getTimelineScrollMetrics(window);
      return {
        overflowed: metrics.scrollHeight > metrics.clientHeight + 32,
        scrolled: metrics.scrollTop > 0,
        remaining: metrics.remainingFromBottom,
      };
    }).toMatchObject({
      overflowed: true,
      scrolled: true,
      remaining: expect.any(Number),
    });
    await expect.poll(async () => (await getTimelineScrollMetrics(window)).remainingFromBottom).toBeLessThanOrEqual(16);

    const pinnedStream = await streamAssistantDeltas(harness, window, [
      "PINNED_STREAM_CHUNK_A ",
      "PINNED_STREAM_CHUNK_B ",
      "PINNED_STREAM_CHUNK_C",
    ]);
    await expect(window.getByTestId("transcript")).toContainText(pinnedStream.fullText);
    await expect.poll(async () => (await getTimelineScrollMetrics(window)).remainingFromBottom).toBeLessThanOrEqual(16);

    await scrollTimelineAwayFromBottom(window, 220);
    await expect.poll(async () => (await getTimelineScrollMetrics(window)).remainingFromBottom).toBeGreaterThan(100);
    const beforeScrollTop = (await getTimelineScrollMetrics(window)).scrollTop;

    const awayStream = await streamAssistantDeltas(harness, window, [
      "AWAY_STREAM_CHUNK_A ",
      "AWAY_STREAM_CHUNK_B ",
      "AWAY_STREAM_CHUNK_C",
    ]);
    await expect(window.getByTestId("transcript")).toContainText(awayStream.fullText);
    await expect.poll(async () => {
      const metrics = await getTimelineScrollMetrics(window);
      return Math.abs(metrics.scrollTop - beforeScrollTop);
    }).toBeLessThanOrEqual(12);
    await expect(window.getByTestId("timeline-jump")).toHaveCount(1);
  } finally {
    await harness.close();
  }
});
