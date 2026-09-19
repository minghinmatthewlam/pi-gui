import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  waitForSelectedSessionReady,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";
import { appendMessagesToSessionFile, sessionFilePathFromCatalog } from "../helpers/session-file";

const TURN_COUNT = 6;
const READING_MEASURE_PX = 768;
const CLASSIC_SCROLLBAR_WIDTH_PX = 15;
const RAIL_SURFACE_WIDTH_PX = 927;

async function forceTimelineScrollbarWidth(window: Page, width: number): Promise<void> {
  await window.evaluate((scrollbarWidth) => {
    const attribute = "data-context-rail-scrollbar-proof";
    const style =
      document.querySelector<HTMLStyleElement>(`style[${attribute}]`) ??
      document.createElement("style");
    style.setAttribute(attribute, "");
    style.textContent = `.timeline-pane--thread::-webkit-scrollbar { width: ${scrollbarWidth}px; }`;
    if (!style.isConnected) {
      document.head.append(style);
    }
  }, width);
  await expect
    .poll(() =>
      window.getByTestId("timeline-pane").evaluate((el) => {
        const pane = el as HTMLElement;
        return pane.offsetWidth - pane.clientWidth;
      }),
    )
    .toBe(width);
}

test("context rail lists prompts and scrolls to a turn; timing markers render", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const proofDir = process.env.PI_APP_CONTEXT_RAIL_PROOF_DIR?.trim();
  if (proofDir) {
    await mkdir(proofDir, { recursive: true });
  }
  const workspacePath = await makeWorkspace("context-rail-workspace");

  const firstRun = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  let workspaceId = "";
  let sessionId = "";
  try {
    const window = await firstRun.firstWindow();
    await createNamedThread(window, "Context rail session");
    const state = await getDesktopState(window);
    workspaceId = state.selectedWorkspaceId;
    sessionId = state.selectedSessionId;
    await waitForSelectedSessionReady(window, { workspaceId, sessionId });
  } finally {
    await firstRun.close();
  }

  const sessionFilePath = await sessionFilePathFromCatalog(userDataDir, { workspaceId, sessionId });
  const base = Date.now();
  const messages = [];
  for (let turn = 0; turn < TURN_COUNT; turn += 1) {
    const turnStart = base + turn * 60_000;
    messages.push({
      role: "user" as const,
      text: `PROMPT ${turn} unique-marker-${turn}`,
      timestampMs: turnStart,
    });
    messages.push({
      role: "assistant" as const,
      text: `Answer for turn ${turn}. ${"padding ".repeat(120)}`,
      timestampMs: turnStart + 8_000,
    });
  }
  await appendMessagesToSessionFile(sessionFilePath, messages);

  const run = await launchDesktop(userDataDir, { testMode: "background" });
  try {
    const window = await run.firstWindow();
    await run.electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setBounds({ x: 40, y: 40, width: 1500, height: 950 });
    });
    await waitForWorkspaceByPath(window, workspacePath);
    await waitForSelectedSessionReady(window, { workspaceId, sessionId });
    await expect(window.getByTestId("transcript")).toBeVisible({ timeout: 15_000 });

    // Timing markers derived from the 8s prompt->answer spans.
    await expect(window.getByTestId("timeline-turn-marker").first()).toContainText(
      "Worked for 8s",
      {
        timeout: 10_000,
      },
    );

    const rail = window.getByTestId("timeline-context-rail");
    await expect(rail).toBeVisible();
    const items = window.getByTestId("timeline-context-rail-item");
    await expect(items).toHaveCount(TURN_COUNT);

    const pane = window.getByTestId("timeline-pane");
    // Start pinned at the bottom, then jump to the first prompt via the rail.
    await pane.evaluate((el) => {
      (el as HTMLElement).scrollTop = (el as HTMLElement).scrollHeight;
    });
    const bottomScrollTop = await pane.evaluate((el) => (el as HTMLElement).scrollTop);
    expect(bottomScrollTop).toBeGreaterThan(50);

    await items.first().click();
    await expect
      .poll(async () => pane.evaluate((el) => (el as HTMLElement).scrollTop), { timeout: 5_000 })
      .toBeLessThan(bottomScrollTop / 2);

    const firstPromptRow = window.locator("[data-message-id]", {
      hasText: "PROMPT 0 unique-marker-0",
    });
    await expect(firstPromptRow).toBeInViewport();

    // The rail sits in the outer margin: the transcript keeps its full reading
    // measure with both overlay-style and space-consuming classic scrollbars.
    await forceTimelineScrollbarWidth(window, 0);
    await expect(window.getByTestId("transcript")).toHaveJSProperty(
      "clientWidth",
      READING_MEASURE_PX,
    );
    if (proofDir) {
      await window.screenshot({
        path: join(proofDir, "context-rail-overlay-scrollbar.png"),
        fullPage: false,
      });
    }

    await forceTimelineScrollbarWidth(window, CLASSIC_SCROLLBAR_WIDTH_PX);
    await expect(window.getByTestId("transcript")).toHaveJSProperty(
      "clientWidth",
      READING_MEASURE_PX,
    );
    if (proofDir) {
      await window.screenshot({
        path: join(proofDir, "context-rail-classic-scrollbar.png"),
        fullPage: false,
      });
    }

    const surface = window.locator(".timeline-surface");
    await expect(surface).toHaveJSProperty("clientWidth", RAIL_SURFACE_WIDTH_PX);
    const conversation = window.locator(".conversation--thread");
    await conversation.evaluate((el, width) => {
      (el as HTMLElement).style.width = `${width}px`;
    }, RAIL_SURFACE_WIDTH_PX - 1);
    await expect(surface).toHaveJSProperty("clientWidth", RAIL_SURFACE_WIDTH_PX - 1);
    await expect(rail).toBeHidden();
    await expect(window.getByTestId("transcript")).toHaveJSProperty(
      "clientWidth",
      READING_MEASURE_PX,
    );
    await conversation.evaluate((el) => {
      (el as HTMLElement).style.removeProperty("width");
    });
    await expect(rail).toBeVisible();

    // The topbar toggle hides the rail even on this wide viewport, while the
    // transcript keeps its 768px measure.
    await window.getByRole("button", { name: "Hide prompt navigation" }).click();
    await expect(rail).toBeHidden();
    const measureAfterHide = await window
      .getByTestId("transcript")
      .evaluate((el) => (el as HTMLElement).clientWidth);
    expect(measureAfterHide).toBe(READING_MEASURE_PX);
  } finally {
    await run.close();
  }

  // The hidden preference persists across a restart.
  const rerun = await launchDesktop(userDataDir, { testMode: "background" });
  try {
    const window = await rerun.firstWindow();
    await rerun.electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setBounds({ x: 40, y: 40, width: 1500, height: 950 });
    });
    await waitForWorkspaceByPath(window, workspacePath);
    await waitForSelectedSessionReady(window, { workspaceId, sessionId });
    await expect(window.getByTestId("transcript")).toBeVisible({ timeout: 15_000 });
    await expect(window.getByTestId("timeline-context-rail")).toBeHidden();

    // Toggling back on restores it.
    await window.getByRole("button", { name: "Show prompt navigation" }).click();
    await expect(window.getByTestId("timeline-context-rail")).toBeVisible();
  } finally {
    await rerun.close();
  }
});
