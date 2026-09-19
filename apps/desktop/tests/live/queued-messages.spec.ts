import { expect, test } from "@playwright/test";
import {
  desktopShortcut,
  getDesktopState,
  getRealAuthConfig,
  getSelectedTranscript,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
} from "../helpers/electron-app";

function assistantMessages(
  transcript: Awaited<ReturnType<typeof getSelectedTranscript>>,
): string[] {
  return (transcript?.transcript ?? [])
    .filter(
      (item): item is Extract<typeof item, { kind: "message" }> =>
        item.kind === "message" && item.role === "assistant",
    )
    .map((item) => item.text.trim());
}

test("queues follow-ups with Enter and steers the current run with Cmd+Enter", async () => {
  test.setTimeout(240_000);
  const realAuth = getRealAuthConfig();
  test.skip(!realAuth.enabled, realAuth.skipReason);

  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("queued-messages-live");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
    realAuthSourceDir: realAuth.sourceDir,
  });

  try {
    const window = await harness.firstWindow();

    await window.getByRole("complementary").getByRole("button", { name: "New thread" }).click();
    await window
      .getByLabel("New thread prompt")
      .fill(
        'Use your bash or shell tool to run `python - <<\'PY\'\nimport time\nprint("queue-start")\ntime.sleep(8)\nprint("queue-end")\nPY` and, after the tool call, reply with exactly BASELINE_DONE.',
      );
    await window.getByRole("button", { name: "Start thread" }).click();

    await expect
      .poll(
        async () => {
          const state = await getDesktopState(window);
          return state.workspaces[0]?.sessions[0]?.status ?? "";
        },
        { timeout: 60_000 },
      )
      .toBe("running");

    const composer = window.getByTestId("composer");
    const sendButton = window.getByTestId("send");
    await expect(sendButton).toHaveAttribute("aria-label", "Stop run");

    await composer.fill("After the current run fully finishes, reply with exactly FOLLOW_UP_DONE.");
    await expect(sendButton).toHaveAttribute("aria-label", "Send message");
    await composer.press("Enter");
    await expect(sendButton).toHaveAttribute("aria-label", "Stop run");
    await expect(
      window.getByTestId("queued-composer-message").filter({ hasText: "FOLLOW_UP_DONE" }),
    ).toHaveCount(1);
    await expect(window.locator(".queued-composer-message__mode")).toHaveCount(0);

    await composer.fill(
      "Change your pending final answer for the current run to exactly STEER_DONE.",
    );
    await expect(sendButton).toHaveAttribute("aria-label", "Send message");
    await composer.press(desktopShortcut("Enter"));
    await expect(
      window.getByTestId("queued-composer-message").filter({ hasText: "STEER_DONE" }),
    ).toHaveCount(0);
    await expect(window.getByTestId("transcript")).toContainText("STEER_DONE");

    await expect(window.getByTestId("transcript")).toContainText("STEER_DONE", {
      timeout: 180_000,
    });
    await expect(window.getByTestId("transcript")).toContainText("FOLLOW_UP_DONE", {
      timeout: 180_000,
    });

    await expect
      .poll(
        async () => {
          const messages = assistantMessages(await getSelectedTranscript(window));
          const steerIndex = messages.findIndex((message) => message.includes("STEER_DONE"));
          const followUpIndex = messages.findIndex((message) => message.includes("FOLLOW_UP_DONE"));
          return {
            messages,
            hasSteer: steerIndex >= 0,
            hasFollowUpAfterSteer: followUpIndex > steerIndex,
          };
        },
        { timeout: 180_000 },
      )
      .toMatchObject({
        hasSteer: true,
        hasFollowUpAfterSteer: true,
      });

    const finalAssistantText = assistantMessages(await getSelectedTranscript(window)).join("\n");
    const steerPosition = finalAssistantText.indexOf("STEER_DONE");
    const followUpPosition = finalAssistantText.indexOf("FOLLOW_UP_DONE");
    expect(steerPosition).toBeGreaterThanOrEqual(0);
    expect(followUpPosition).toBeGreaterThan(steerPosition);
    expect(finalAssistantText.includes("BASELINE_DONE")).toBe(false);

    await expect
      .poll(
        async () => {
          const state = await getDesktopState(window);
          return state.workspaces[0]?.sessions[0]?.status ?? "";
        },
        { timeout: 180_000 },
      )
      .toBe("idle");
    await expect(window.getByTestId("queued-composer-messages")).toHaveCount(0);
  } finally {
    await harness.close();
  }
});
