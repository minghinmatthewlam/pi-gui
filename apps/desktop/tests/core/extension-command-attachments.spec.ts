import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  pasteTinyPng,
  writeProjectExtension,
} from "../helpers/electron-app";

const pingExtensionSource = String.raw`
export default function pingExtension(pi) {
  pi.registerCommand("ping", {
    description: "Say pong",
    handler: async (_args, ctx) => {
      ctx.ui.notify("pong", "info");
    },
  });
}
`;

// pi runs a typed extension command and ignores attached images, so the command must not use
// them up: they stay in the composer, and no message bubble appears (pi saves none, so one would
// vanish on restart).
test("a typed extension command keeps attachments and adds no message to the thread", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("extension-command-attachments");
  await writeProjectExtension(workspacePath, "ping.ts", pingExtensionSource);

  const firstRun = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await firstRun.firstWindow();
    await createNamedThread(window, "Ping thread");
    // Until the thread's commands load, "/ping" is not known to be an extension command.
    await expect
      .poll(async () => {
        const state = await getDesktopState(window);
        const key = `${state.selectedWorkspaceId}:${state.selectedSessionId}`;
        return state.sessionCommandsBySession[key]?.some((command) => command.name === "ping");
      })
      .toBe(true);
    const composer = window.getByTestId("composer");
    const chips = window.locator(".composer-attachment--image");
    await pasteTinyPng(window);
    await expect(chips).toHaveCount(1);

    await composer.fill("/ping ");
    await composer.press("Enter");
    await expect(window.getByTestId("extension-notice")).toHaveText(["pong"]);
    await expect(composer).toHaveValue("");
    await expect
      .poll(async () => (await getDesktopState(window)).composerAttachments.length)
      .toBe(1);
    await expect(chips).toHaveCount(1);
    await expect.poll(async () => (await getDesktopState(window)).composerDraft).toBe("");
    await expect(window.locator(".timeline")).not.toContainText("/ping");
  } finally {
    await firstRun.close();
  }

  const secondRun = await launchDesktop(userDataDir, { testMode: "background" });
  try {
    const window = await secondRun.firstWindow();
    await expect(window.locator(".composer-attachment--image")).toHaveCount(1);
    await expect(window.getByTestId("composer")).toHaveValue("");
  } finally {
    await secondRun.close();
  }
});
