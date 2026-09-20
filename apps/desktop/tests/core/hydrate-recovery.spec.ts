import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { desktopIpc } from "../../contracts/ipc";
import {
  HYDRATE_TEST_SENTINEL,
  createNamedThread,
  installIpcInvokeControl,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  readIpcInvokeControl,
  reloadDesktopRenderer,
  setIpcInvokeControl,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

async function seedHydrateFixture() {
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("hydrate-recovery-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  const window = await harness.firstWindow();
  await waitForWorkspaceByPath(window, workspacePath);
  await createNamedThread(window, "Hydrate recovery");
  const composer = window.getByTestId("composer");
  await composer.fill("draft survives hydrate failure");
  const uiStatePath = join(userDataDir, "ui-state.json");
  await expect
    .poll(async () => {
      try {
        return await readFile(uiStatePath, "utf8");
      } catch {
        return "";
      }
    })
    .toContain("draft survives hydrate failure");
  const persistedUiState = await readFile(uiStatePath);
  return { harness, window, uiStatePath, persistedUiState };
}

test("recovers from a rejected first state hydrate without rewriting persisted UI state", async () => {
  test.setTimeout(90_000);
  const { harness, window, uiStatePath, persistedUiState } = await seedHydrateFixture();

  try {
    await installIpcInvokeControl(harness, desktopIpc.stateRequest, { mode: "reject" });
    await reloadDesktopRenderer(window);

    const card = window.getByTestId("shell-status-card");
    await expect(card).toHaveAttribute("data-status", "failed");
    await expect(window.getByRole("heading", { name: "Couldn't restore sessions" })).toBeVisible();
    await expect(window.locator(".sidebar")).toHaveCount(0);
    await expect(window.locator("body")).not.toContainText(HYDRATE_TEST_SENTINEL);
    expect(await readFile(uiStatePath)).toEqual(persistedUiState);

    await installIpcInvokeControl(harness, desktopIpc.relaunchApplication, { mode: "record" });
    const stateBeforeRelaunch = await readIpcInvokeControl(harness, desktopIpc.stateRequest);
    await window.getByTestId("hydrate-relaunch").click();
    await expect
      .poll(
        async () =>
          (await readIpcInvokeControl(harness, desktopIpc.relaunchApplication)).invokeCount,
      )
      .toBe(1);
    expect((await readIpcInvokeControl(harness, desktopIpc.stateRequest)).invokeCount).toBe(
      stateBeforeRelaunch.invokeCount,
    );
    await expect(card).toHaveAttribute("data-status", "failed");

    await window.getByTestId("hydrate-retry").click();
    await expect(card).toHaveAttribute("data-status", "failed");
    await expect
      .poll(async () => (await readIpcInvokeControl(harness, desktopIpc.stateRequest)).rejectCount)
      .toBeGreaterThan(1);

    await setIpcInvokeControl(harness, desktopIpc.stateRequest, { mode: "passthrough" });
    await window.getByTestId("hydrate-retry").click();
    await expect(window.getByTestId("composer")).toHaveValue("draft survives hydrate failure");
    await expect(
      window.locator(".session-row__select", { hasText: "Hydrate recovery" }),
    ).toBeVisible();
    await expect(card).toHaveCount(0);
    expect(await readFile(uiStatePath)).toEqual(persistedUiState);
  } finally {
    await harness.close();
  }
});

test("keeps the shell usable when only the selected transcript hydrate rejects", async () => {
  test.setTimeout(90_000);
  const { harness, window, uiStatePath, persistedUiState } = await seedHydrateFixture();

  try {
    await installIpcInvokeControl(harness, desktopIpc.selectedTranscriptRequest, {
      mode: "reject",
    });
    await reloadDesktopRenderer(window);

    await expect(window.getByTestId("workspace-list")).toBeVisible();
    await expect(window.getByTestId("shell-status-card")).toHaveCount(0);
    const transcriptError = window.getByTestId("transcript-hydrate-error");
    await expect(transcriptError).toBeVisible();
    await expect(transcriptError).toContainText("Couldn't load this thread");
    await expect(window.locator("body")).not.toContainText(HYDRATE_TEST_SENTINEL);
    expect(await readFile(uiStatePath)).toEqual(persistedUiState);

    await window.getByTestId("hydrate-retry").click();
    await expect(transcriptError).toBeVisible();

    await setIpcInvokeControl(harness, desktopIpc.selectedTranscriptRequest, {
      mode: "passthrough",
    });
    await window.getByTestId("hydrate-retry").click();
    await expect(transcriptError).toHaveCount(0);
    await expect(window.getByTestId("transcript")).toBeVisible();
    await expect(window.getByTestId("composer")).toHaveValue("draft survives hydrate failure");
    expect(await readFile(uiStatePath)).toEqual(persistedUiState);
  } finally {
    await harness.close();
  }
});

test("uncaught renderer errors show a recoverable fallback instead of a blank window", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("hydrate-boundary-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await expect(window.getByTestId("workspace-list")).toBeVisible();

    await installIpcInvokeControl(harness, desktopIpc.stateRequest, {
      mode: "replace",
      replacement: { revision: 1, lastError: HYDRATE_TEST_SENTINEL },
    });
    await reloadDesktopRenderer(window);

    const card = window.getByTestId("shell-status-card");
    await expect(card).toHaveAttribute("data-status", "crashed");
    await expect(window.getByRole("heading", { name: "Something went wrong" })).toBeVisible();
    await expect(window.locator("body")).not.toContainText(HYDRATE_TEST_SENTINEL);
    await expect(window.locator("body")).not.toContainText("secret-token");

    await setIpcInvokeControl(harness, desktopIpc.stateRequest, { mode: "passthrough" });
    await window.getByTestId("hydrate-retry").click();
    await expect(window.getByTestId("workspace-list")).toBeVisible();
    await expect(card).toHaveCount(0);
  } finally {
    await harness.close();
  }
});
