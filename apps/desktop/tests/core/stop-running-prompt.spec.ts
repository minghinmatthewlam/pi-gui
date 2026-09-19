import { expect, test } from "@playwright/test";
import { resolve } from "node:path";
import type { PiSdkDriver } from "@pi-gui/pi-sdk-driver";
import type { SessionDriverEvent, SessionRef } from "@pi-gui/session-driver";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
} from "../helpers/electron-app";

test("Pin controls and Stop respond before a pending composer prompt completes", async () => {
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("stop-pending-prompt");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const page = await harness.firstWindow();
    await createNamedThread(page, "Pending prompt");
    await page.locator(".session-row", { hasText: "Pending prompt" }).hover();
    await page.getByRole("button", { name: /^Pin Pending prompt/ }).click();
    const pinnedSection = page.getByRole("region", { name: "Pinned threads" });
    await expect(pinnedSection).toBeVisible();
    const state = await getDesktopState(page);
    const target = {
      workspaceId: state.selectedWorkspaceId!,
      sessionId: state.selectedSessionId!,
    };
    // A controlled driver holds the real submit IPC open until abort. The
    // visible Send/Stop buttons still exercise the renderer, preload and main
    // queue; no provider timing or response-length assumption is involved.
    await harness.electronApp.evaluate(
      async (_, input) => {
        const { createRequire } = process.getBuiltinModule("module");
        const load = createRequire(input.entry);
        const { PiSdkDriver: Driver } = load("@pi-gui/pi-sdk-driver") as {
          PiSdkDriver: typeof PiSdkDriver;
        };
        const hooks = (
          globalThis as {
            __PI_APP_TEST_HOOKS?: { emitSessionEvent(event: SessionDriverEvent): Promise<void> };
          }
        ).__PI_APP_TEST_HOOKS;
        if (!hooks) throw new Error("Test event hook unavailable");
        let release: (() => void) | undefined;
        const emit = (ref: SessionRef, status: "running" | "idle") =>
          hooks.emitSessionEvent({
            type: "sessionUpdated",
            sessionRef: ref,
            timestamp: new Date().toISOString(),
            snapshot: {
              ref,
              workspace: { workspaceId: ref.workspaceId, path: input.workspacePath },
              title: "Pending prompt",
              status,
              updatedAt: new Date().toISOString(),
            },
          });
        Driver.prototype.sendUserMessage = async function (ref) {
          const pending = new Promise<void>((resolvePrompt) => {
            release = resolvePrompt;
          });
          await emit(ref, "running");
          await pending;
        };
        Driver.prototype.cancelCurrentRun = async function (ref) {
          if (
            ref.workspaceId !== input.target.workspaceId ||
            ref.sessionId !== input.target.sessionId
          ) {
            throw new Error("Stop targeted the wrong session");
          }
          await emit(ref, "idle");
          release?.();
        };
      },
      { entry: resolve("apps/desktop/out/main/main.js"), target, workspacePath },
    );
    await page.getByTestId("composer").fill("Keep this prompt pending until Stop");
    await page.getByTestId("send").click();
    await expect(page.getByRole("button", { name: "Stop run", exact: true })).toBeVisible();
    await pinnedSection.getByRole("button", { name: /^Unpin Pending prompt/ }).click();
    await expect(pinnedSection).toHaveCount(0);
    const row = page.locator(`.session-row[data-session-id="${target.sessionId}"]`);
    await expect(row).toHaveAttribute("data-sidebar-indicator", "running");
    await row.hover();
    await row.getByRole("button", { name: /^Pin Pending prompt/ }).click();
    await expect(pinnedSection).toBeVisible();
    await expect(row).toHaveAttribute("data-sidebar-indicator", "running");
    await page.getByRole("button", { name: "Stop run", exact: true }).click();
    await expect(page.getByTestId("send")).toHaveAttribute("aria-label", "Send message", {
      timeout: 5_000,
    });
    await expect(
      page.locator(`.session-row[data-session-id="${target.sessionId}"]`),
    ).not.toHaveAttribute("data-sidebar-indicator", "running");
  } finally {
    await harness.close();
  }
});
