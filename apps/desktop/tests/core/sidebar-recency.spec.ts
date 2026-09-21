import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { DesktopAppState, SessionRecord } from "../../contracts/desktop-state";
import {
  chooseThreadGrouping,
  createSessionViaIpc,
  desktopShortcut,
  getDesktopState,
  getSelectedTranscript,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

const proofDir =
  process.env.PI_APP_RECENCY_PROOF_DIR ?? join(tmpdir(), "pi-gui-recency-thread-list");

test("caps each time bucket at five and hides workspace headers", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir("pi-app-user-data-recency-cap-");
  const workspaceAPath = await makeWorkspace("recency-a");
  const workspaceBPath = await makeWorkspace("recency-b");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspaceAPath, workspaceBPath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    const workspaceA = await waitForWorkspaceByPath(window, workspaceAPath);
    const workspaceB = await waitForWorkspaceByPath(window, workspaceBPath);
    await createHistoryThreads(window, workspaceA.id, numberedThreadTitles("A", 6));
    await createHistoryThreads(window, workspaceB.id, numberedThreadTitles("B", 2));

    await expect(window.getByRole("button", { name: "Group threads" })).toHaveText("Time");
    const today = recencySection(window, "Today");
    await expect(today).toBeVisible();
    await expect(today.locator(".session-row")).toHaveCount(5);
    await expect(window.locator(".workspace-row")).toHaveCount(0);
    await today.getByRole("button", { name: "Show more Today" }).click();
    await expect(today.locator(".session-row")).toHaveCount(8);
    await today.getByRole("button", { name: "Show less Today" }).click();
    await expect(today.locator(".session-row")).toHaveCount(5);
    await expect(today.locator(".session-row__context")).toContainText([basename(workspaceAPath)]);
    await expect(today.locator(".session-row__context")).toContainText([basename(workspaceBPath)]);
    await captureSidebarProof(window, "mixed-folders-today.png");
  } finally {
    await harness.close();
  }
});

test("does not bump Today when a thread is opened", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir("pi-app-user-data-recency-open-");
  const workspacePath = await makeWorkspace("recency-open");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    const workspace = await waitForWorkspaceByPath(window, workspacePath);
    await createHistoryThreads(window, workspace.id, ["Older today", "Newest today"]);

    await expectTodayTitles(window, ["Newest today", "Older today"]);
    const before = await recencyStamps(window, workspace.id, ["Older today", "Newest today"]);

    await recencySection(window, "Today")
      .locator(".session-row__select", { hasText: "Older today" })
      .click();
    await expect(window.locator(".topbar__session")).toHaveText("Older today");
    await expectTodayTitles(window, ["Newest today", "Older today"]);

    const after = await recencyStamps(window, workspace.id, ["Older today", "Newest today"]);
    expect(after).toEqual(before);
    await captureSidebarProof(window, "click-does-not-bump.png");
  } finally {
    await harness.close();
  }
});

test("bumps a sent thread to the top of Today", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir("pi-app-user-data-recency-send-");
  const agentDir = join(userDataDir, "agent");
  await seedAgentDir(agentDir);
  const workspacePath = await makeWorkspace("recency-send");
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    const workspace = await waitForWorkspaceByPath(window, workspacePath);
    await createHistoryThreads(window, workspace.id, ["Older today", "Newest today"]);
    await expectTodayTitles(window, ["Newest today", "Older today"]);

    await recencySection(window, "Today")
      .locator(".session-row__select", { hasText: "Older today" })
      .click();
    await expect(window.locator(".topbar__session")).toHaveText("Older today");
    await expectTodayTitles(window, ["Newest today", "Older today"]);

    await sendComposerPrompt(window, "Bump this thread by sending");
    await expectTodayTitles(window, ["Older today", "Newest today"]);

    const state = await getDesktopState(window);
    const sessions = workspaceSessions(state, workspace.id);
    const older = sessions.find((session) => session.title === "Older today");
    const newest = sessions.find((session) => session.title === "Newest today");
    expect(older?.lastInteractedAt).toBeTruthy();
    expect(newest?.lastInteractedAt).toBeUndefined();
    await captureSidebarProof(window, "send-bumps-today.png");
  } finally {
    await harness.close();
  }
});

test("selects recency-order threads with 1-9 even when another thread is pinned", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir("pi-app-user-data-recency-shortcut-");
  const agentDir = join(userDataDir, "agent");
  await seedAgentDir(agentDir);
  const workspacePath = await makeWorkspace("recency-shortcut");
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    const workspace = await waitForWorkspaceByPath(window, workspacePath);
    await createHistoryThreads(window, workspace.id, ["Alpha", "Bravo", "Charlie"]);

    const charlieRow = window.locator(".session-row", { hasText: "Charlie" });
    await charlieRow.hover();
    await window.getByRole("button", { name: /Pin Charlie/ }).click();

    const pinned = window.getByRole("region", { name: "Pinned threads" });
    await expect(pinned.locator(".session-row__title")).toHaveText(["Charlie"]);
    await expectTodayTitles(window, ["Bravo", "Alpha"]);

    await recencySection(window, "Today")
      .locator(".session-row__select", { hasText: "Alpha" })
      .click();
    await expect(window.locator(".topbar__session")).toHaveText("Alpha");
    await window.keyboard.press(desktopShortcut("1"));
    await expect(window.locator(".topbar__session")).toHaveText("Charlie");

    await recencySection(window, "Today")
      .locator(".session-row__select", { hasText: "Alpha" })
      .click();
    await expect(window.locator(".topbar__session")).toHaveText("Alpha");
    await sendComposerPrompt(window, "Send makes Alpha ⌘1");
    await expectTodayTitles(window, ["Alpha", "Bravo"]);
    await window.keyboard.press(desktopShortcut("1"));
    await expect(window.locator(".topbar__session")).toHaveText("Alpha");
    await window.keyboard.press(desktopShortcut("2"));
    await expect(window.locator(".topbar__session")).toHaveText("Charlie");
    await captureSidebarProof(window, "shortcut-recency-over-pin.png");
  } finally {
    await harness.close();
  }
});

test("groups seeded Last 7 Days, Last 30 Days, and Older threads", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir("pi-app-user-data-recency-buckets-");
  const workspaceAPath = await makeWorkspace("recency-buckets-a");
  const workspaceBPath = await makeWorkspace("recency-buckets-b");
  const agentDir = join(userDataDir, "agent");
  await seedAgentDir(agentDir);
  const firstRun = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspaceAPath, workspaceBPath],
    testMode: "background",
  });

  let seeded:
    | {
        readonly todayKey: string;
        readonly weekKey: string;
        readonly monthKey: string;
        readonly olderKey: string;
        readonly selectedWorkspaceId: string;
        readonly selectedSessionId: string;
      }
    | undefined;

  try {
    const window = await firstRun.firstWindow();
    const workspaceA = await waitForWorkspaceByPath(window, workspaceAPath);
    const workspaceB = await waitForWorkspaceByPath(window, workspaceBPath);
    await createHistoryThreads(window, workspaceA.id, ["Today thread", "Week thread"]);
    await createHistoryThreads(window, workspaceB.id, ["Month thread", "Older thread"]);
    const state = await getDesktopState(window);
    const today = findSession(state, "Today thread");
    const week = findSession(state, "Week thread");
    const month = findSession(state, "Month thread");
    const older = findSession(state, "Older thread");
    seeded = {
      todayKey: `${today.workspaceId}:${today.session.id}`,
      weekKey: `${week.workspaceId}:${week.session.id}`,
      monthKey: `${month.workspaceId}:${month.session.id}`,
      olderKey: `${older.workspaceId}:${older.session.id}`,
      selectedWorkspaceId: today.workspaceId,
      selectedSessionId: today.session.id,
    };
    await expect
      .poll(async () => {
        try {
          return await readFile(join(userDataDir, "ui-state.json"), "utf8");
        } catch {
          return "";
        }
      })
      .toContain("lastInteractedAtBySession");
  } finally {
    await firstRun.close();
  }

  expect(seeded).toBeDefined();
  const stamps = {
    [seeded!.todayKey]: localDaysAgo(0),
    [seeded!.weekKey]: localDaysAgo(2),
    [seeded!.monthKey]: localDaysAgo(14),
    [seeded!.olderKey]: localDaysAgo(40),
  };
  await seedRecencyTimestamps(userDataDir, stamps, {
    selectedWorkspaceId: seeded!.selectedWorkspaceId,
    selectedSessionId: seeded!.selectedSessionId,
  });

  const secondRun = await launchDesktop(userDataDir, { testMode: "background" });
  try {
    const window = await secondRun.firstWindow();
    await waitForWorkspaceByPath(window, workspaceAPath);
    await expect(recencySection(window, "Today").locator(".session-row__title")).toHaveText([
      "Today thread",
    ]);
    await expect(recencySection(window, "Last 7 Days").locator(".session-row__title")).toHaveText([
      "Week thread",
    ]);
    await expect(recencySection(window, "Last 30 Days").locator(".session-row__title")).toHaveText([
      "Month thread",
    ]);
    await expect(recencySection(window, "Older").locator(".session-row__title")).toHaveText([
      "Older thread",
    ]);
    await expect(recencySection(window, "Last 7 Days").locator(".session-row__context")).toHaveText(
      [basename(workspaceAPath)],
    );
    await expect(recencySection(window, "Older").locator(".session-row__context")).toHaveText([
      basename(workspaceBPath),
    ]);
    await captureSidebarProof(window, "seeded-buckets.png");

    const weekStampBefore = findSession(await getDesktopState(window), "Week thread").session
      .lastInteractedAt;
    await recencySection(window, "Last 7 Days")
      .locator(".session-row__select", { hasText: "Week thread" })
      .click();
    await expect(window.locator(".topbar__session")).toHaveText("Week thread");
    await expect(recencySection(window, "Last 7 Days").locator(".session-row__title")).toHaveText([
      "Week thread",
    ]);
    await expectTodayTitles(window, ["Today thread"]);
    expect(findSession(await getDesktopState(window), "Week thread").session.lastInteractedAt).toBe(
      weekStampBefore,
    );
    await captureSidebarProof(window, "click-keeps-week-bucket.png");

    await sendComposerPrompt(window, "Send moves Week into Today");
    await expectTodayTitles(window, ["Week thread", "Today thread"]);
    await expect(window.getByRole("region", { name: "Last 7 Days" })).toHaveCount(0);
    const weekAfterSend = findSession(await getDesktopState(window), "Week thread").session;
    expect(weekAfterSend.lastInteractedAt).toBeTruthy();
    expect(weekAfterSend.lastInteractedAt! > (weekStampBefore ?? "")).toBe(true);
    await captureSidebarProof(window, "send-bumps-week-to-today.png");
  } finally {
    await secondRun.close();
  }
});

test("caps a long Last 7 Days bucket and sorts the folder by last send", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir("pi-app-user-data-grouping-");
  const workspacePath = await makeWorkspace("grouping-folder");
  const titles = ["Week 1", "Week 2", "Week 3", "Week 4", "Catalog newer", "Sent later"];
  const firstRun = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  let selection:
    { readonly selectedWorkspaceId: string; readonly selectedSessionId: string } | undefined;
  let keys: Record<string, string> | undefined;
  let workspaceName = "";

  try {
    const window = await firstRun.firstWindow();
    const workspace = await waitForWorkspaceByPath(window, workspacePath);
    workspaceName = workspace.name;
    await createHistoryThreads(window, workspace.id, titles);
    const state = await getDesktopState(window);
    keys = Object.fromEntries(
      titles.map((title) => {
        const found = findSession(state, title);
        return [title, `${found.workspaceId}:${found.session.id}`];
      }),
    );
    selection = {
      selectedWorkspaceId: workspace.id,
      selectedSessionId: findSession(state, "Sent later").session.id,
    };
  } finally {
    await firstRun.close();
  }

  const stamps = {
    [keys!["Week 1"]!]: localDaysAgo(2, 8),
    [keys!["Week 2"]!]: localDaysAgo(2, 9),
    [keys!["Week 3"]!]: localDaysAgo(2, 10),
    [keys!["Week 4"]!]: localDaysAgo(2, 11),
    [keys!["Catalog newer"]!]: localDaysAgo(2, 12),
    [keys!["Sent later"]!]: localDaysAgo(2, 18),
  };
  await seedRecencyTimestamps(userDataDir, stamps, selection!);
  const catalogsPath = join(userDataDir, "catalogs.json");
  const catalogs = JSON.parse(await readFile(catalogsPath, "utf8")) as {
    sessions: Array<{
      sessionRef: { workspaceId: string; sessionId: string };
      updatedAt: string;
    }>;
  };
  catalogs.sessions = catalogs.sessions.map((session) => {
    const key = `${session.sessionRef.workspaceId}:${session.sessionRef.sessionId}`;
    if (key === keys!["Sent later"]) {
      return { ...session, updatedAt: localDaysAgo(40) };
    }
    if (key === keys!["Catalog newer"]) {
      return { ...session, updatedAt: localDaysAgo(2, 20) };
    }
    return session;
  });
  await writeFile(catalogsPath, `${JSON.stringify(catalogs, null, 2)}\n`);

  const secondRun = await launchDesktop(userDataDir, { testMode: "background" });
  try {
    const window = await secondRun.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    const week = recencySection(window, "Last 7 Days");
    await expect(week.locator(".session-row__title")).toHaveText([
      "Sent later",
      "Catalog newer",
      "Week 4",
      "Week 3",
      "Week 2",
    ]);
    await expect(window.locator(".workspace-row")).toHaveCount(0);
    await week.getByRole("button", { name: "Show more Last 7 Days" }).click();
    await expect(week.locator(".session-row__title")).toHaveText([
      "Sent later",
      "Catalog newer",
      "Week 4",
      "Week 3",
      "Week 2",
      "Week 1",
    ]);
    await week.getByRole("button", { name: "Show less Last 7 Days" }).click();
    await expect(week.locator(".session-row")).toHaveCount(5);

    await chooseThreadGrouping(window, "workspace");
    const folderThreads = window.locator(".workspace-group .session-row__title");
    await expect(folderThreads).toHaveText([
      "Sent later",
      "Catalog newer",
      "Week 4",
      "Week 3",
      "Week 2",
    ]);
    await window
      .locator(".workspace-group")
      .getByRole("button", { name: `Show more ${workspaceName}` })
      .click();
    await expect(folderThreads).toHaveText([
      "Sent later",
      "Catalog newer",
      "Week 4",
      "Week 3",
      "Week 2",
      "Week 1",
    ]);

    const before = findSession(await getDesktopState(window), "Catalog newer").session
      .lastInteractedAt;
    await window.locator(".session-row__select", { hasText: "Catalog newer" }).click();
    await expect(window.locator(".topbar__session")).toHaveText("Catalog newer");
    await expect(folderThreads.first()).toHaveText("Sent later");
    expect(
      findSession(await getDesktopState(window), "Catalog newer").session.lastInteractedAt,
    ).toBe(before);

    await expect
      .poll(async () => readFile(join(userDataDir, "ui-state.json"), "utf8"))
      .toContain('"threadGrouping": "workspace"');
  } finally {
    await secondRun.close();
  }

  const thirdRun = await launchDesktop(userDataDir, { testMode: "background" });
  try {
    const window = await thirdRun.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await expect(window.getByRole("button", { name: "Group threads" })).toHaveText("Workspace");
    await expect(window.locator(".workspace-group .session-row__title").first()).toHaveText(
      "Sent later",
    );
    await expect(window.getByRole("region", { name: "Last 7 Days" })).toHaveCount(0);
  } finally {
    await thirdRun.close();
  }
});

async function recencyStamps(
  window: Page,
  workspaceId: string,
  titles: readonly string[],
): Promise<Record<string, string | undefined>> {
  const sessions = workspaceSessions(await getDesktopState(window), workspaceId);
  return Object.fromEntries(
    titles.map((title) => [
      title,
      sessions.find((session) => session.title === title)?.lastInteractedAt,
    ]),
  );
}

async function sendComposerPrompt(window: Page, text: string): Promise<void> {
  const composer = window.getByTestId("composer");
  await expect(composer).toBeVisible();
  await composer.fill(text);
  await window.getByRole("button", { name: "Send message" }).click();
  await expect
    .poll(
      async () => {
        const transcript = await getSelectedTranscript(window);
        const userMessage = transcript?.transcript.find(
          (entry): entry is Extract<typeof entry, { kind: "message" }> =>
            entry.kind === "message" && entry.role === "user",
        );
        return userMessage?.text ?? "";
      },
      { timeout: 15_000 },
    )
    .toContain(text);
}

function recencySection(window: Page, label: string): Locator {
  return window.getByRole("region", { name: label, exact: true });
}

async function expectTodayTitles(window: Page, titles: readonly string[]): Promise<void> {
  await expect(recencySection(window, "Today").locator(".session-row__title")).toHaveText([
    ...titles,
  ]);
}

function numberedThreadTitles(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix} thread ${index + 1}`);
}

function workspaceSessions(state: DesktopAppState, workspaceId: string): readonly SessionRecord[] {
  return state.workspaces.find((entry) => entry.id === workspaceId)?.sessions ?? [];
}

function findSession(
  state: DesktopAppState,
  title: string,
): { readonly workspaceId: string; readonly session: SessionRecord } {
  for (const workspace of state.workspaces) {
    const session = workspace.sessions.find((entry) => entry.title === title);
    if (session) {
      return { workspaceId: workspace.id, session };
    }
  }
  throw new Error(`Session not found: ${title}`);
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
      const created = new Set(titles);
      return state.workspaces
        .flatMap((workspace) => workspace.sessions)
        .filter((session) => created.has(session.title)).length;
    })
    .toBe(titles.length);
}

function localDaysAgo(days: number, hour = 12): string {
  const now = new Date();
  if (days === 0) {
    return new Date(now.getTime() - 5_000).toISOString();
  }
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - days,
    hour,
    0,
    0,
  ).toISOString();
}

async function seedRecencyTimestamps(
  userDataDir: string,
  stamps: Readonly<Record<string, string>>,
  selection: { readonly selectedWorkspaceId: string; readonly selectedSessionId: string },
): Promise<void> {
  const uiStatePath = join(userDataDir, "ui-state.json");
  const catalogsPath = join(userDataDir, "catalogs.json");
  const uiState = JSON.parse(await readFile(uiStatePath, "utf8")) as Record<string, unknown>;
  await writeFile(
    uiStatePath,
    `${JSON.stringify(
      {
        ...uiState,
        selectedWorkspaceId: selection.selectedWorkspaceId,
        selectedSessionId: selection.selectedSessionId,
        lastInteractedAtBySession: stamps,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const catalogs = JSON.parse(await readFile(catalogsPath, "utf8")) as {
    sessions: Array<{
      sessionRef: { workspaceId: string; sessionId: string };
      updatedAt: string;
    }>;
  };
  catalogs.sessions = catalogs.sessions.map((session) => {
    const key = `${session.sessionRef.workspaceId}:${session.sessionRef.sessionId}`;
    const updatedAt = stamps[key];
    return updatedAt ? { ...session, updatedAt } : session;
  });
  await writeFile(catalogsPath, `${JSON.stringify(catalogs, null, 2)}\n`, "utf8");
}

async function captureSidebarProof(window: Page, filename: string): Promise<void> {
  await mkdir(proofDir, { recursive: true });
  await window.locator(".sidebar").screenshot({ path: join(proofDir, filename) });
}
