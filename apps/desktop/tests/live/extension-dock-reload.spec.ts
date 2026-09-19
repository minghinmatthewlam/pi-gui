import {
  writeProjectExtension,
  createNamedThread,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
} from "../helpers/electron-app";
import { expect, test } from "@playwright/test";

const initialExtensionSource = String.raw`
export default function reloadDockExtension(pi) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus("reload-status", "Session ready");
    ctx.ui.setWidget("reload-widget", ["Initial widget line"]);
  });

  pi.registerCommand("mark-alt", {
    description: "Mark alternate dock content",
    handler: async (_args, ctx) => {
      ctx.ui.setStatus("reload-status", "Alternate status");
      ctx.ui.setWidget("reload-widget", ["Alternate widget line"]);
    },
  });
}
`;

const refreshedExtensionSource = String.raw`
export default function reloadDockExtension(pi) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus("reload-status", "Refreshed session ready");
    ctx.ui.setWidget("reload-widget", ["Refreshed widget line"]);
  });

  pi.registerCommand("mark-alt", {
    description: "Mark alternate dock content",
    handler: async (_args, ctx) => {
      ctx.ui.setStatus("reload-status", "Alternate status");
      ctx.ui.setWidget("reload-widget", ["Alternate widget line"]);
    },
  });
}
`;

test("resets dock expansion on /reload and extension enable or disable transitions", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("extension-dock-reload-workspace");
  await writeProjectExtension(workspacePath, "reload-dock-extension.ts", initialExtensionSource);

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Reload session");

    const composer = window.getByTestId("composer");
    const dockSummary = window.getByTestId("extension-dock-summary");
    const dockToggle = window.getByTestId("extension-dock-toggle");
    const dockBody = window.getByTestId("extension-dock-body");

    await expect(dockSummary).toHaveText("Session ready");
    await dockToggle.click();
    await expect(dockBody).toContainText("Initial widget line");

    await composer.fill("/reload ");
    await composer.press("Enter");
    await expect(dockSummary).toHaveText("Session ready");
    await expect(dockBody).toHaveCount(0);

    await window.getByRole("button", { name: "Extensions", exact: true }).click();
    const extensionCard = window
      .getByTestId("extensions-list")
      .getByRole("button", { name: /reload-dock-extension/i });
    await extensionCard.click();
    await window.getByRole("button", { name: "Disable", exact: true }).click();
    await window.getByRole("button", { name: "Back to app", exact: true }).click();
    await expect(window.getByTestId("extension-dock")).toHaveCount(0);

    await window.getByRole("button", { name: "Extensions", exact: true }).click();
    await extensionCard.click();
    await window.getByRole("button", { name: "Enable", exact: true }).click();
    await window.getByRole("button", { name: "Back to app", exact: true }).click();
    await expect(dockSummary).toHaveText("Session ready");
    await expect(dockBody).toHaveCount(0);
  } finally {
    await harness.close();
  }
});

test("refreshes runtime with new extension output and keeps the dock collapsed after rebuild", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("extension-dock-refresh-workspace");
  await writeProjectExtension(workspacePath, "reload-dock-extension.ts", initialExtensionSource);

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Refresh session");

    const dockSummary = window.getByTestId("extension-dock-summary");
    const dockToggle = window.getByTestId("extension-dock-toggle");
    const dockBody = window.getByTestId("extension-dock-body");

    await expect(dockSummary).toHaveText("Session ready");
    await dockToggle.click();
    await expect(dockBody).toContainText("Initial widget line");

    await writeProjectExtension(
      workspacePath,
      "reload-dock-extension.ts",
      refreshedExtensionSource,
    );
    await window.getByRole("button", { name: "Extensions", exact: true }).click();
    await window.getByRole("button", { name: "Refresh", exact: true }).click();
    await window.getByRole("button", { name: "Back to app", exact: true }).click();

    await expect(dockSummary).toHaveText("Refreshed session ready");
    await expect(dockBody).toHaveCount(0);
    await dockToggle.click();
    await expect(dockBody).toContainText("Refreshed widget line");
  } finally {
    await harness.close();
  }
});
