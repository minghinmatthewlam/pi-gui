import { expect, test } from "@playwright/test";
import { resolve } from "node:path";
import type { PiSdkDriver } from "@pi-gui/pi-sdk-driver";
import type { SessionDriverEvent, SessionRef } from "@pi-gui/session-driver";
import { desktopIpc } from "../../contracts/ipc";
import {
  clickSession,
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
} from "../helpers/electron-app";

const pendingPrompts = [
  { finish: "stop", prompt: "Keep this prompt pending until Stop" },
  { finish: "complete", prompt: "Keep this prompt pending until Stop" },
  // Text starting with "/" that is not a local or extension command is an ordinary prompt too.
  { finish: "complete", prompt: "/tmp/notes.md summarise this file" },
] as const;

for (const { finish, prompt } of pendingPrompts) {
  test(`Thread switching and pin controls stay responsive during a pending prompt (${finish}: ${prompt})`, async () => {
    const userDataDir = await makeUserDataDir();
    const workspacePath = await makeWorkspace("stop-pending-prompt");
    const harness = await launchDesktop(userDataDir, {
      initialWorkspaces: [workspacePath],
      testMode: "background",
    });
    try {
      const page = await harness.firstWindow();
      await createNamedThread(page, "Other thread");
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
      // A controlled driver holds the real submit IPC open until released. The
      // visible Send/Stop buttons still exercise the renderer, preload and main
      // queue; no provider timing or response-length assumption is involved.
      await harness.electronApp.evaluate(
        async ({ ipcMain }, input) => {
          type InvokeHandler = (...args: unknown[]) => unknown;
          const handlers = (
            ipcMain as typeof ipcMain & { readonly _invokeHandlers?: Map<string, InvokeHandler> }
          )._invokeHandlers;
          const submit = handlers?.get(input.submitChannel);
          if (!handlers || !submit) throw new Error("Missing submit handler");
          let submission: Promise<unknown> | undefined;
          handlers.set(input.submitChannel, (...args) => {
            submission = Promise.resolve(submit(...args));
            return submission;
          });
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
          const completePrompt = async () => {
            await emit(input.target, "idle");
            release?.();
            if (!submission) throw new Error("Missing pending submission");
            // Wait for the real handler's final state projection, not only idle.
            await submission;
          };
          (
            globalThis as { __completePendingTestPrompt?: () => Promise<void> }
          ).__completePendingTestPrompt = completePrompt;
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
        {
          entry: resolve("apps/desktop/out/main/main.js"),
          target,
          workspacePath,
          submitChannel: desktopIpc.submitComposer,
        },
      );
      await page.getByTestId("composer").fill(prompt);
      await page.getByTestId("send").click();
      await expect(page.getByRole("button", { name: "Stop run", exact: true })).toBeVisible();
      const steerKey = process.platform === "darwin" ? "Cmd+Enter" : "Ctrl+Enter";
      await expect(page.locator(".composer__hint")).toContainText(
        `Enter to queue · ${steerKey} to steer`,
      );
      await pinnedSection.getByRole("button", { name: /^Unpin Pending prompt/ }).click();
      await expect(pinnedSection).toHaveCount(0);
      const row = page.locator(`.session-row[data-session-id="${target.sessionId}"]`);
      await expect(row).toHaveAttribute("data-sidebar-indicator", "running");
      await row.hover();
      await row.getByRole("button", { name: /^Pin Pending prompt/ }).click();
      await expect(pinnedSection).toBeVisible();
      await expect(row).toHaveAttribute("data-sidebar-indicator", "running");
      await clickSession(page, "Other thread");
      await expect(page.locator(".chat-header__title")).toHaveText("Other thread", {
        timeout: 5_000,
      });
      await expect(row).toHaveAttribute("data-sidebar-indicator", "running");
      if (finish === "complete") {
        await harness.electronApp.evaluate(async () => {
          const complete = (globalThis as { __completePendingTestPrompt?: () => Promise<void> })
            .__completePendingTestPrompt;
          if (!complete) throw new Error("Missing controlled prompt completion");
          await complete();
        });
        await expect(row).not.toHaveAttribute("data-sidebar-indicator", "running");
        await expect(page.locator(".chat-header__title")).toHaveText("Other thread");
        return;
      }
      await clickSession(page, "Pending prompt");
      await expect(page.getByRole("button", { name: "Stop run", exact: true })).toBeVisible();
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
}
