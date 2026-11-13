import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  selectSession,
} from "../helpers/electron-app";

/**
 * A session pi itself wrote: one turn whose answer carries the reasoning that produced it.
 * Reopening it is the same path as an app restart, so the thinking view has to survive it.
 */
async function seedThinkingSession(
  agentDir: string,
  workspacePath: string,
): Promise<{ readonly sessionId: string; readonly title: string }> {
  const { SessionManager } = (await import("@earendil-works/pi-coding-agent")) as {
    SessionManager: {
      create(cwd: string): {
        appendMessage(message: unknown): string;
        appendModelChange(provider: string, modelId: string): string;
        appendSessionInfo(name: string): string;
        getSessionId(): string;
      };
    };
  };

  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const sessionManager = SessionManager.create(workspacePath);
    const timestamp = Date.parse("2026-11-13T10:00:00.000Z");
    sessionManager.appendModelChange("openai", "gpt-5");
    sessionManager.appendMessage({
      role: "user",
      content: "Why does the parser drop the trailing token?",
      timestamp,
    });
    sessionManager.appendMessage({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "The lexer stops one token early on purpose." },
        { type: "text", text: "The lexer stops before the trailing token." },
      ],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: timestamp + 1_000,
    });
    sessionManager.appendSessionInfo("Thinking fixture session");
    return { sessionId: sessionManager.getSessionId(), title: "Thinking fixture session" };
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
}

test("the thinking view is opt-in per app and shows the saved reasoning on demand", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("thinking-view-workspace");
  await seedAgentDir(agentDir);
  const seeded = await seedThinkingSession(agentDir, workspacePath);

  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await selectSession(window, seeded.title);

    const transcript = window.getByTestId("transcript");
    await expect(transcript).toContainText("The lexer stops before the trailing token.");
    // Off by default: the answer reads clean, with no reasoning row at all.
    await expect(transcript.getByTestId("timeline-thinking")).toHaveCount(0);

    await window.getByRole("button", { name: "Settings", exact: true }).click();
    await window.getByRole("button", { name: "General", exact: true }).click();
    const thinkingToggle = window.getByRole("switch", { name: "Enable thinking view" });
    await expect(thinkingToggle).not.toBeChecked();
    await thinkingToggle.click();
    await expect(thinkingToggle).toBeChecked();
    await window.getByRole("button", { name: "Back to app", exact: true }).click();

    const thinking = transcript.getByTestId("timeline-thinking");
    await expect(thinking).toHaveCount(1);
    await expect(thinking).toContainText("Thinking");
    // Collapsed: the reasoning stays out of the way until it is asked for.
    await expect(transcript.getByTestId("timeline-thinking-body")).toHaveCount(0);
    await expect(transcript).toContainText("The lexer stops before the trailing token.");

    await thinking.getByTestId("timeline-thinking-toggle").click();
    await expect(transcript.getByTestId("timeline-thinking-body")).toHaveText(
      "The lexer stops one token early on purpose.",
    );
    await expect(transcript).toContainText("The lexer stops before the trailing token.");

    await thinking.getByTestId("timeline-thinking-toggle").click();
    await expect(transcript.getByTestId("timeline-thinking-body")).toHaveCount(0);

    // The choice is an app setting, so it survives a relaunch with the same profile.
    await harness.close();
    const relaunched = await launchDesktop(userDataDir, {
      agentDir,
      initialWorkspaces: [workspacePath],
      testMode: "background",
    });
    try {
      const reopened = await relaunched.firstWindow();
      await selectSession(reopened, seeded.title);
      await expect(reopened.getByTestId("transcript").getByTestId("timeline-thinking")).toHaveCount(
        1,
      );
      expect(seeded.sessionId).not.toBe("");
    } finally {
      await relaunched.close();
    }
  } finally {
    await harness.close().catch(() => undefined);
  }
});
