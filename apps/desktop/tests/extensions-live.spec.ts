import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "@playwright/test";
import { assertExists, createSession, getDesktopState, launchDesktop, makeWorkspace, writeProjectExtension } from "./harness";

const extensionSource = String.raw`
export default function demoExtension(pi) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setTitle("Extension Surface");
    ctx.ui.setStatus("demo-status", "Demo ready");
    ctx.ui.setWidget("demo-widget", ["Demo widget line"]);
    ctx.ui.setWidget("demo-widget-below", ["Below widget line"], { placement: "belowEditor" });
  });

  pi.registerCommand("settings", {
    description: "Runtime settings command",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Runtime settings command", "info");
    },
  });

  pi.registerCommand("prefill-demo", {
    description: "Prefill the composer",
    handler: async (_args, ctx) => {
      ctx.ui.setEditorText("Prefilled from extension");
      ctx.ui.notify("Composer prefilled", "info");
    },
  });
}
`;

test("manages extensions and prefers runtime commands over colliding host actions", async () => {
  test.setTimeout(60_000);
  const userDataDir = await mkdtemp(join(tmpdir(), "pi-gui-user-data-"));
  const workspacePath = await makeWorkspace("extensions-workspace");
  await writeProjectExtension(workspacePath, "demo-extension.ts", extensionSource);

  const harness = await launchDesktop(userDataDir, [workspacePath]);

  try {
    const window = await harness.firstWindow();
    const state = await getDesktopState(window);
    const workspace = state.workspaces[0];
    assertExists(workspace, "Expected workspace");
    await createSession(window, workspace.id, "Extension session");

    await expect(window.locator(".topbar__session")).toHaveText("Extension Surface");
    await expect(window.getByTestId("extension-status-strip")).toContainText("Demo ready");
    await expect(window.locator(".extension-widget-card").filter({ hasText: "Demo widget line" })).toBeVisible();
    await expect(window.locator(".extension-widget-card").filter({ hasText: "Below widget line" })).toBeVisible();

    await window.getByRole("button", { name: "Extensions", exact: true }).click();
    await expect(window.getByTestId("extensions-surface")).toBeVisible();
    const extensionsList = window.getByTestId("extensions-list");
    const extensionCard = extensionsList.getByRole("button", { name: /demo-extension/i });
    await expect(extensionCard).toBeVisible();
    await extensionCard.click();
    await expect(window.locator(".skill-detail")).toContainText("settings");
    await expect(window.locator(".skill-detail")).toContainText("prefill-demo");

    await window.getByRole("button", { name: "Disable", exact: true }).click();
    await expect(window.locator(".skill-detail__status")).toHaveText("Disabled");
    await window.getByRole("button", { name: "Back to app", exact: true }).click();
    await expect(window.locator(".topbar__session")).toHaveText("Extension session");
    await expect(window.getByTestId("extension-status-strip")).toHaveCount(0);
    await expect(window.locator(".extension-widget-card")).toHaveCount(0);
    const composer = window.getByTestId("composer");
    await composer.fill("/settings");
    const disabledSlashMenu = window.getByTestId("slash-menu");
    await expect(disabledSlashMenu).toContainText("Host Actions");
    await disabledSlashMenu.getByRole("button", { name: /settings/i }).click();
    await expect(window.getByTestId("settings-surface")).toBeVisible();
    await window.getByRole("button", { name: "Back to app", exact: true }).click();

    await window.getByRole("button", { name: "Extensions", exact: true }).click();
    await extensionCard.click();
    await window.getByRole("button", { name: "Enable", exact: true }).click();
    await expect(window.locator(".skill-detail__status")).toHaveText("Enabled");
    await window.getByRole("button", { name: "Back to app", exact: true }).click();
    await expect(window.locator(".topbar__session")).toHaveText("Extension Surface");
    await expect(window.getByTestId("extension-status-strip")).toContainText("Demo ready");

    await composer.fill("/settings");
    const slashMenu = window.getByTestId("slash-menu");
    await expect(slashMenu).toContainText("Runtime Commands");
    await expect(slashMenu).toContainText("Host Actions");

    await composer.fill("/settings ");
    await composer.press("Enter");
    await expect(window.getByTestId("settings-surface")).toHaveCount(0);
    await expect(window.locator(".timeline")).toContainText("Runtime settings command");

    await composer.fill("/prefill-demo ");
    await composer.press("Enter");
    await expect(composer).toHaveValue("Prefilled from extension");
    await expect(window.locator(".timeline")).toContainText("Composer prefilled");
  } finally {
    await harness.close();
  }
});
