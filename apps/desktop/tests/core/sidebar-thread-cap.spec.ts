import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { DesktopAppState, SessionRecord } from "../../contracts/desktop-state";
import {
  createSessionViaIpc,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

const proofDir =
  process.env.PI_APP_THREAD_CAP_PROOF_DIR ?? join(tmpdir(), "pi-gui-workspace-thread-cap");

test("caps a workspace history list at five threads with Show more and Show less", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir("pi-app-user-data-thread-cap-");
  const workspacePath = await makeWorkspace("thread-cap-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    const workspace = await waitForWorkspaceByPath(window, workspacePath);
    const titles = ["Thread 1", "Thread 2", "Thread 3", "Thread 4", "Thread 5", "Thread 6"];
    await createHistoryThreads(window, workspace.id, titles.slice(0, 5));

    const group = workspaceGroup(window, basename(workspacePath));
    await expectHistoryTitles(
      group,
      orderedHistoryTitles(await getDesktopState(window), workspace.id),
    );
    await expect(group.getByRole("button", { name: "Show more", exact: true })).toHaveCount(0);
    await expect(group.getByRole("button", { name: "Show less", exact: true })).toHaveCount(0);

    await createHistoryThreads(window, workspace.id, titles.slice(5));
    const ordered = orderedHistoryTitles(await getDesktopState(window), workspace.id);
    expect(ordered).toHaveLength(6);
    await expectHistoryTitles(group, ordered.slice(0, 5));

    const showMore = group.getByRole("button", { name: "Show more", exact: true });
    await expect(showMore).toBeVisible();
    await expect(showMore).toHaveAttribute("aria-expanded", "false");
    await captureSidebarProof(window, "collapsed-show-more.png");

    await showMore.press("Enter");
    await expectHistoryTitles(group, ordered);
    const showLess = group.getByRole("button", { name: "Show less", exact: true });
    await expect(showLess).toBeVisible();
    await expect(showLess).toHaveAttribute("aria-expanded", "true");
    await captureSidebarProof(window, "expanded-show-less.png");

    await showLess.click();
    await expectHistoryTitles(group, ordered.slice(0, 5));
    await expect(group.getByRole("button", { name: "Show more", exact: true })).toBeVisible();
  } finally {
    await harness.close();
  }
});

test("caps thread lists per workspace instead of across the sidebar", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir("pi-app-user-data-thread-cap-multi-");
  const workspaceAPath = await makeWorkspace("thread-cap-a");
  const workspaceBPath = await makeWorkspace("thread-cap-b");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspaceAPath, workspaceBPath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    const workspaceA = await waitForWorkspaceByPath(window, workspaceAPath);
    const workspaceB = await waitForWorkspaceByPath(window, workspaceBPath);
    await createHistoryThreads(window, workspaceA.id, numberedThreadTitles("A", 6));
    await createHistoryThreads(window, workspaceB.id, numberedThreadTitles("B", 6));

    const groupA = workspaceGroup(window, basename(workspaceAPath));
    const groupB = workspaceGroup(window, basename(workspaceBPath));
    const orderedA = orderedHistoryTitles(await getDesktopState(window), workspaceA.id);
    const orderedB = orderedHistoryTitles(await getDesktopState(window), workspaceB.id);
    expect(orderedA).toHaveLength(6);
    expect(orderedB).toHaveLength(6);

    await expectHistoryTitles(groupA, orderedA.slice(0, 5));
    await expectHistoryTitles(groupB, orderedB.slice(0, 5));
    await expect(groupA.getByRole("button", { name: "Show more", exact: true })).toBeVisible();
    await expect(groupB.getByRole("button", { name: "Show more", exact: true })).toBeVisible();

    await groupA.getByRole("button", { name: "Show more", exact: true }).click();
    await expectHistoryTitles(groupA, orderedA);
    await expect(groupA.getByRole("button", { name: "Show less", exact: true })).toBeVisible();
    await expectHistoryTitles(groupB, orderedB.slice(0, 5));
    await expect(groupB.getByRole("button", { name: "Show more", exact: true })).toBeVisible();

    await groupB.getByRole("button", { name: "Show more", exact: true }).click();
    await expectHistoryTitles(groupA, orderedA);
    await expectHistoryTitles(groupB, orderedB);
    await expect(groupA.getByRole("button", { name: "Show less", exact: true })).toBeVisible();
    await expect(groupB.getByRole("button", { name: "Show less", exact: true })).toBeVisible();
  } finally {
    await harness.close();
  }
});

function workspaceGroup(window: Page, workspaceName: string): Locator {
  return window.locator(".workspace-group").filter({
    has: window.locator(".workspace-row__name", { hasText: workspaceName }),
  });
}

function historyRows(group: Locator): Locator {
  return group.locator(".session-list--history > .session-row");
}

async function expectHistoryTitles(group: Locator, titles: readonly string[]): Promise<void> {
  await expect(historyRows(group)).toHaveCount(titles.length);
  await expect(group.locator(".session-list--history .session-row__title")).toHaveText([...titles]);
}

function numberedThreadTitles(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix} thread ${index + 1}`);
}

function orderedHistoryTitles(state: DesktopAppState, workspaceId: string): string[] {
  const workspace = state.workspaces.find((entry) => entry.id === workspaceId);
  const sessions = workspace?.sessions ?? [];
  return [...sessions]
    .filter((session) => !session.archivedAt && !session.pinnedAt)
    .sort(compareHistorySessions)
    .map((session) => session.title);
}

function compareHistorySessions(left: SessionRecord, right: SessionRecord): number {
  if (left.updatedAt !== right.updatedAt) {
    return right.updatedAt.localeCompare(left.updatedAt);
  }
  return left.title.localeCompare(right.title);
}

async function createHistoryThreads(
  window: Page,
  workspaceId: string,
  titles: readonly string[],
): Promise<void> {
  for (const [index, title] of titles.entries()) {
    if (index > 0) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await createSessionViaIpc(window, workspaceId, title);
  }
  await expect
    .poll(async () => {
      const state = await getDesktopState(window);
      const workspace = state.workspaces.find((entry) => entry.id === workspaceId);
      const created = new Set(titles);
      return workspace?.sessions.filter((session) => created.has(session.title)).length ?? 0;
    })
    .toBe(titles.length);
}

async function captureSidebarProof(window: Page, filename: string): Promise<void> {
  await mkdir(proofDir, { recursive: true });
  await window.locator(".sidebar").screenshot({ path: join(proofDir, filename) });
}
