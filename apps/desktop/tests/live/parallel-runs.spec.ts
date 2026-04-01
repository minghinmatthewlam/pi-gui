import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  getDesktopState,
  getSelectedTranscript,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  selectSession,
} from "../helpers/electron-app";

test("runs two sessions in parallel without sidebar status bleed", async () => {
  test.setTimeout(180_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("parallel-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Session A");
    await createNamedThread(window, "Session B");

    const promptA =
      "Use your bash tool and run `python - <<'PY'\nimport time\nprint(\"A start\")\ntime.sleep(6)\nprint(\"A done\")\nPY` then reply with exactly `A complete`.";
    const promptB =
      "Use your bash tool and run `python - <<'PY'\nimport time\nprint(\"B start\")\ntime.sleep(6)\nprint(\"B done\")\nPY` then reply with exactly `B complete`.";

    await selectSession(window, "Session A");
    await window.getByTestId("composer").fill(promptA);
    await window.getByTestId("composer").press("Enter");

    await expect
      .poll(async () => {
        const state = await getDesktopState(window);
        return state.workspaces[0]?.sessions.find((session) => session.title === "Session A")?.status ?? "";
      }, { timeout: 30_000 })
      .toBe("running");

    await selectSession(window, "Session B");
    await window.getByTestId("composer").fill(promptB);
    await window.getByTestId("composer").press("Enter");

    await expect(window.locator(".topbar__session")).toHaveText("Session B");
    await expect
      .poll(async () => {
        const state = await getDesktopState(window);
        const workspace = state.workspaces[0];
        const sessionA = workspace?.sessions.find((session) => session.title === "Session A");
        const sessionB = workspace?.sessions.find((session) => session.title === "Session B");
        return {
          sessionAStatus: sessionA?.status,
          sessionBStatus: sessionB?.status,
        };
      }, { timeout: 45_000 })
      .toEqual({
        sessionAStatus: "running",
        sessionBStatus: "running",
      });

    const sessionARow = window.locator(".session-row", { hasText: "Session A" });
    const sessionBRow = window.locator(".session-row", { hasText: "Session B" });
    await expect(sessionARow).toHaveAttribute("data-sidebar-indicator", "running");
    await expect(sessionARow.locator(".session-row__status--running")).toHaveCount(1);
    const runningAlignedTitles = await Promise.all([
      sessionARow.locator(".session-row__title").boundingBox(),
      sessionBRow.locator(".session-row__title").boundingBox(),
    ]);
    expect(runningAlignedTitles[0]).not.toBeNull();
    expect(runningAlignedTitles[1]).not.toBeNull();
    expect(Math.abs((runningAlignedTitles[0]?.x ?? 0) - (runningAlignedTitles[1]?.x ?? 0))).toBeLessThanOrEqual(1);

    await expect
      .poll(async () => {
        const state = await getDesktopState(window);
        const workspace = state.workspaces[0];
        const sessionA = workspace?.sessions.find((session) => session.title === "Session A");
        const sessionB = workspace?.sessions.find((session) => session.title === "Session B");
        return {
          sessionAStatus: sessionA?.status,
          sessionBStatus: sessionB?.status,
        };
      }, { timeout: 120_000 })
      .toEqual({
        sessionAStatus: "idle",
        sessionBStatus: "idle",
      });

    await expect(sessionARow).toHaveAttribute("data-sidebar-indicator", "unseen");
    await expect(sessionARow.locator(".session-row__status--unseen")).toHaveCount(1);
    await expect(sessionBRow).toHaveAttribute("data-sidebar-indicator", "none");

    const alignedTitles = await Promise.all([
      sessionARow.locator(".session-row__title").boundingBox(),
      sessionBRow.locator(".session-row__title").boundingBox(),
    ]);
    expect(alignedTitles[0]).not.toBeNull();
    expect(alignedTitles[1]).not.toBeNull();
    expect(Math.abs((alignedTitles[0]?.x ?? 0) - (alignedTitles[1]?.x ?? 0))).toBeLessThanOrEqual(1);

    await selectSession(window, "Session A");
    await expect(window.getByTestId("composer")).toBeFocused();
    await expect(sessionARow).toHaveAttribute("data-sidebar-indicator", "none");

    const summarize = (transcript: Awaited<ReturnType<typeof getSelectedTranscript>>) =>
      (transcript?.transcript ?? []).map((item) => {
        switch (item.kind) {
          case "message":
            return `${item.role}:${item.text}`;
          case "tool":
          case "activity":
          case "summary":
            return `${item.kind}:${item.label}`;
          default:
            return item.kind;
        }
      });

    const sessionATranscript = await getSelectedTranscript(window);
    const sessionALines = summarize(sessionATranscript);
    await selectSession(window, "Session B");
    const sessionBTranscript = await getSelectedTranscript(window);
    const sessionBLines = summarize(sessionBTranscript);
    expect(sessionALines.some((line) => line.includes("A complete"))).toBe(true);
    expect(sessionBLines.some((line) => line.includes("B complete"))).toBe(true);
    expect(sessionALines.some((line) => line.includes("B complete"))).toBe(false);
    expect(sessionBLines.some((line) => line.includes("A complete"))).toBe(false);
  } finally {
    await harness.close();
  }
});
