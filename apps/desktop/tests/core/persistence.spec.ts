import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  createSessionViaIpc,
  getDesktopState,
  getSelectedTranscript,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  pasteTinyPng,
  persistedSessionDataPaths,
  selectSession,
  stubNextOpenDialog,
  writeProjectExtension,
  writeTextFile,
} from "../helpers/electron-app";
import { appendMessagesToSessionFile, sessionFilePathFromCatalog } from "../helpers/session-file";

test("clears mixed attachment chips on submit after paste and file attach", async () => {
  test.setTimeout(30_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("paste-workspace");
  const filePath = join(workspacePath, "composer-notes.txt");
  await writeTextFile(filePath, "submit clears file attachment too");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Paste test");

    const composer = window.getByTestId("composer");
    await pasteTinyPng(window);
    await stubNextOpenDialog(harness, [filePath]);
    await window.getByRole("button", { name: "Attach files" }).click();

    await expect(window.locator(".composer-attachment--image")).toHaveCount(1);
    await expect(window.locator(".composer-attachment--file")).toHaveCount(1);

    await composer.fill("test with image");
    await composer.press("Enter");
    await expect(window.locator(".composer-attachment")).toHaveCount(0, { timeout: 10_000 });
    await expect(composer).toHaveValue("");
  } finally {
    await harness.close();
  }
});

test("persists attachments separately from ui state and restores the current draft", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("persistence-workspace");
  const filePath = join(workspacePath, "persisted-notes.txt");
  await writeTextFile(filePath, "persisted file attachment");

  const firstRun = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await firstRun.firstWindow();
    await createNamedThread(window, "Persistence session");

    const composer = window.getByTestId("composer");
    await pasteTinyPng(window);
    await stubNextOpenDialog(firstRun, [filePath]);
    await window.getByRole("button", { name: "Attach files" }).click();
    await expect(window.locator(".composer-attachment")).toHaveCount(2);

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

    // The renderer syncs drafts on a debounce; wait until it lands on disk
    // before quitting so the restart assertion is deterministic.
    await expect
      .poll(async () => {
        try {
          return await readFile(join(userDataDir, "ui-state.json"), "utf8");
        } catch {
          return "";
        }
      })
      .toContain("draft survives restart");

    const state = await getDesktopState(window);
    const workspaceId = state.selectedWorkspaceId;
    const sessionId = state.selectedSessionId;
    expect(workspaceId).toBeTruthy();
    expect(sessionId).toBeTruthy();

    const uiStateRaw = await readFile(join(userDataDir, "ui-state.json"), "utf8");
    const uiState = JSON.parse(uiStateRaw) as Record<string, unknown>;
    expect(uiState.transcripts).toBeUndefined();
    expect(uiState.composerAttachmentsBySession).toBeUndefined();

    const attachmentPath = join(
      userDataDir,
      "attachments",
      encodeURIComponent(`${workspaceId}:${sessionId}`) + ".json",
    );
    await expect
      .poll(async () => {
        try {
          return await readFile(attachmentPath, "utf8");
        } catch {
          return "";
        }
      })
      .toContain('"kind": "image"');
    await expect
      .poll(async () => {
        try {
          return await readFile(attachmentPath, "utf8");
        } catch {
          return "";
        }
      })
      .toContain('"kind": "file"');
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
        attachments: 2,
      });
  } finally {
    await secondRun.close();
  }
});

test("recovers persisted ui state from the backup when ui-state.json is corrupt", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("corruption-recovery-workspace");

  const firstRun = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await firstRun.firstWindow();
    await createNamedThread(window, "Corruption recovery session");
    const composer = window.getByTestId("composer");
    await composer.fill("recover me from backup");
    await expect(composer).toHaveValue("recover me from backup");
    await expect
      .poll(async () => {
        try {
          return await readFile(join(userDataDir, "ui-state.json"), "utf8");
        } catch {
          return "";
        }
      })
      .toContain("recover me from backup");
  } finally {
    await firstRun.close();
  }

  // Simulate a crash that left the primary file truncated: keep the last good
  // snapshot as the `.bak` sibling and corrupt the primary. A regressed reader
  // would swallow the parse error, return `{}`, and silently wipe every draft,
  // pin, and workspace order on the next write.
  const uiStatePath = join(userDataDir, "ui-state.json");
  const goodSnapshot = await readFile(uiStatePath, "utf8");
  expect(goodSnapshot).toContain("recover me from backup");
  await writeFile(`${uiStatePath}.bak`, goodSnapshot, "utf8");
  await writeFile(uiStatePath, "{ this is not valid json", "utf8");

  const secondRun = await launchDesktop(userDataDir, { testMode: "background" });
  try {
    const window = await secondRun.firstWindow();
    await expect(window.getByTestId("workspace-list")).toContainText(
      "corruption-recovery-workspace",
    );
    await expect(window.getByTestId("composer")).toHaveValue("recover me from backup", {
      timeout: 15_000,
    });
  } finally {
    await secondRun.close();
  }
});

test("rejects malformed nested state without overwriting it and resumes after repair", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("malformed-nested-state-workspace");
  const uiStatePath = join(userDataDir, "ui-state.json");
  const extensionPath = await writeProjectExtension(
    workspacePath,
    "persisted-compatibility.ts",
    `export default function persistedCompatibility(pi) {
      pi.registerCommand("persisted-safe", {
        description: "Persisted compatibility fixture",
        handler: async () => {},
      });
    }\n`,
  );
  const validCompatibility = {
    commandName: "persisted-safe",
    extensionPath,
    status: "supported",
    message: "GUI-compatible command",
    capability: "host-ui",
    updatedAt: "2026-07-27T00:00:00.000Z",
  } as const;

  const firstRun = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  let workspaceId = "";
  let sessionId = "";
  let childSessionId = "";
  try {
    const window = await firstRun.firstWindow();
    await createNamedThread(window, "Malformed nested state session");
    const state = await getDesktopState(window);
    workspaceId = state.selectedWorkspaceId;
    sessionId = state.selectedSessionId;
    await createSessionViaIpc(window, workspaceId, "Supervised child session");
    childSessionId =
      (await getDesktopState(window)).workspaces
        .find((entry) => entry.id === workspaceId)
        ?.sessions.find((entry) => entry.title === "Supervised child session")?.id ?? "";
    expect(childSessionId).toBeTruthy();
    await selectSession(window, "Malformed nested state session");
    await window.getByTestId("composer").fill("valid draft survives malformed nested state");
    await expect
      .poll(async () => readPresentText(uiStatePath))
      .toContain("valid draft survives malformed nested state");
  } finally {
    await firstRun.close();
  }

  const sessionFilePath = await sessionFilePathFromCatalog(userDataDir, { workspaceId, sessionId });
  await appendMessagesToSessionFile(sessionFilePath, [
    { role: "user", text: "valid catalog transcript survives malformed nested state" },
  ]);

  const persisted = JSON.parse(await readFile(uiStatePath, "utf8")) as Record<string, unknown>;
  const malformedSnapshot = `${JSON.stringify(
    {
      ...persisted,
      selectedWorkspaceId: workspaceId,
      selectedSessionId: sessionId,
      composerDraft: "valid draft survives malformed nested state",
      composerDraftsBySession: {
        [`${workspaceId}:${sessionId}`]: "valid draft survives malformed nested state",
      },
      extensionCommandCompatibilityByWorkspace: {
        [workspaceId]: [
          validCompatibility,
          {
            commandName: "missing-required-fields",
          },
        ],
        "malformed-workspace": {
          commandName: "not-an-array",
        },
      },
      composerAttachmentsBySession: {
        [`${workspaceId}:${sessionId}`]: {
          kind: "image",
        },
      },
      orchestrationChildren: [
        {
          id: "persisted-supervised-child",
          parentWorkspaceId: workspaceId,
          parentSessionId: sessionId,
          childWorkspaceId: workspaceId,
          childSessionId,
          title: "Supervised child session",
          goal: "Prove startup supervision continues after malformed persistence.",
          status: "queued",
          latestTranscript: "Waiting for supervision.",
          transcript: [],
          evidence: [],
          supervisionLoop: {
            id: "persisted-supervision-loop",
            status: "monitoring",
            gate: "continue",
            intervalMs: 250,
            iterationCount: 7,
            lastCheckedAt: "2000-01-01T00:00:00.000Z",
            nextRunAt: "2000-01-01T00:00:00.000Z",
            reason: "Waiting for the child to start.",
            lastChildStatus: "queued",
          },
          createdAt: "2026-07-27T00:00:00.000Z",
          updatedAt: "2026-07-27T00:00:00.000Z",
        },
      ],
    },
    null,
    2,
  )}\n`;
  await writeFile(uiStatePath, malformedSnapshot, "utf8");

  const secondRun = await launchDesktop(userDataDir, { testMode: "background" });
  try {
    const window = await secondRun.firstWindow();
    await expect(window.getByTestId("startup-diagnostics")).toContainText(
      /ui-state|compatibility/i,
    );
    expect(await readFile(uiStatePath, "utf8")).toBe(malformedSnapshot);
    expect(await readFile(sessionFilePath, "utf8")).toContain(
      "valid catalog transcript survives malformed nested state",
    );
  } finally {
    await secondRun.close();
  }
  expect(await readFile(uiStatePath, "utf8")).toBe(malformedSnapshot);

  // Simulate deliberate external repair, then prove normal startup resumes.
  await writeFile(uiStatePath, JSON.stringify(persisted));
  const repairedRun = await launchDesktop(userDataDir, { testMode: "background" });
  try {
    const window = await repairedRun.firstWindow();
    await expect(window.getByTestId("composer")).toHaveValue(
      "valid draft survives malformed nested state",
    );
    await expect(window.getByTestId("transcript")).toContainText(
      "valid catalog transcript survives malformed nested state",
    );
  } finally {
    await repairedRun.close();
  }
});

test("preserves durable ui state when one startup workspace is unavailable", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const healthyWorkspacePath = await makeWorkspace("healthy-startup-workspace");
  const unavailableWorkspacePath = await makeWorkspace("unavailable-startup-workspace");
  const uiStatePath = join(userDataDir, "ui-state.json");

  const firstRun = await launchDesktop(userDataDir, {
    initialWorkspaces: [healthyWorkspacePath, unavailableWorkspacePath],
    testMode: "background",
  });
  let unavailableWorkspaceId = "";
  let healthyWorkspaceId = "";
  let unavailableSessionId = "";
  try {
    const window = await firstRun.firstWindow();
    const seededState = await window.evaluate(
      async ({ healthyPath, unavailablePath }) => {
        const app = globalThis.window.piApp;
        if (!app) {
          throw new Error("piApp IPC bridge is unavailable");
        }
        let state = await app.getState();
        const healthy = state.workspaces.find((entry) => entry.path === healthyPath);
        const unavailable = state.workspaces.find((entry) => entry.path === unavailablePath);
        if (!healthy || !unavailable) {
          throw new Error("Expected both seeded workspaces");
        }

        await app.selectWorkspace(unavailable.id);
        state = await app.createSession({
          workspaceId: unavailable.id,
          title: "Unavailable workspace session",
        });
        const session = state.workspaces
          .find((entry) => entry.id === unavailable.id)
          ?.sessions.find((entry) => entry.title === "Unavailable workspace session");
        if (!session) {
          throw new Error("Expected seeded unavailable-workspace session");
        }

        await app.selectSession({ workspaceId: unavailable.id, sessionId: session.id });
        await app.updateComposerDraft("draft survives unavailable workspace");
        // Let the renderer's draft debounce settle before unrelated durable writes.
        // A stale local snapshot must not enqueue a later write that clears this draft.
        await new Promise((resolve) => globalThis.window.setTimeout(resolve, 500));
        await app.setSessionPinned({ workspaceId: unavailable.id, sessionId: session.id }, true);
        await app.reorderWorkspaces([unavailable.id, healthy.id]);
        await app.setNotificationPreferences({
          backgroundCompletion: false,
          backgroundFailure: true,
          attentionNeeded: false,
        });
        await app.setIntegratedTerminalShell("/bin/zsh");
        await app.setThemePresetId("github");
        await app.setSidebarCollapsed(true);
        state = await app.getState();
        return {
          state,
          healthyWorkspaceId: healthy.id,
          unavailableWorkspaceId: unavailable.id,
          unavailableSessionId: session.id,
        };
      },
      { healthyPath: healthyWorkspacePath, unavailablePath: unavailableWorkspacePath },
    );

    healthyWorkspaceId = seededState.healthyWorkspaceId;
    unavailableWorkspaceId = seededState.unavailableWorkspaceId;
    unavailableSessionId = seededState.unavailableSessionId;
    expect(seededState.state.selectedWorkspaceId).toBe(unavailableWorkspaceId);
    expect(seededState.state.selectedSessionId).toBe(unavailableSessionId);
    await expect
      .poll(async () => readFile(uiStatePath, "utf8"))
      .toContain("draft survives unavailable workspace");
  } finally {
    await firstRun.close();
  }

  const sessionKey = `${unavailableWorkspaceId}:${unavailableSessionId}`;
  const existingUiState = JSON.parse(await readFile(uiStatePath, "utf8")) as Record<
    string,
    unknown
  >;
  const beforeFailure = {
    ...existingUiState,
    selectedWorkspaceId: unavailableWorkspaceId,
    selectedSessionId: unavailableSessionId,
    activeView: "threads",
    composerDraft: "draft survives unavailable workspace",
    composerDraftsBySession: {
      [sessionKey]: "draft survives unavailable workspace",
    },
    notificationPreferences: {
      backgroundCompletion: false,
      backgroundFailure: true,
      attentionNeeded: false,
    },
    integratedTerminalShell: "/bin/zsh",
    pinnedAtBySession: {
      [sessionKey]: "2026-07-27T00:00:00.000Z",
    },
    pinnedSessionOrder: [sessionKey],
    workspaceOrder: [unavailableWorkspaceId, healthyWorkspaceId],
    themePresetId: "github",
    sidebarCollapsed: true,
  } satisfies Record<string, unknown>;
  await writeFile(uiStatePath, `${JSON.stringify(beforeFailure, null, 2)}\n`, "utf8");
  const movedWorkspacePath = `${unavailableWorkspacePath}-offline`;
  await rename(unavailableWorkspacePath, movedWorkspacePath);

  const secondRun = await launchDesktop(userDataDir, { testMode: "background" });
  try {
    const window = await secondRun.firstWindow();
    const state = await getDesktopState(window);
    const diagnostics = state.startupDiagnostics;

    expect(state.workspaces.some((entry) => entry.id === healthyWorkspaceId)).toBe(true);
    expect(state.workspaces.some((entry) => entry.id === unavailableWorkspaceId)).toBe(true);
    expect(state.selectedWorkspaceId).toBe(unavailableWorkspaceId);
    expect(state.selectedSessionId).toBe(unavailableSessionId);
    expect(state.composerDraft).toBe("draft survives unavailable workspace");
    expect(state.workspaceOrder).toEqual([unavailableWorkspaceId, healthyWorkspaceId]);
    expect(state.pinnedSessionOrder).toEqual([`${unavailableWorkspaceId}:${unavailableSessionId}`]);
    expect(state.notificationPreferences).toEqual({
      backgroundCompletion: false,
      backgroundFailure: true,
      attentionNeeded: false,
    });
    expect(state.integratedTerminalShell).toBe("/bin/zsh");
    expect(state.themePresetId).toBe("github");
    expect(state.sidebarCollapsed).toBe(true);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        scope: "workspace",
        workspacePath: unavailableWorkspacePath,
      }),
    ]);
    await expect(window.getByTestId("startup-diagnostics")).toContainText(
      "unavailable-startup-workspace",
    );

    const afterFailure = JSON.parse(await readFile(uiStatePath, "utf8")) as Record<string, unknown>;
    for (const key of [
      "selectedWorkspaceId",
      "selectedSessionId",
      "composerDraftsBySession",
      "notificationPreferences",
      "integratedTerminalShell",
      "pinnedAtBySession",
      "pinnedSessionOrder",
      "workspaceOrder",
      "themePresetId",
      "sidebarCollapsed",
    ]) {
      expect(afterFailure[key], `persisted key ${key}`).toEqual(beforeFailure[key]);
    }

    const healthySelection = await window.evaluate(async (workspaceId) => {
      const app = globalThis.window.piApp;
      if (!app) {
        throw new Error("piApp IPC bridge is unavailable");
      }
      return app.selectWorkspace(workspaceId);
    }, healthyWorkspaceId);
    expect(healthySelection.selectedWorkspaceId).toBe(healthyWorkspaceId);
    await window.evaluate(
      async ({ workspaceId, sessionId }) => {
        const app = globalThis.window.piApp;
        if (!app) {
          throw new Error("piApp IPC bridge is unavailable");
        }
        await app.selectSession({ workspaceId, sessionId });
      },
      { workspaceId: unavailableWorkspaceId, sessionId: unavailableSessionId },
    );

    const proofDir = process.env.PI_APP_PERSISTENCE_PROOF_DIR?.trim();
    if (proofDir) {
      await mkdir(proofDir, { recursive: true });
      await window.screenshot({
        path: join(proofDir, "unavailable-workspace-recovery.png"),
        fullPage: true,
      });
      await writeFile(
        join(proofDir, "unavailable-workspace-second-launch.json"),
        `${JSON.stringify({ diagnostics, state }, null, 2)}\n`,
        "utf8",
      );
    }
  } finally {
    await secondRun.close();
  }

  const thirdRun = await launchDesktop(userDataDir, { testMode: "background" });
  try {
    const window = await thirdRun.firstWindow();
    const state = await getDesktopState(window);
    expect(state.selectedWorkspaceId).toBe(unavailableWorkspaceId);
    expect(state.selectedSessionId).toBe(unavailableSessionId);
    expect(state.composerDraft).toBe("draft survives unavailable workspace");
    expect(state.workspaces.some((entry) => entry.id === healthyWorkspaceId)).toBe(true);
    await expect(window.getByTestId("startup-diagnostics")).toContainText(
      "unavailable-startup-workspace",
    );

    const proofDir = process.env.PI_APP_PERSISTENCE_PROOF_DIR?.trim();
    if (proofDir) {
      await window.screenshot({
        path: join(proofDir, "unavailable-workspace-third-launch.png"),
        fullPage: true,
      });
    }
  } finally {
    await thirdRun.close();
  }
});

test("migrates legacy inline attachment persistence and drops legacy inline transcripts", async () => {
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
    await expect
      .poll(async () => {
        try {
          return await readFile(join(userDataDir, "ui-state.json"), "utf8");
        } catch {
          return "";
        }
      })
      .toContain("legacy draft");

    const state = await getDesktopState(window);
    workspaceId = state.selectedWorkspaceId;
    sessionId = state.selectedSessionId;
    const { attachmentPath } = persistedSessionDataPaths(userDataDir, {
      workspaceId,
      sessionId,
    });
    await expect
      .poll(async () => {
        try {
          return await readFile(attachmentPath, "utf8");
        } catch {
          return "";
        }
      })
      .toContain('"kind": "image"');
  } finally {
    await firstRun.close();
  }

  const { rawSessionKey, attachmentPath } = persistedSessionDataPaths(userDataDir, {
    workspaceId,
    sessionId,
  });
  const [attachmentRaw, uiStateRaw] = await Promise.all([
    readFile(attachmentPath, "utf8"),
    readFile(join(userDataDir, "ui-state.json"), "utf8"),
  ]);

  const legacyAttachments: unknown = JSON.parse(attachmentRaw);
  const uiState = JSON.parse(uiStateRaw) as Record<string, unknown>;
  await unlink(attachmentPath);
  await writeFile(
    join(userDataDir, "ui-state.json"),
    `${JSON.stringify(
      {
        ...uiState,
        transcripts: {
          [rawSessionKey]: [
            {
              kind: "message",
              id: "legacy-1",
              role: "user",
              text: "legacy text",
              createdAt: new Date().toISOString(),
            },
          ],
        },
        composerAttachmentsBySession: {
          [rawSessionKey]: legacyAttachments,
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
    await expect(window.getByTestId("workspace-list")).toContainText(
      "legacy-persistence-workspace",
    );
    await expect(window.locator(".session-row--active")).toContainText(
      "Legacy persistence session",
    );
    await expect(window.getByTestId("composer")).toHaveValue("legacy draft", { timeout: 15_000 });
    await expect(window.locator(".composer-attachment")).toHaveCount(1);

    const rewrittenUiState = JSON.parse(
      await readFile(join(userDataDir, "ui-state.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(rewrittenUiState.transcripts).toBeUndefined();
    expect(rewrittenUiState.composerAttachmentsBySession).toBeUndefined();
    await expect
      .poll(async () => {
        try {
          return await readFile(attachmentPath, "utf8");
        } catch {
          return "";
        }
      })
      .toContain('"mimeType": "image/png"');
  } finally {
    await secondRun.close();
  }
});

async function readPresentText(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}
