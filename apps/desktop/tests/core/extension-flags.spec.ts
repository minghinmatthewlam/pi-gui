import { expect, test, type Page } from "@playwright/test";
import {
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  openNewThread,
  writeProjectExtension,
} from "../helpers/electron-app";

// Reads its flags the way terminal extensions do: pi.getFlag after the session loads.
const flagsExtension = String.raw`
export default function flagsExtension(pi) {
  pi.registerFlag("plan", { type: "boolean", default: false, description: "Plan without editing files" });
  pi.registerFlag("dry-run", { type: "boolean", default: false, description: "Print commands only" });
  pi.registerFlag("env", { type: "string", description: "Target environment" });
  pi.registerFlag("color", { type: "boolean", default: true, description: "Colored output" });
  pi.registerCommand("flags-report", {
    description: "Show the flags this thread started with",
    handler: async (_args, ctx) => {
      const report = ["plan", "dry-run", "env"]
        .map((name) => name + "=" + String(pi.getFlag(name)))
        .join(" ");
      ctx.ui.setStatus("flags", report);
    },
  });
}
`;

async function startReportThread(window: Page) {
  const composer = window.getByTestId("new-thread-composer");
  await composer.fill("/flags-report ");
  await composer.press("Enter");
  await expect(window.getByTestId("composer")).toBeVisible({ timeout: 15_000 });
}

async function reportInThread(window: Page) {
  const composer = window.getByTestId("composer");
  await composer.fill("/flags-report ");
  await composer.press("Enter");
}

test("new threads start with the chosen extension flags, remembered per workspace and after relaunch", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("extension-flags-workspace");
  await writeProjectExtension(workspacePath, "flags-extension.ts", flagsExtension);

  const firstRun = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await firstRun.firstWindow();
    await openNewThread(window);
    const badge = window.getByTestId("extension-flags-badge");
    await expect(badge).toHaveText("Flags");

    await badge.click();
    const dropdown = window.getByTestId("extension-flags-dropdown");
    await expect(dropdown).toContainText("flags-extension");
    // pi can only switch a boolean on, so a flag that defaults to on is shown on and locked.
    await expect(dropdown.getByLabel("--color")).toBeChecked();
    await expect(dropdown.getByLabel("--color")).toBeDisabled();
    await dropdown.getByLabel("--plan").check();
    await dropdown.getByLabel("--dry-run").check();
    await dropdown.getByLabel("--dry-run").uncheck();
    await dropdown.getByLabel("--env").fill("staging");
    await expect(badge).toHaveText("Flags · 2");

    await startReportThread(window);
    await expect(window.getByTestId("extension-dock-summary")).toHaveText(
      "plan=true dry-run=false env=staging",
    );
    await expect(window.getByTestId("extension-flags-session-badge")).toHaveText("Flags · 2");

    // The next new thread starts from the same choices; a switch turned off stays off.
    await openNewThread(window);
    await expect(badge).toHaveText("Flags · 2");
    await badge.click();
    await expect(dropdown.getByLabel("--plan")).toBeChecked();
    await expect(dropdown.getByLabel("--dry-run")).not.toBeChecked();
    await expect(dropdown.getByLabel("--env")).toHaveValue("staging");
    await dropdown.getByLabel("--plan").uncheck();
    await expect(badge).toHaveText("Flags · 1");

    await startReportThread(window);
    await expect(window.getByTestId("extension-dock-summary")).toHaveText(
      "plan=false dry-run=false env=staging",
    );
    await expect(window.getByTestId("extension-flags-session-badge")).toHaveText("Flags · 1");

    await openNewThread(window);
    await expect(badge).toHaveText("Flags · 1");
    await badge.click();
    await expect(dropdown.getByLabel("--plan")).not.toBeChecked();
  } finally {
    await firstRun.close();
  }

  // After a relaunch the thread's pi session reopens with the flags it started with.
  const secondRun = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await secondRun.firstWindow();
    await window.locator(".session-row__select").first().click();
    await expect(window.getByTestId("extension-flags-session-badge")).toHaveText("Flags · 1");
    await reportInThread(window);
    await expect(window.getByTestId("extension-dock-summary")).toHaveText(
      "plan=false dry-run=false env=staging",
    );
  } finally {
    await secondRun.close();
  }
});
