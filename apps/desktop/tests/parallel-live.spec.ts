import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "@playwright/test";
import { getDesktopState, launchDesktop, makeWorkspace, type PiAppWindow } from "./harness";

test("runs two sessions in parallel without sidebar status bleed", async () => {
  test.setTimeout(180_000);
  const userDataDir = await mkdtemp(join(tmpdir(), "pi-app-user-data-"));
  const workspacePath = await makeWorkspace("parallel-workspace");
  const harness = await launchDesktop(userDataDir, [workspacePath]);

  try {
    const window = await harness.firstWindow();
    const workspaceId = await window.evaluate(async () => {
      const app = (window as PiAppWindow).piApp;
      if (!app) throw new Error("piApp unavailable");
      const state = await app.getState();
      const workspace = state.workspaces[0];
      if (!workspace) throw new Error("Expected workspace");
      await app.createSession({ workspaceId: workspace.id, title: "Session A" });
      await app.createSession({ workspaceId: workspace.id, title: "Session B" });
      return workspace.id;
    });

    let sessions:
      | {
          workspaceId: string;
          sessionAId: string;
          sessionBId: string;
        }
      | null = null;

    await expect
      .poll(async () => {
        sessions = await window.evaluate(async (id) => {
          const app = (window as PiAppWindow).piApp;
          if (!app) {
            throw new Error("piApp unavailable");
          }
          const state = await app.getState();
          const workspace = state.workspaces.find((entry) => entry.id === id);
          const sessionA = workspace?.sessions.find((session) => session.title === "Session A");
          const sessionB = workspace?.sessions.find((session) => session.title === "Session B");
          return sessionA && sessionB
            ? {
                workspaceId: id,
                sessionAId: sessionA.id,
                sessionBId: sessionB.id,
              }
            : null;
        }, workspaceId);
        return sessions !== null;
      }, { timeout: 10_000 })
      .toBe(true);

    if (!sessions) {
      throw new Error("Expected both sessions");
    }

    const promptA =
      "Use your bash tool and run `python - <<'PY'\nimport time\nprint(\"A start\")\ntime.sleep(6)\nprint(\"A done\")\nPY` then reply with exactly `A complete`.";
    const promptB =
      "Use your bash tool and run `python - <<'PY'\nimport time\nprint(\"B start\")\ntime.sleep(6)\nprint(\"B done\")\nPY` then reply with exactly `B complete`.";

    await window.evaluate(({ workspaceId, sessionId, prompt }) => {
      const app = (window as PiAppWindow).piApp;
      if (!app) throw new Error("piApp unavailable");
      void app.selectSession({ workspaceId, sessionId }).then(() => app.submitComposer(prompt));
    }, { workspaceId: sessions.workspaceId, sessionId: sessions.sessionAId, prompt: promptA });

    await expect
      .poll(async () => {
        const state = await getDesktopState(window);
        const workspace = state.workspaces.find((entry) => entry.id === sessions.workspaceId);
        return workspace?.sessions.find((session) => session.id === sessions.sessionAId)?.status;
      }, { timeout: 30_000 })
      .toBe("running");

    await window.evaluate(({ workspaceId, sessionId, prompt }) => {
      const app = (window as PiAppWindow).piApp;
      if (!app) throw new Error("piApp unavailable");
      void app.selectSession({ workspaceId, sessionId }).then(() => app.submitComposer(prompt));
    }, { workspaceId: sessions.workspaceId, sessionId: sessions.sessionBId, prompt: promptB });

    await expect
      .poll(async () => {
        const state = await getDesktopState(window);
        const workspace = state.workspaces.find((entry) => entry.id === sessions.workspaceId);
        const sessionA = workspace?.sessions.find((session) => session.id === sessions.sessionAId);
        const sessionB = workspace?.sessions.find((session) => session.id === sessions.sessionBId);
        return {
          selectedSessionId: state.selectedSessionId,
          sessionAStatus: sessionA?.status,
          sessionBStatus: sessionB?.status,
        };
      }, { timeout: 45_000 })
      .toEqual({
        selectedSessionId: sessions.sessionBId,
        sessionAStatus: "running",
        sessionBStatus: "running",
      });

    await expect
      .poll(async () => {
        const state = await getDesktopState(window);
        const workspace = state.workspaces.find((entry) => entry.id === sessions.workspaceId);
        const sessionA = workspace?.sessions.find((session) => session.id === sessions.sessionAId);
        const sessionB = workspace?.sessions.find((session) => session.id === sessions.sessionBId);
        return {
          sessionAStatus: sessionA?.status,
          sessionBStatus: sessionB?.status,
        };
      }, { timeout: 120_000 })
      .toEqual({
        sessionAStatus: "idle",
        sessionBStatus: "idle",
      });

    const result = await window.evaluate(async ({ workspaceId, sessionAId, sessionBId }) => {
      const app = (window as PiAppWindow).piApp;
      if (!app) throw new Error("piApp unavailable");
      const state = await app.getState();
      const workspace = state.workspaces.find((entry) => entry.id === workspaceId);
      const sessionA = workspace?.sessions.find((session) => session.id === sessionAId);
      const sessionB = workspace?.sessions.find((session) => session.id === sessionBId);

      const summarize = (session: (typeof workspace.sessions)[number] | undefined) =>
        (session?.transcript ?? []).map((item) => {
          switch (item.kind) {
            case "message":
              return `${item.role}:${item.text}`;
            case "tool":
            case "activity":
            case "summary":
              return `${item.kind}:${item.label}`;
            default:
              return item.kind;
          }
        });

      return {
        sessionALines: summarize(sessionA),
        sessionBLines: summarize(sessionB),
      };
    }, sessions);

    expect(result.sessionALines.some((line) => line.includes("A complete"))).toBe(true);
    expect(result.sessionBLines.some((line) => line.includes("B complete"))).toBe(true);
    expect(result.sessionALines.some((line) => line.includes("B complete"))).toBe(false);
    expect(result.sessionBLines.some((line) => line.includes("A complete"))).toBe(false);
  } finally {
    await harness.close();
  }
});
