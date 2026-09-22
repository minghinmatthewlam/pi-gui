import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  persistedSessionDataPaths,
} from "../helpers/electron-app";
import { appendMessagesToSessionFile, sessionFilePathFromCatalog } from "../helpers/session-file";

const proofDir = process.env.PI_APP_THREAD_MENU_PROOF_DIR;

async function captureProof(window: Page, filename: string): Promise<void> {
  if (!proofDir) return;
  await mkdir(proofDir, { recursive: true });
  await window.screenshot({ path: join(proofDir, filename) });
}

test("thread menu supports rename, archive/restore, mark read, copy id, and right click", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("thread-menu-workspace");
  const targetTitle = "Thread menu target with a deliberately long title for sidebar truncation";
  const renamedTitle = "Renamed from menu";
  const firstRun = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  let target: { workspaceId: string; sessionId: string } | undefined;
  try {
    const window = await firstRun.firstWindow();
    await createNamedThread(window, targetTitle);
    const state = await getDesktopState(window);
    target = { workspaceId: state.selectedWorkspaceId, sessionId: state.selectedSessionId };
    await createNamedThread(window, "Other active thread");
  } finally {
    await firstRun.close();
  }

  expect(target).toBeDefined();
  const uiStatePath = join(userDataDir, "ui-state.json");
  const uiState = JSON.parse(await readFile(uiStatePath, "utf8")) as {
    lastViewedAtBySession?: Record<string, string>;
  };
  const { rawSessionKey } = persistedSessionDataPaths(userDataDir, target!);
  const activityAt = Date.now() + 5 * 60_000;
  await appendMessagesToSessionFile(await sessionFilePathFromCatalog(userDataDir, target!), [
    { role: "assistant", text: "Unread menu activity", timestampMs: activityAt },
  ]);
  await writeFile(
    uiStatePath,
    `${JSON.stringify(
      {
        ...uiState,
        lastViewedAtBySession: {
          ...(uiState.lastViewedAtBySession ?? {}),
          [rawSessionKey]: new Date(activityAt - 1_000).toISOString(),
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const harness = await launchDesktop(userDataDir, { testMode: "background" });
  try {
    const window = await harness.firstWindow();
    let row = window.locator(".session-row", { hasText: targetTitle }).first();
    await expect(row).toHaveAttribute("data-sidebar-indicator", "unseen");

    await row.click({ button: "right" });
    const menu = row.getByRole("menu");
    await expect(menu.getByRole("button", { name: "Rename thread" })).toBeVisible();
    await expect(menu.getByRole("button", { name: "Archive" })).toBeVisible();
    await expect(menu.getByRole("button", { name: "Mark as read" })).toBeVisible();
    await expect(menu.getByRole("button", { name: "Copy session id" })).toBeVisible();
    await captureProof(window, "01-open-menu.png");

    await menu.getByRole("button", { name: "Copy session id" }).click();
    await expect
      .poll(() => window.evaluate(() => navigator.clipboard.readText()))
      .toBe(target!.sessionId);

    await row.click({ button: "right" });
    await row.getByRole("menu").getByRole("button", { name: "Mark as read" }).click();
    await expect(row).toHaveAttribute("data-sidebar-indicator", "none");
    await captureProof(window, "02-marked-read.png");

    row = window.locator(".session-row", { hasText: targetTitle }).first();
    await row.hover();
    await row.locator(".session-row__menu-button").click();
    await expect(window.locator(".chat-header__title")).toHaveText("Other active thread");
    await window.keyboard.press("Escape");
    await window.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await row.hover();

    const selectBox = await row.locator(".session-row__select").boundingBox();
    const trailingBox = await row.locator(".session-row__trailing").boundingBox();
    const rowBox = await row.boundingBox();
    const clusterBox = await row.locator(".session-row__action-cluster").boundingBox();
    expect(selectBox).not.toBeNull();
    expect(trailingBox).not.toBeNull();
    expect(rowBox).not.toBeNull();
    expect(clusterBox).not.toBeNull();
    expect(trailingBox!.width).toBeGreaterThanOrEqual(clusterBox!.width);
    const gapStart = selectBox!.x + selectBox!.width;
    const gapWidth = trailingBox!.x - gapStart;
    expect(gapWidth).toBeGreaterThanOrEqual(1);
    expect(gapWidth).toBeLessThanOrEqual(3);
    expect(trailingBox!.width).toBeLessThan(92);
    const gapPoint = { x: gapStart + gapWidth / 2, y: rowBox!.y + rowBox!.height / 2 };
    const hitIsAction = await window.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.closest(".session-row__action") !== null,
      gapPoint,
    );
    expect(hitIsAction).toBe(false);
    await window.mouse.click(gapPoint.x, gapPoint.y);
    await expect(window.locator(".chat-header__title")).toHaveText(targetTitle);
    await captureProof(window, "06-gap-fixed.png");

    await row.hover();
    await row.locator(".session-row__menu-button").click();
    await row.getByRole("menu").getByRole("button", { name: "Rename thread" }).click();
    const renameInput = window.getByLabel(`Rename thread ${targetTitle}`);
    await renameInput.fill(renamedTitle);
    await window.getByRole("button", { name: "Save" }).click();
    row = window.locator(".session-row", { hasText: renamedTitle }).first();
    await expect(row).toBeVisible();
    await captureProof(window, "03-renamed.png");

    await row.hover();
    await row.locator(".session-row__menu-button").click();
    await row.getByRole("menu").getByRole("button", { name: "Archive" }).click();
    await expect(
      window.locator(".session-list > .session-row", { hasText: renamedTitle }),
    ).toHaveCount(0);
    const archivedToggle = window.locator(".archived-thread-group__toggle");
    await expect(archivedToggle).toBeVisible();
    await captureProof(window, "04-archived.png");

    await archivedToggle.click();
    const archivedRow = window.locator(".session-list--archived .session-row", {
      hasText: renamedTitle,
    });
    await archivedRow.click({ button: "right" });
    await archivedRow.getByRole("menu").getByRole("button", { name: "Restore" }).click();
    await expect(
      window.locator(".session-list > .session-row", { hasText: renamedTitle }),
    ).toHaveCount(1);
  } finally {
    await harness.close();
  }
});

test("rename shortcut hint shows in menu and Cmd+Shift+R renames current thread", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("rename-shortcut-workspace");
  const targetTitle = "Rename shortcut target thread";
  const renamedTitle = "Renamed via keyboard shortcut";
  const isMac = process.platform === "darwin";
  const expectedHint = isMac ? "⇧⌘R" : "Ctrl+Shift+R";

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    // The newly created thread is the current/selected thread.
    await createNamedThread(window, targetTitle);

    const row = window.locator(".session-row", { hasText: targetTitle }).first();
    await row.hover();
    await row.locator(".session-row__menu-button").click();
    const renameItem = row.getByRole("menu").getByRole("button", { name: "Rename thread" });
    await expect(renameItem.locator(".workspace-menu__shortcut")).toHaveText(expectedHint);
    await captureProof(window, "07-rename-hint.png");
    await window.keyboard.press("Escape");

    // Fire the shortcut against the current thread; the inline rename opens.
    await window.keyboard.press(`${isMac ? "Meta" : "Control"}+Shift+R`);
    const renameInput = window.getByLabel(`Rename thread ${targetTitle}`);
    await expect(renameInput).toBeVisible();
    await captureProof(window, "08-shortcut-opened-rename.png");

    await renameInput.fill(renamedTitle);
    await window.getByRole("button", { name: "Save" }).click();
    await expect(window.locator(".session-row", { hasText: renamedTitle }).first()).toBeVisible();
  } finally {
    await harness.close();
  }
});
