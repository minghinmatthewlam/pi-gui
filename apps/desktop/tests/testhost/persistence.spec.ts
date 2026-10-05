// Copied from tests/core/persistence.spec.ts to prove the Rust kernel through pi-gui-testhost. Keep the
// copy in step with the Electron spec until that spec runs on the test host itself.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  createSessionViaIpc,
  getDesktopState,
  makeUserDataDir,
  makeWorkspace,
  selectSession,
  writeProjectExtension,
} from "../helpers/electron-app";
import { appendMessagesToSessionFile, sessionFilePathFromCatalog } from "../helpers/session-file";
import { launchTestHost } from "../helpers/testhost";

test("recovers persisted ui state from the backup when ui-state.json is corrupt", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("corruption-recovery-workspace");

  const firstRun = await launchTestHost(userDataDir, {
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

  const secondRun = await launchTestHost(userDataDir, { testMode: "background" });
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

  const firstRun = await launchTestHost(userDataDir, {
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

  const secondRun = await launchTestHost(userDataDir, { testMode: "background" });
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
  const repairedRun = await launchTestHost(userDataDir, { testMode: "background" });
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
