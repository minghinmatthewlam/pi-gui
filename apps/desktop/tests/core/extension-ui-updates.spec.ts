import { expect, test } from "@playwright/test";
import type { SessionDriverEvent } from "@pi-gui/session-driver";
import {
  createSessionViaIpc,
  emitTestSessionEvents,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
} from "../helpers/electron-app";

const UPDATES = 60;

test("extension title and status changes arrive without full state pushes", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("extension-ui-updates");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    const initial = await getDesktopState(window);
    const workspaceId = initial.selectedWorkspaceId ?? initial.workspaces[0]?.id;
    if (!workspaceId) {
      throw new Error("No workspace available");
    }
    await createSessionViaIpc(window, workspaceId, "Extension UI session");
    const state = await getDesktopState(window);
    const sessionRef = {
      workspaceId: state.selectedWorkspaceId!,
      sessionId: state.selectedSessionId!,
    };

    await window.evaluate(() => {
      const api = globalThis.window.piApp!;
      const counts = { state: 0, extensionUi: 0 };
      api.onStateChanged(() => {
        counts.state += 1;
      });
      api.onExtensionUiChanged(() => {
        counts.extensionUi += 1;
      });
      (globalThis as unknown as { __uiCounts: typeof counts }).__uiCounts = counts;
    });

    // What a title spinner or a ticking status sends while a thread runs.
    const events: SessionDriverEvent[] = [];
    for (let index = 0; index < UPDATES; index += 1) {
      const timestamp = new Date(Date.now() + index).toISOString();
      events.push({
        type: "hostUiRequest",
        sessionRef,
        timestamp,
        request: { kind: "title", title: `Spinner ${index}` },
      });
      events.push({
        type: "hostUiRequest",
        sessionRef,
        timestamp,
        request: { kind: "status", key: "ticker", text: `Tick ${index}` },
      });
    }
    await emitTestSessionEvents(harness, events);

    const last = UPDATES - 1;
    await expect(window.getByTestId("extension-dock-summary")).toContainText(`Tick ${last}`);
    await expect(window.locator(".topbar")).toContainText(`Spinner ${last}`);

    const counts = await window.evaluate(
      () =>
        (globalThis as unknown as { __uiCounts: { state: number; extensionUi: number } })
          .__uiCounts,
    );
    expect(counts.extensionUi).toBe(UPDATES * 2);
    expect(counts.state).toBe(0);

    // A full state read afterwards includes the same UI, so nothing is lost on a later full push.
    const after = await getDesktopState(window);
    const ui =
      after.sessionExtensionUiBySession[`${sessionRef.workspaceId}:${sessionRef.sessionId}`];
    expect(ui?.title).toBe(`Spinner ${last}`);
    expect(ui?.statuses).toEqual([{ key: "ticker", text: `Tick ${last}` }]);
  } finally {
    await harness.close();
  }
});
