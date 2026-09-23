import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
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

async function menuItemTitles(menu: Locator): Promise<string[]> {
  return menu
    .locator(".workspace-menu__item > span:first-child")
    .evaluateAll((items) => items.map((item) => item.textContent ?? ""));
}

async function captureProof(window: Page, filename: string): Promise<void> {
  if (!proofDir) return;
  await mkdir(proofDir, { recursive: true });
  await window.screenshot({ path: join(proofDir, filename) });
}

test("right-click thread menu supports rename, archive/restore, mark read, and copy id", async () => {
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

    // Rows carry no "…" button; right-click is the row's menu.
    await row.hover();
    await expect(row.locator(".session-row__menu-button")).toHaveCount(0);
    await row.click({ button: "right" });
    const menu = row.getByRole("menu");
    expect(await menuItemTitles(menu)).toEqual([
      "Rename thread",
      "Pin thread",
      "Archive thread",
      "Mark as read",
      "Add scheduled task…",
      "Copy session ID",
    ]);
    await captureProof(window, "01-open-menu.png");

    await menu.getByRole("button", { name: "Copy session ID" }).click();
    await expect
      .poll(() => window.evaluate(() => navigator.clipboard.readText()))
      .toBe(target!.sessionId);

    await row.click({ button: "right" });
    await row.getByRole("menu").getByRole("button", { name: "Mark as read" }).click();
    await expect(row).toHaveAttribute("data-sidebar-indicator", "none");
    await captureProof(window, "02-marked-read.png");

    row = window.locator(".session-row", { hasText: targetTitle }).first();
    await row.click({ button: "right" });
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

    await row.click({ button: "right" });
    await row.getByRole("menu").getByRole("button", { name: "Rename thread" }).click();
    const renameInput = window.getByLabel(`Rename thread ${targetTitle}`);
    await renameInput.fill(renamedTitle);
    await window.getByRole("button", { name: "Save" }).click();
    row = window.locator(".session-row", { hasText: renamedTitle }).first();
    await expect(row).toBeVisible();
    await captureProof(window, "03-renamed.png");

    await row.click({ button: "right" });
    await row.getByRole("menu").getByRole("button", { name: "Archive thread" }).click();
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
    await archivedRow.getByRole("menu").getByRole("button", { name: "Restore thread" }).click();
    await expect(
      window.locator(".session-list > .session-row", { hasText: renamedTitle }),
    ).toHaveCount(1);
  } finally {
    await harness.close();
  }
});

test("header and right-click menus match, show shortcuts, and Shift chords rename and archive", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("thread-shortcuts-workspace");
  const keptTitle = "Thread that stays";
  const targetTitle = "Rename shortcut target thread";
  const renamedTitle = "Renamed via keyboard shortcut";
  const isMac = process.platform === "darwin";
  const modifier = isMac ? "Meta" : "Control";

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, keptTitle);
    // The newly created thread is the current/selected thread.
    await createNamedThread(window, targetTitle);

    const row = window.locator(".session-row", { hasText: targetTitle }).first();
    await row.click({ button: "right" });
    const rowMenu = row.getByRole("menu");
    const rowItems = await menuItemTitles(rowMenu);
    await expect(
      rowMenu.getByRole("button", { name: "Rename thread" }).locator(".workspace-menu__shortcut"),
    ).toHaveText(isMac ? "⇧⌘R" : "Ctrl+Shift+R");
    await expect(
      rowMenu.getByRole("button", { name: "Archive thread" }).locator(".workspace-menu__shortcut"),
    ).toHaveText(isMac ? "⇧⌘A" : "Ctrl+Shift+A");
    await captureProof(window, "07-row-menu-hints.png");
    await window.keyboard.press("Escape");
    await expect(rowMenu).toHaveCount(0);

    await window.getByTestId("thread-header-menu").click();
    const headerMenu = window.locator(".chat-header__menu");
    expect(await menuItemTitles(headerMenu)).toEqual(rowItems);
    await captureProof(window, "08-header-menu.png");
    await window.keyboard.press("Escape");
    await expect(headerMenu).toHaveCount(0);

    // Hovering the row's archive button shows the shortcut.
    await row.hover();
    await row.getByRole("button", { name: `Archive ${targetTitle}` }).hover();
    const tooltip = row.locator(".session-row__tooltip");
    await expect(tooltip).toHaveCSS("opacity", "1");
    await expect(tooltip.locator("kbd")).toHaveText(isMac ? "⇧⌘A" : "Ctrl+Shift+A");
    await captureProof(window, "09-archive-tooltip.png");

    await window.keyboard.press(`${modifier}+Shift+R`);
    const renameInput = window.getByLabel(`Rename thread ${targetTitle}`);
    await expect(renameInput).toBeVisible();
    await renameInput.fill(renamedTitle);
    await window.getByRole("button", { name: "Save" }).click();
    await expect(window.locator(".chat-header__title")).toHaveText(renamedTitle);

    await window.keyboard.press(`${modifier}+Shift+A`);
    await expect(
      window.locator(".session-list > .session-row", { hasText: renamedTitle }),
    ).toHaveCount(0);
    await expect(window.locator(".archived-thread-group__toggle")).toBeVisible();
    // Archiving moves to the next thread; one press archives only one.
    await expect(window.locator(".chat-header__title")).toHaveText(keptTitle);
    await expect(window.locator(".session-row", { hasText: keptTitle })).toHaveCount(1);
  } finally {
    await harness.close();
  }
});
