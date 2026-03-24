import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "@playwright/test";
import { addWorkspace, createSession, getDesktopState, launchDesktop, makeWorkspace } from "./harness";

test("archives a hovered thread into a restorable sidebar section", async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), "pi-app-user-data-"));
  const workspacePath = await makeWorkspace("archive-sidebar-workspace");
  const harness = await launchDesktop(userDataDir);

  try {
    const window = await harness.firstWindow();

    await addWorkspace(window, workspacePath);
    await createSession(window, workspacePath, "Thread one");
    await createSession(window, workspacePath, "Thread two");
    await expect(window.locator(".topbar__session")).toHaveText("Thread two");

    const activeRow = window.locator(".session-list > .session-row").filter({ hasText: "Thread two" }).first();
    const archiveButton = activeRow.locator(".session-row__action");
    const timeLabel = activeRow.locator(".session-row__time");

    await expect(archiveButton).toHaveCSS("opacity", "0");
    await expect(timeLabel).toHaveCSS("opacity", "1");

    await activeRow.hover();
    await archiveButton.click();
    await expect(window.locator(".topbar__session")).toHaveText("Thread one");
    await expect(window.locator(".archived-thread-group")).toContainText("Archived");
    await expect(window.locator(".session-list--archived")).toContainText("Thread two");

    await expect
      .poll(async () => {
        const state = await getDesktopState(window);
        return state.workspaces[0]?.sessions.find((session) => session.title === "Thread two")?.archivedAt ?? "";
      })
      .not.toBe("");

    const archivedRow = window.locator(".session-list--archived .session-row").filter({ hasText: "Thread two" }).first();
    const restoreButton = archivedRow.locator(".session-row__action");
    await archivedRow.hover();
    await restoreButton.click();

    await expect(window.locator(".session-list > .session-row").filter({ hasText: "Thread two" })).toHaveCount(1);
    await expect(window.locator(".archived-thread-group")).toHaveCount(0);

    await expect
      .poll(async () => {
        const state = await getDesktopState(window);
        return state.workspaces[0]?.sessions.find((session) => session.title === "Thread two")?.archivedAt ?? "";
      })
      .toBe("");
  } finally {
    await harness.close();
  }
});
