import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page, type Video } from "@playwright/test";
import type { SessionDriverEvent, SessionRef } from "@pi-gui/session-driver";
import {
  createNamedThread,
  emitTestSessionEvent,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

const WIDE_WINDOW = { width: 1500, height: 950 } as const;
const NARROW_WINDOW = { width: 800, height: 900 } as const;
const LONG_USER_TOKEN = `USER_${"unbroken_segment".repeat(28)}`;
const LONG_TOOL_NAME = `inspect_${"metadata".repeat(32)}`;
const LONG_TOOL_OUTPUT = `OUTPUT_${"unbroken_result".repeat(24)}`;
const LONG_USER_MESSAGE = `Long user row ${LONG_USER_TOKEN}`;
const TOOL_CALL_ID = "timeline-overflow-tool-call";

const COLLAPSED_CHILDREN = {
  userRow: ".timeline-item--user",
  userBubble: ".timeline-item__bubble",
  userContent: ".timeline-item--user .message__content",
  toolRow: ".timeline-tool",
  toolHeaderRow: ".timeline-tool__header-row",
  toolHeader: ".timeline-tool__header",
  toolMetadata: ".timeline-tool__meta-inline",
} as const;

const EXPANDED_CHILDREN = {
  ...COLLAPSED_CHILDREN,
  toolBody: ".timeline-tool__body",
  toolPre: ".timeline-tool__pre",
} as const;

interface TimelineOverflowMetrics {
  readonly timelineHasNoHorizontalOverflow: boolean;
  readonly paneHasNoHorizontalOverflow: boolean;
  readonly expandedBodyCount: number;
  readonly expandedBodyHasNoHorizontalOverflow: boolean | null;
  readonly childrenInsideTranscript: Readonly<Record<string, boolean>>;
}

type DesktopHarness = Awaited<ReturnType<typeof launchDesktop>>;

async function setElectronWindowSize(
  harness: DesktopHarness,
  window: Page,
  size: { readonly width: number; readonly height: number },
): Promise<void> {
  const resized = await harness.electronApp.evaluate(({ BrowserWindow }, bounds) => {
    const appWindow = BrowserWindow.getAllWindows()[0];
    if (!appWindow) {
      return false;
    }
    appWindow.setSize(bounds.width, bounds.height);
    return true;
  }, size);
  expect(resized).toBe(true);
  await expect
    .poll(() => window.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })))
    .toEqual(size);
}

async function selectedSessionRef(window: Page): Promise<SessionRef> {
  const state = await getDesktopState(window);
  if (!state.selectedWorkspaceId || !state.selectedSessionId) {
    throw new Error("Expected a selected session");
  }
  return { workspaceId: state.selectedWorkspaceId, sessionId: state.selectedSessionId };
}

async function seedLongToolCall(harness: DesktopHarness, sessionRef: SessionRef): Promise<void> {
  const timestamp = new Date().toISOString();
  const started: Extract<SessionDriverEvent, { type: "toolStarted" }> = {
    type: "toolStarted",
    sessionRef,
    timestamp,
    toolName: LONG_TOOL_NAME,
    callId: TOOL_CALL_ID,
    input: {
      command: `read /tmp/${"deeply-nested-directory/".repeat(12)}artifact.txt`,
    },
  };
  await emitTestSessionEvent(harness, started);

  const finished: Extract<SessionDriverEvent, { type: "toolFinished" }> = {
    type: "toolFinished",
    sessionRef,
    timestamp,
    callId: TOOL_CALL_ID,
    success: true,
    output: LONG_TOOL_OUTPUT,
  };
  await emitTestSessionEvent(harness, finished);
}

async function seedLongUserRow(harness: DesktopHarness, sessionRef: SessionRef): Promise<void> {
  const timestamp = new Date().toISOString();
  const event: Extract<SessionDriverEvent, { type: "queuedMessageStarted" }> = {
    type: "queuedMessageStarted",
    sessionRef,
    timestamp,
    message: {
      id: "timeline-overflow-user-row",
      mode: "followUp",
      text: LONG_USER_MESSAGE,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  };
  await emitTestSessionEvent(harness, event);
}

async function readOverflowMetrics(window: Page, expanded: boolean): Promise<TimelineOverflowMetrics> {
  const selectors = expanded ? EXPANDED_CHILDREN : COLLAPSED_CHILDREN;
  return window.evaluate(({ childSelectors, expectsExpanded }) => {
    const tolerance = 1;
    const transcript = document.querySelector<HTMLElement>('[data-testid="transcript"]');
    const pane = document.querySelector<HTMLElement>('[data-testid="timeline-pane"]');
    if (!transcript || !pane) {
      throw new Error("Expected the timeline transcript and pane");
    }

    const transcriptRect = transcript.getBoundingClientRect();
    const childrenInsideTranscript = Object.fromEntries(
      Object.entries(childSelectors).map(([name, selector]) => {
        const child = transcript.querySelector<HTMLElement>(selector);
        if (!child) {
          throw new Error(`Expected timeline child: ${selector}`);
        }
        const childRect = child.getBoundingClientRect();
        return [
          name,
          childRect.left >= transcriptRect.left - tolerance &&
            childRect.right <= transcriptRect.right + tolerance,
        ];
      }),
    );
    const body = transcript.querySelector<HTMLElement>(".timeline-tool__body");

    return {
      timelineHasNoHorizontalOverflow: transcript.scrollWidth <= transcript.clientWidth + tolerance,
      paneHasNoHorizontalOverflow: pane.scrollWidth <= pane.clientWidth + tolerance,
      expandedBodyCount: body ? 1 : 0,
      expandedBodyHasNoHorizontalOverflow:
        expectsExpanded && body ? body.scrollWidth <= body.clientWidth + tolerance : null,
      childrenInsideTranscript,
    };
  }, { childSelectors: selectors, expectsExpanded: expanded });
}

async function expectNoHorizontalOverflow(window: Page, expanded: boolean): Promise<void> {
  const childNames = Object.keys(expanded ? EXPANDED_CHILDREN : COLLAPSED_CHILDREN);
  await expect
    .poll(() => readOverflowMetrics(window, expanded))
    .toEqual({
      timelineHasNoHorizontalOverflow: true,
      paneHasNoHorizontalOverflow: true,
      expandedBodyCount: expanded ? 1 : 0,
      expandedBodyHasNoHorizontalOverflow: expanded ? true : null,
      childrenInsideTranscript: Object.fromEntries(childNames.map((name) => [name, true])),
    });
}

async function saveProofScreenshot(window: Page, proofDir: string | undefined, name: string): Promise<void> {
  if (!proofDir) {
    return;
  }
  await window.screenshot({ path: join(proofDir, name), fullPage: false });
}

async function saveProofVideo(video: Video | null, proofDir: string | undefined): Promise<void> {
  if (!proofDir || !video) {
    return;
  }
  await video.saveAs(join(proofDir, "timeline-overflow-wide-narrow-flow.webm"));
}

test("keeps long tool metadata and user rows inside the transcript at wide and narrow widths", async () => {
  test.setTimeout(90_000);
  const proofDir = process.env.PI_APP_TIMELINE_OVERFLOW_PROOF_DIR?.trim();
  if (proofDir) {
    await mkdir(proofDir, { recursive: true });
  }

  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("timeline-overflow-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
    ...(proofDir
      ? {
          recordVideoDir: proofDir,
          recordVideoSize: WIDE_WINDOW,
        }
      : {}),
  });
  let video: Video | null = null;

  try {
    const window = await harness.firstWindow();
    video = window.video();
    await setElectronWindowSize(harness, window, WIDE_WINDOW);
    await waitForWorkspaceByPath(window, workspacePath);
    await createNamedThread(window, "Timeline overflow proof");

    const sessionRef = await selectedSessionRef(window);
    await seedLongUserRow(harness, sessionRef);
    const userRow = window.locator(".timeline-item--user", { hasText: "Long user row" });
    await expect(userRow).toBeVisible({ timeout: 15_000 });
    await seedLongToolCall(harness, sessionRef);

    const toolHeader = window.locator(".timeline-tool__header", { hasText: LONG_TOOL_NAME });
    await expect(toolHeader).toBeVisible();
    await expect(toolHeader).toHaveAttribute("aria-expanded", "false");

    await expectNoHorizontalOverflow(window, false);
    await saveProofScreenshot(window, proofDir, "wide-collapsed.png");

    await toolHeader.click();
    await expect(toolHeader).toHaveAttribute("aria-expanded", "true");
    await expectNoHorizontalOverflow(window, true);
    await saveProofScreenshot(window, proofDir, "wide-expanded.png");

    await setElectronWindowSize(harness, window, NARROW_WINDOW);
    await expectNoHorizontalOverflow(window, true);
    await saveProofScreenshot(window, proofDir, "narrow-expanded.png");

    await toolHeader.click();
    await expect(toolHeader).toHaveAttribute("aria-expanded", "false");
    await expectNoHorizontalOverflow(window, false);
    await saveProofScreenshot(window, proofDir, "narrow-collapsed.png");
  } finally {
    await harness.close();
    await saveProofVideo(video, proofDir);
  }
});
