import { expect, test } from "@playwright/test";

import type { SessionRef } from "@pi-gui/session-driver";
import { desktopIpc } from "../../contracts/ipc";
import {
  clickSession,
  createNamedThread,
  emitTestSessionEvent,
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
      // pi's send and cancel are held for the test, so the real submit IPC stays open until
      // released. The visible Send/Stop buttons still exercise the renderer, preload and main
      // queue; no provider timing or response-length assumption is involved.
      await harness.ipc.control(desktopIpc.submitComposer, { mode: "passthrough" });
      const sends = await harness.driver.intercept("sendUserMessage");
      const cancels = await harness.driver.intercept("cancelCurrentRun");
      const emit = (ref: SessionRef, status: "running" | "idle") =>
        emitTestSessionEvent(harness, {
          type: "sessionUpdated",
          sessionRef: ref,
          timestamp: new Date().toISOString(),
          snapshot: {
            ref,
            workspace: { workspaceId: ref.workspaceId, path: workspacePath },
            title: "Pending prompt",
            status,
            updatedAt: new Date().toISOString(),
          },
        });
      await page.getByTestId("composer").fill(prompt);
      await page.getByTestId("send").click();
      const send = await sends.nextCall();
      await emit(send.args[0] as SessionRef, "running");
      await expect(page.getByRole("button", { name: "Stop run", exact: true })).toBeVisible();
      await expect(page.locator(".composer__hint")).toHaveCount(0);
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
        await emit(target, "idle");
        await send.complete();
        // Wait for the real handler's final state projection, not only idle.
        await harness.ipc.settled(desktopIpc.submitComposer);
        await expect(row).not.toHaveAttribute("data-sidebar-indicator", "running");
        await expect(page.locator(".chat-header__title")).toHaveText("Other thread");
        return;
      }
      await clickSession(page, "Pending prompt");
      await expect(page.getByRole("button", { name: "Stop run", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Stop run", exact: true }).click();
      const cancel = await cancels.nextCall();
      expect(cancel.args[0], "Stop targeted the wrong session").toEqual(target);
      await emit(target, "idle");
      await cancel.complete();
      await send.complete();
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
