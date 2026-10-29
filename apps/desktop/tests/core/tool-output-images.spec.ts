import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test, type Page } from "@playwright/test";
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

// A 4x4 orange PNG, as pi's read tool or a code mode image() call would return it.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGP478AARwzEcQAWohPx03ZM6QAAAABJRU5ErkJggg==";
const CALL_ID = "tool-output-image-call";

async function selectedSessionRef(window: Page): Promise<SessionRef> {
  const state = await getDesktopState(window);
  if (!state.selectedWorkspaceId || !state.selectedSessionId) {
    throw new Error("Expected a selected session");
  }
  return { workspaceId: state.selectedWorkspaceId, sessionId: state.selectedSessionId };
}

test("shows images a tool returned in its row, not their base64 text", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("tool-output-images-workspace");
  // A tool may set its own image src; the window must never load it.
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.writeHead(200, { "content-type": "image/png" });
    response.end(Buffer.from(PNG_BASE64, "base64"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const remoteSrc = `http://127.0.0.1:${(server.address() as AddressInfo).port}/pixel.png`;
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await createNamedThread(window, "Tool output images");
    const sessionRef = await selectedSessionRef(window);
    const timestamp = new Date().toISOString();
    const started: Extract<SessionDriverEvent, { type: "toolStarted" }> = {
      type: "toolStarted",
      sessionRef,
      timestamp,
      toolName: "read",
      callId: CALL_ID,
      input: { path: "screenshot.png" },
    };
    await emitTestSessionEvent(harness, started);
    const finished: Extract<SessionDriverEvent, { type: "toolFinished" }> = {
      type: "toolFinished",
      sessionRef,
      timestamp,
      callId: CALL_ID,
      success: true,
      output: {
        content: [
          { type: "text", text: "Read image file [image/png]" },
          { type: "image", data: PNG_BASE64, mimeType: "image/png" },
          { type: "image", mimeType: "image/png", src: remoteSrc },
          { type: "image", mimeType: "image/png", src: `file://${workspacePath}/pixel.png` },
        ],
      },
    };
    await emitTestSessionEvent(harness, finished);

    const tool = window.locator(".timeline-tool", {
      has: window.locator("[data-testid=timeline-tool-images]"),
    });
    const thumb = tool.getByRole("button", { name: "View read image 1" });
    await expect(thumb).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(() =>
        thumb
          .locator("img")
          .evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth),
      )
      .toBe(4);
    await expect(tool.locator("[data-testid=timeline-tool-images] img")).toHaveCount(1);
    expect(requests).toEqual([]);

    await tool.locator(".timeline-tool__header").click();
    const body = tool.locator(".timeline-tool__pre");
    await expect(body).toContainText("[image/png image]");
    await expect(body).not.toContainText(PNG_BASE64.slice(0, 24));

    await thumb.click();
    await expect(window.locator(".image-viewer")).toBeVisible();
    expect(requests).toEqual([]);
  } finally {
    await harness.close();
    server.close();
  }
});
