import { expect, test } from "@playwright/test";
import {
  clickSession,
  createNamedThread,
  getDesktopState,
  getRealAuthConfig,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
} from "../helpers/electron-app";
import { selectSessionByTitle } from "../helpers/session-event-test-helpers";

test("switches threads promptly while sessions are already running", async () => {
  test.setTimeout(180_000);
  const realAuth = getRealAuthConfig();
  test.skip(!realAuth.enabled, realAuth.skipReason);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("parallel-switch-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
    realAuthSourceDir: realAuth.sourceDir,
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Session A");
    await createNamedThread(window, "Session B");

    const promptA =
      'Use your bash tool and run `python - <<\'PY\'\nimport time\nprint("A start")\ntime.sleep(12)\nprint("A done")\nPY` then reply with exactly `A complete`.';
    const promptB =
      'Use your bash tool and run `python - <<\'PY\'\nimport time\nprint("B start")\ntime.sleep(12)\nprint("B done")\nPY` then reply with exactly `B complete`.';

    await selectSessionByTitle(window, "Session A");
    await window.getByTestId("composer").fill(promptA);
    await window.getByTestId("composer").press("Enter");
    await expect
      .poll(
        async () => {
          const state = await getDesktopState(window);
          return (
            state.workspaces[0]?.sessions.find((session) => session.title === "Session A")
              ?.status ?? ""
          );
        },
        { timeout: 30_000 },
      )
      .toBe("running");

    await selectSessionByTitle(window, "Session B");
    await window.getByTestId("composer").fill(promptB);
    await window.getByTestId("composer").press("Enter");
    await expect
      .poll(
        async () => {
          const state = await getDesktopState(window);
          const workspace = state.workspaces[0];
          const sessionA = workspace?.sessions.find((session) => session.title === "Session A");
          const sessionB = workspace?.sessions.find((session) => session.title === "Session B");
          return {
            sessionAStatus: sessionA?.status,
            sessionBStatus: sessionB?.status,
          };
        },
        { timeout: 45_000 },
      )
      .toEqual({
        sessionAStatus: "running",
        sessionBStatus: "running",
      });

    const sessionARow = window.locator(".session-row", { hasText: "Session A" });
    const sessionBRow = window.locator(".session-row", { hasText: "Session B" });

    await clickSession(window, "Session A");
    await expect(window.locator(".topbar__session")).toHaveText("Session A", { timeout: 1_000 });
    await expect(window.locator(".session-row--active")).toContainText("Session A", {
      timeout: 1_000,
    });
    await expect(sessionARow).toHaveAttribute("data-sidebar-indicator", "running", {
      timeout: 1_000,
    });
    await expect
      .poll(
        async () => {
          const state = await getDesktopState(window);
          return (
            state.workspaces[0]?.sessions.find((session) => session.title === "Session B")
              ?.status ?? ""
          );
        },
        { timeout: 1_000 },
      )
      .toBe("running");

    await clickSession(window, "Session B");
    await expect(window.locator(".topbar__session")).toHaveText("Session B", { timeout: 1_000 });
    await expect(window.locator(".session-row--active")).toContainText("Session B", {
      timeout: 1_000,
    });
    await expect(sessionBRow).toHaveAttribute("data-sidebar-indicator", "running", {
      timeout: 1_000,
    });
    await expect
      .poll(
        async () => {
          const state = await getDesktopState(window);
          return (
            state.workspaces[0]?.sessions.find((session) => session.title === "Session A")
              ?.status ?? ""
          );
        },
        { timeout: 1_000 },
      )
      .toBe("running");
    // Running state is local bookkeeping; require actual provider and tool output too.
    for (const [title, marker] of [
      ["Session A", "A complete"],
      ["Session B", "B complete"],
    ] as const) {
      await clickSession(window, title);
      await expect(
        window.locator(".timeline-item--assistant .message__content").last(),
      ).toContainText(marker, { timeout: 120_000 });
      await expect.poll(() => window.locator(".timeline-tool").count()).toBeGreaterThan(0);
    }
  } finally {
    await harness.close();
  }
});
