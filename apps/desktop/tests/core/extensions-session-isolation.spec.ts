import { expect, test } from "@playwright/test";
import {
  clickSession,
  createNamedThread,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  writeProjectExtension,
} from "../helpers/electron-app";

const extensionSource = String.raw`
export default function isolationExtension(pi) {
  pi.registerCommand("mark-ui", {
    description: "Mark the current session with extension UI",
    handler: async (_args, ctx) => {
      ctx.ui.setTitle("Marked by extension");
      ctx.ui.setStatus("mark", "Session marked");
      ctx.ui.setWidget("mark-widget", ["Marked widget"]);
      ctx.ui.setWidget("mark-widget-below", ["Marked below"], { placement: "belowEditor" });
      ctx.ui.notify("Session marked", "info");
    },
  });
}
`;

test("keeps extension widgets, status, and title scoped to the active session", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("extensions-isolation-workspace");
  await writeProjectExtension(workspacePath, "isolation-extension.ts", extensionSource);

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Session A");
    await createNamedThread(window, "Session B");

    await clickSession(window, "Session A");
    const composer = window.getByTestId("composer");
    await composer.fill("/mark-ui ");
    await composer.press("Enter");

    await expect(window.locator(".topbar__session")).toHaveText("Marked by extension");
    await expect(window.getByTestId("extension-dock-summary")).toHaveText("Session marked");
    await window.getByTestId("extension-dock-toggle").click();
    await expect(window.getByTestId("extension-dock-body")).toContainText("Marked widget");
    await expect(window.getByTestId("extension-dock-body")).toContainText("Marked below");

    await clickSession(window, "Session B");
    await expect(window.locator(".topbar__session")).toHaveText("Session B");
    await expect(window.getByTestId("extension-dock")).toHaveCount(0);

    await clickSession(window, "Session A");
    await expect(window.locator(".topbar__session")).toHaveText("Marked by extension");
    await expect(window.getByTestId("extension-dock-summary")).toHaveText("Session marked");
    await expect(window.getByTestId("extension-dock-body")).toContainText("Marked widget");
  } finally {
    await harness.close();
  }
});
