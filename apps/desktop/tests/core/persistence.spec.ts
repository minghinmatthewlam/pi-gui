import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  getDesktopState,
  getSelectedTranscript,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  pasteTinyPng,
  persistedSessionDataPaths,
} from "../helpers/electron-app";

test("pastes an image into the composer surface and clears the attachment chip on submit", async () => {
  test.setTimeout(30_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("paste-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Paste test");

    const composer = window.getByTestId("composer");
    await pasteTinyPng(window);

    const chip = window.locator(".composer-attachment");
    await expect(chip).toBeVisible();
    await expect(chip.locator(".composer-attachment__name")).toContainText("screenshot.png");
    await expect(chip.locator(".composer-attachment__preview")).toBeVisible();

    await composer.fill("test with image");
    await composer.press("Enter");
    await expect(window.locator(".composer-attachment")).toHaveCount(0, { timeout: 10_000 });
    await expect(composer).toHaveValue("");
  } finally {
    await harness.close();
  }
});

test("persists transcript storage separately from ui state and restores the current draft", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("persistence-workspace");

  const firstRun = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await firstRun.firstWindow();
    await createNamedThread(window, "Persistence session");

    const composer = window.getByTestId("composer");
    await pasteTinyPng(window);
    await expect(window.locator(".composer-attachment")).toBeVisible();

    await composer.fill("/status");
    await composer.press("Enter");
    await expect(window.getByTestId("transcript")).toContainText(/Model |No session overrides set/);

    await composer.fill("draft survives restart");
    await expect(composer).toHaveValue("draft survives restart");

    await expect
      .poll(async () => {
        const transcript = await getSelectedTranscript(window);
        return transcript?.transcript.length ?? 0;
      })
      .toBeGreaterThan(0);

    const state = await getDesktopState(window);
    const workspaceId = state.selectedWorkspaceId;
    const sessionId = state.selectedSessionId;
    expect(workspaceId).toBeTruthy();
    expect(sessionId).toBeTruthy();

    const uiStateRaw = await readFile(join(userDataDir, "ui-state.json"), "utf8");
    const uiState = JSON.parse(uiStateRaw) as Record<string, unknown>;
    expect(uiState.transcripts).toBeUndefined();
    expect(uiState.composerAttachmentsBySession).toBeUndefined();

    const transcriptPath = join(userDataDir, "transcripts", encodeURIComponent(`${workspaceId}:${sessionId}`) + ".json");
    const attachmentPath = join(userDataDir, "attachments", encodeURIComponent(`${workspaceId}:${sessionId}`) + ".json");
    await expect
      .poll(async () => {
        try {
          return await readFile(transcriptPath, "utf8");
        } catch {
          return "";
        }
      })
      .toContain("\"kind\": \"activity\"");
    await expect
      .poll(async () => {
        try {
          return await readFile(attachmentPath, "utf8");
        } catch {
          return "";
        }
      })
      .toContain("\"mimeType\": \"image/png\"");
  } finally {
    await firstRun.close();
  }

  const secondRun = await launchDesktop(userDataDir, { testMode: "background" });
  try {
    const window = await secondRun.firstWindow();
    await expect(window.getByTestId("composer")).toHaveValue("draft survives restart");
    await expect
      .poll(async () => {
        const state = await getDesktopState(window);
        const transcript = await getSelectedTranscript(window);
        return {
          attachments: state.composerAttachments.length,
          transcriptLines: transcript?.transcript.length ?? 0,
        };
      })
      .toMatchObject({
        attachments: 1,
      });
  } finally {
    await secondRun.close();
  }
});

test("migrates legacy inline transcript and attachment persistence into file-backed stores", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("legacy-persistence-workspace");

  const firstRun = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  let workspaceId = "";
  let sessionId = "";
  try {
    const window = await firstRun.firstWindow();
    await createNamedThread(window, "Legacy persistence session");

    const composer = window.getByTestId("composer");
    await pasteTinyPng(window);
    await composer.fill("/status");
    await composer.press("Enter");
    await expect(window.getByTestId("transcript")).toContainText(/Model |No session overrides set/);

    await composer.fill("legacy draft");
    await expect(composer).toHaveValue("legacy draft");

    const state = await getDesktopState(window);
    workspaceId = state.selectedWorkspaceId;
    sessionId = state.selectedSessionId;
    const { transcriptPath, attachmentPath } = persistedSessionDataPaths(userDataDir, {
      workspaceId,
      sessionId,
    });
    await expect
      .poll(async () => {
        try {
          return await readFile(transcriptPath, "utf8");
        } catch {
          return "";
        }
      })
      .toContain("\"kind\": \"activity\"");
    await expect
      .poll(async () => {
        try {
          return await readFile(attachmentPath, "utf8");
        } catch {
          return "";
        }
      })
      .toContain("\"mimeType\": \"image/png\"");
  } finally {
    await firstRun.close();
  }

  const { rawSessionKey, transcriptPath, attachmentPath } = persistedSessionDataPaths(userDataDir, {
    workspaceId,
    sessionId,
  });
  const [transcriptRaw, attachmentRaw, uiStateRaw] = await Promise.all([
    readFile(transcriptPath, "utf8"),
    readFile(attachmentPath, "utf8"),
    readFile(join(userDataDir, "ui-state.json"), "utf8"),
  ]);

  const parsedTranscript = JSON.parse(transcriptRaw) as { transcript?: unknown } | unknown[];
  const legacyTranscript = Array.isArray(parsedTranscript)
    ? parsedTranscript
    : Array.isArray(parsedTranscript?.transcript)
      ? parsedTranscript.transcript
      : [];
  const uiState = JSON.parse(uiStateRaw) as Record<string, unknown>;
  await Promise.all([unlink(transcriptPath), unlink(attachmentPath)]);
  await writeFile(
    join(userDataDir, "ui-state.json"),
    `${JSON.stringify(
      {
        ...uiState,
        transcripts: {
          [rawSessionKey]: legacyTranscript,
        },
        composerAttachmentsBySession: {
          [rawSessionKey]: JSON.parse(attachmentRaw),
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
    await expect(window.getByTestId("workspace-list")).toContainText("legacy-persistence-workspace");
    await expect(window.locator(".session-row--active")).toContainText("Legacy persistence session");
    await expect(window.getByTestId("composer")).toHaveValue("legacy draft", { timeout: 15_000 });
    await expect(window.locator(".composer-attachment")).toHaveCount(1);
    await expect(window.getByTestId("transcript")).toContainText(/Model |No session overrides set/);

    await expect
      .poll(async () => {
        const transcript = await getSelectedTranscript(window);
        return transcript?.transcript.length ?? 0;
      })
      .toBeGreaterThan(0);

    const rewrittenUiState = JSON.parse(await readFile(join(userDataDir, "ui-state.json"), "utf8")) as Record<string, unknown>;
    expect(rewrittenUiState.transcripts).toBeUndefined();
    expect(rewrittenUiState.composerAttachmentsBySession).toBeUndefined();
    await expect
      .poll(async () => {
        try {
          return await readFile(transcriptPath, "utf8");
        } catch {
          return "";
        }
      })
      .toContain("\"kind\": \"activity\"");
    await expect
      .poll(async () => {
        try {
          return await readFile(attachmentPath, "utf8");
        } catch {
          return "";
        }
      })
      .toContain("\"mimeType\": \"image/png\"");
  } finally {
    await secondRun.close();
  }
});
