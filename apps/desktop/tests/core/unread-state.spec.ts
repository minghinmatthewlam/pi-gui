import { randomUUID } from "node:crypto";
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

type PersistedUiState = {
  lastViewedAtBySession?: Record<string, string>;
};

type PersistedTranscript = {
  version?: number;
  transcript?: unknown;
} | unknown[];

type PersistedTranscriptItem = {
  kind: string;
  id: string;
  createdAt: string;
  label?: string;
  presentation?: string;
};

function readTranscriptItems(parsed: PersistedTranscript): PersistedTranscriptItem[] {
  if (Array.isArray(parsed)) {
    return parsed as PersistedTranscriptItem[];
  }
  return Array.isArray(parsed.transcript) ? (parsed.transcript as PersistedTranscriptItem[]) : [];
}

function writeTranscriptPayload(
  parsed: PersistedTranscript,
  items: readonly PersistedTranscriptItem[],
): PersistedTranscript {
  if (Array.isArray(parsed)) {
    return [...items];
  }
  return {
    version: parsed.version ?? 1,
    transcript: items,
  };
}

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
  const { rawSessionKey, transcriptPath } = persistedSessionDataPaths(userDataDir, sessionRef!);
  const uiStatePath = join(userDataDir, "ui-state.json");
  const [uiStateRaw, transcriptRaw] = await Promise.all([
    readFile(uiStatePath, "utf8"),
    readFile(transcriptPath, "utf8").catch(() => JSON.stringify({ version: 1, transcript: [] })),
  ]);
  const uiState = JSON.parse(uiStateRaw) as PersistedUiState;
  const parsedTranscript = JSON.parse(transcriptRaw) as PersistedTranscript;
  const transcriptItems = readTranscriptItems(parsedTranscript);
  const latestCreatedAt = new Date(Date.now() + 5 * 60 * 1_000).toISOString();
  transcriptItems.push({
    kind: "summary",
    id: randomUUID(),
    createdAt: latestCreatedAt,
    label: "Trailing persisted activity",
    presentation: "inline",
  });

  await Promise.all([
    writeFile(
      transcriptPath,
      `${JSON.stringify(writeTranscriptPayload(parsedTranscript, transcriptItems), null, 2)}\n`,
      "utf8",
    ),
    writeFile(
      uiStatePath,
      `${JSON.stringify(
        {
          ...uiState,
          lastViewedAtBySession: {
            ...(uiState.lastViewedAtBySession ?? {}),
            [rawSessionKey]: new Date(Date.parse(latestCreatedAt) - 1_000).toISOString(),
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    ),
  ]);

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
    await expect(window.locator(".session-row", { hasText: title })).toHaveAttribute("data-sidebar-indicator", "none");
  } finally {
    await thirdRun.close();
  }
});
