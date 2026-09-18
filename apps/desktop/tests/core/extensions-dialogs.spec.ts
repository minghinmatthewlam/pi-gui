import { expect, test } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createNamedThread,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  writeProjectExtension,
} from "../helpers/electron-app";

const extensionSource = String.raw`
export default function dialogExtension(pi) {
  pi.registerCommand("dialog-confirm", {
    description: "Open a confirmation dialog",
    handler: async (_args, ctx) => {
      const confirmed = await ctx.ui.confirm("Confirm change?", "Approve this change.");
      ctx.ui.notify(confirmed ? "Confirm accepted" : "Confirm rejected", "info");
    },
  });

  pi.registerCommand("dialog-confirm-timeout", {
    description: "Open a confirmation dialog that times out",
    handler: async (_args, ctx) => {
      const confirmed = await ctx.ui.confirm("Timeout confirm?", "This should close itself.", { timeout: 100 });
      ctx.ui.notify(confirmed ? "Timeout accepted" : "Timeout rejected", "info");
    },
  });

  pi.registerCommand("dialog-select", {
    description: "Open a select dialog",
    handler: async (_args, ctx) => {
      const value = await ctx.ui.select("Pick an option", ["Alpha", "Beta"]);
      ctx.ui.notify(value ? "Selected " + value : "Select cancelled", "info");
    },
  });

  pi.registerCommand("dialog-input", {
    description: "Open an input dialog",
    handler: async (_args, ctx) => {
      const value = await ctx.ui.input("Enter a value", "type here");
      ctx.ui.notify(value ? "Input " + value : "Input cancelled", "info");
    },
  });

  pi.registerCommand("dialog-editor", {
    description: "Open an editor dialog",
    handler: async (_args, ctx) => {
      const value = await ctx.ui.editor("Edit note", "Line 1");
      ctx.ui.notify(value ? "Editor lines " + value.split("\n").length : "Editor cancelled", "info");
    },
  });
}
`;

const dialogPromptingExtensionSource = String.raw`
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";

const dragTool = defineTool({
  name: "drag",
  label: "Drag",
  description: "Drag to a screen position",
  parameters: Type.Object({
    x: Type.Number(),
    y: Type.Number(),
  }),
  async execute(_toolCallId, params) {
    return {
      content: [{ type: "text", text: "drag " + params.x + "," + params.y }],
    };
  },
});

export default function dialogPromptingExtension(pi) {
  pi.registerTool(dragTool);

  pi.on("session_start", async (_event, ctx) => {
    await ctx.ui.select("Grant permissions", ["Open System Settings"]);
  });

  pi.registerCommand("package-extension-smoke", {
    description: "Confirm the packaged extension loaded",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Package command ready", "info");
    },
  });
}
`;

async function installDialogPromptingPackage(agentDir: string, packagePath: string): Promise<void> {
  const extensionDir = join(packagePath, "extensions");
  await mkdir(extensionDir, { recursive: true });
  await writeFile(
    join(packagePath, "package.json"),
    `${JSON.stringify(
      {
        name: "pi-sample-extension",
        type: "module",
        pi: {
          extensions: ["./extensions/sample.ts"],
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(join(extensionDir, "sample.ts"), `${dialogPromptingExtensionSource}\n`, "utf8");

  const settingsPath = join(agentDir, "settings.json");
  const settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
  settings.packages = [packagePath];
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

test("renders extension dialogs in the Electron surface and routes responses back to the session", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("extensions-dialogs-workspace");
  await writeProjectExtension(workspacePath, "dialog-extension.ts", extensionSource);

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Dialog session");

    const composer = window.getByTestId("composer");

    await composer.fill("/dialog-confirm ");
    await composer.press("Enter");
    const dialog = window.getByTestId("extension-dialog");
    await expect(window.getByRole("dialog", { name: "Confirm change?" })).toBeVisible();
    await expect(dialog).toContainText("Confirm change?");
    await expect(dialog).toContainText("Approve this change.");
    await expect(dialog.getByTestId("extension-dialog-cancel")).toBeFocused();
    await dialog.getByTestId("extension-dialog-cancel").press("Shift+Tab");
    await expect(dialog.getByTestId("extension-dialog-confirm")).toBeFocused();
    await dialog.getByTestId("extension-dialog-confirm").press("Tab");
    await expect(dialog.getByTestId("extension-dialog-cancel")).toBeFocused();
    await dialog.getByTestId("extension-dialog-confirm").click();
    await expect(dialog).toHaveCount(0);
    await expect(window.locator(".timeline")).toContainText("Confirm accepted");

    await composer.fill("/dialog-confirm-timeout ");
    await composer.press("Enter");
    await expect(window.getByRole("dialog", { name: "Timeout confirm?" })).toBeVisible();
    await expect(dialog).toContainText("This should close itself.");
    await expect(dialog).toHaveCount(0, { timeout: 5_000 });
    await expect(window.locator(".timeline")).toContainText("Timeout rejected");

    await composer.fill("/dialog-select ");
    await composer.press("Enter");
    await expect(dialog).toContainText("Pick an option");
    await expect(dialog.getByRole("button", { name: "Alpha", exact: true })).toBeFocused();
    await dialog.getByRole("button", { name: "Alpha", exact: true }).press("Tab");
    await expect(dialog.getByRole("button", { name: "Beta", exact: true })).toBeFocused();
    await dialog.getByRole("button", { name: "Beta", exact: true }).press("Tab");
    await expect(dialog.getByTestId("extension-dialog-cancel")).toBeFocused();
    await dialog.getByTestId("extension-dialog-cancel").press("Tab");
    await expect(dialog.getByRole("button", { name: "Alpha", exact: true })).toBeFocused();
    await dialog.getByRole("button", { name: "Alpha", exact: true }).press("Tab");
    await expect(dialog.getByRole("button", { name: "Beta", exact: true })).toBeFocused();
    await dialog.getByRole("button", { name: "Beta", exact: true }).press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(window.locator(".timeline")).toContainText("Selected Beta");

    await composer.fill("/dialog-input ");
    await composer.press("Enter");
    await expect(dialog).toContainText("Enter a value");
    await dialog.getByPlaceholder("type here").fill("typed value");
    await dialog.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(window.locator(".timeline")).toContainText("Input typed value");

    await composer.fill("/dialog-editor ");
    await composer.press("Enter");
    await expect(dialog).toContainText("Edit note");
    const editor = dialog.locator("textarea");
    await editor.click();
    await editor.press("Meta+A");
    await editor.press("Backspace");
    await editor.type("Line 1");
    await editor.press("Enter");
    await editor.type("Line 2");
    await expect(editor).toHaveValue("Line 1\nLine 2");
    await dialog.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(window.locator(".timeline")).toContainText("Editor lines 2");
  } finally {
    await harness.close();
  }
});

test("loads a dialog-prompting third-party package without blocking session startup", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("package-extension-workspace");
  const packagePath = await makeWorkspace("pi-sample-extension-package");
  const agentDir = join(userDataDir, "agent");
  await seedAgentDir(agentDir);
  await installDialogPromptingPackage(agentDir, packagePath);

  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Package extension session");
    await expect(window.getByTestId("extension-dialog")).toHaveCount(0);

    const composer = window.getByTestId("composer");
    await composer.fill("/package-extension-smoke ");
    await composer.press("Enter");
    await expect(window.locator(".timeline")).toContainText("Package command ready");
  } finally {
    await harness.close();
  }
});
