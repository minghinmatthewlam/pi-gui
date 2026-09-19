import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  persistedSessionDataPaths,
  selectSession,
} from "../helpers/electron-app";
import { appendMessagesToSessionFile, sessionFilePathFromCatalog } from "../helpers/session-file";

type PersistedUiState = {
  lastViewedAtBySession?: Record<string, string>;
};

test("selecting an unread thread persists read state through the latest known activity", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("unread-state-workspace");
  const title = "Unread watermark session";

  const firstRun = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  let sessionRef: { workspaceId: string; sessionId: string } | undefined;
  try {
    const window = await firstRun.firstWindow();
    await createNamedThread(window, title);
    const state = await getDesktopState(window);
    sessionRef = {
      workspaceId: state.selectedWorkspaceId,
      sessionId: state.selectedSessionId,
    };
  } finally {
    await firstRun.close();
  }

  expect(sessionRef).toBeDefined();
  const { rawSessionKey } = persistedSessionDataPaths(userDataDir, sessionRef!);
  const uiStatePath = join(userDataDir, "ui-state.json");
  const uiState = JSON.parse(await readFile(uiStatePath, "utf8")) as PersistedUiState;

  // Append a future-dated message to pi's session file: activity the user has
  // not seen yet, newer than the persisted lastViewedAt watermark.
  const latestCreatedAtMs = Date.now() + 5 * 60 * 1_000;
  await appendMessagesToSessionFile(await sessionFilePathFromCatalog(userDataDir, sessionRef!), [
    { role: "assistant", text: "Trailing persisted activity", timestampMs: latestCreatedAtMs },
  ]);
  await writeFile(
    uiStatePath,
    `${JSON.stringify(
      {
        ...uiState,
        lastViewedAtBySession: {
          ...(uiState.lastViewedAtBySession ?? {}),
          [rawSessionKey]: new Date(latestCreatedAtMs - 1_000).toISOString(),
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const secondRun = await launchDesktop(userDataDir, { testMode: "background" });
  try {
    const window = await secondRun.firstWindow();
    const row = window.locator(".session-row", { hasText: title });
    await expect(row).toHaveAttribute("data-sidebar-indicator", "unseen");

    await selectSession(window, title);
    await expect(row).toHaveAttribute("data-sidebar-indicator", "none");
  } finally {
    await secondRun.close();
  }

  const thirdRun = await launchDesktop(userDataDir, { testMode: "background" });
  try {
    const window = await thirdRun.firstWindow();
    await expect(window.locator(".session-row", { hasText: title })).toHaveAttribute(
      "data-sidebar-indicator",
      "none",
    );
  } finally {
    await thirdRun.close();
  }
});
