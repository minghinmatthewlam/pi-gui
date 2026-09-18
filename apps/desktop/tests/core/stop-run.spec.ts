import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  getDesktopState,
  getSessionRunStats,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  setAbortTimeoutMs,
  setSessionRunFixture,
} from "../helpers/electron-app";

async function selectedSessionStatus(
  window: Parameters<typeof getDesktopState>[0],
): Promise<string> {
  const state = await getDesktopState(window);
  const workspace = state.workspaces.find((entry) => entry.id === state.selectedWorkspaceId);
  const session = workspace?.sessions.find((entry) => entry.id === state.selectedSessionId);
  return session?.status ?? "";
}

test("stops an in-flight hanging follow-up without waiting for prompt()", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("stop-hanging-follow-up");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Stop hang session");
    await setSessionRunFixture(harness, { prompt: "hang" });

    const sendStarted = Date.now();
    await window.getByTestId("composer").fill("Follow-up that never completes");
    await window.getByTestId("send").click();
    await expect(window.getByTestId("send")).toHaveAttribute("aria-label", "Stop run", {
      timeout: 5_000,
    });
    expect(Date.now() - sendStarted).toBeLessThan(3_000);

    const stopStarted = Date.now();
    await window.getByRole("button", { name: "Stop run", exact: true }).click();
    await expect
      .poll(async () => (await getSessionRunStats(harness)).abortCalls, { timeout: 5_000 })
      .toBeGreaterThan(0);
    expect(Date.now() - stopStarted).toBeLessThan(5_000);

    await expect.poll(async () => selectedSessionStatus(window), { timeout: 5_000 }).toBe("idle");
    await expect(window.getByTestId("send")).toHaveAttribute("aria-label", "Send message");
    await expect(window.getByTestId("composer-error-banner")).toHaveCount(0);
  } finally {
    await harness.close();
  }
});

test("never-resolving abort returns a bounded stopping result and does not report idle", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("stop-hanging-abort");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Abort hang session");
    await setAbortTimeoutMs(harness, 80);
    await setSessionRunFixture(harness, { prompt: "hang", abort: "hang" });

    await window.getByTestId("composer").fill("Follow-up that never completes");
    await window.getByTestId("send").click();
    await expect(window.getByTestId("send")).toHaveAttribute("aria-label", "Stop run", {
      timeout: 5_000,
    });

    const stopStarted = Date.now();
    await window.getByRole("button", { name: "Stop run", exact: true }).click();
    await expect(window.getByTestId("send")).not.toHaveAttribute("aria-label", "Stop run", {
      timeout: 5_000,
    });
    expect(Date.now() - stopStarted).toBeLessThan(5_000);

    await expect.poll(async () => selectedSessionStatus(window), { timeout: 5_000 }).toBe("failed");
    expect(await selectedSessionStatus(window)).not.toBe("idle");
    await expect(window.getByTestId("composer-error-banner")).toBeVisible();
  } finally {
    await harness.close();
  }
});

test("failed follow-up send restores the draft and does not leave the thread running", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("stop-rejecting-prompt");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Prompt reject session");
    await setSessionRunFixture(harness, { prompt: "reject" });

    const followUp = "Follow-up that fails to start";
    await window.getByTestId("composer").fill(followUp);
    await window.getByTestId("send").click();

    await expect.poll(async () => selectedSessionStatus(window), { timeout: 5_000 }).toBe("failed");
    expect(await selectedSessionStatus(window)).not.toBe("idle");
    await expect(window.getByTestId("composer-error-banner")).toBeVisible();
    await expect(window.getByTestId("composer")).toHaveValue(followUp);
    await expect(window.getByTestId("send")).toHaveAttribute("aria-label", "Send message");
    await expect(window.getByTestId("transcript").getByText(followUp)).toHaveCount(0);
  } finally {
    await harness.close();
  }
});

test("rejecting abort does not report idle while the runtime may still be active", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("stop-rejecting-abort");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Abort reject session");
    await setSessionRunFixture(harness, { prompt: "hang", abort: "reject" });

    await window.getByTestId("composer").fill("Follow-up that never completes");
    await window.getByTestId("send").click();
    await expect(window.getByTestId("send")).toHaveAttribute("aria-label", "Stop run", {
      timeout: 5_000,
    });
    await window.getByRole("button", { name: "Stop run", exact: true }).click();

    await expect.poll(async () => selectedSessionStatus(window), { timeout: 5_000 }).toBe("failed");
    expect(await selectedSessionStatus(window)).not.toBe("idle");
    await expect(window.getByTestId("composer-error-banner")).toBeVisible();
    await expect(window.getByTestId("send")).not.toHaveAttribute("aria-label", "Stop run");
  } finally {
    await harness.close();
  }
});
