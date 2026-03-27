// IPC bridge access requires inline window.evaluate — see harness.ts for shared helpers
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "@playwright/test";
import { launchDesktop, makeWorkspace, type PiAppWindow } from "./harness";

test("shows skills and settings surfaces from runtime data", async () => {
  test.setTimeout(60_000);
  const userDataDir = await mkdtemp(join(tmpdir(), "pi-gui-user-data-"));
  const workspacePath = await makeWorkspace("skills-settings-workspace");
  await mkdir(join(workspacePath, ".agents", "skills", "demo-skill"), { recursive: true });
  await writeFile(
    join(workspacePath, ".agents", "skills", "demo-skill", "SKILL.md"),
    `# Demo Skill

Use this skill when the user wants a short demo workflow.

## Workflow

1. Inspect the repo.
2. Summarize what changed.
`,
    "utf8",
  );

  const harness = await launchDesktop(userDataDir, [workspacePath]);

  try {
    const window = await harness.firstWindow();
    const workspaceId = await window.evaluate(async () => {
      const app = (window as PiAppWindow).piApp;
      if (!app) throw new Error("piApp IPC bridge is unavailable");
      const state = await app.getState();
      const workspace = state.workspaces[0];
      if (!workspace) throw new Error("Expected workspace");
      await app.createSession({ workspaceId: workspace.id, title: "Skill test session" });
      return workspace.id;
    });

    await window.getByRole("button", { name: "Skills", exact: true }).click();
    await expect(window.locator(".skills-view")).toBeVisible();
    await expect(window.getByTestId("skills-list")).toContainText("Demo Skill");
    await window.getByRole("button", { name: /Demo Skill/i }).click();
    await expect(window.locator(".skill-detail")).toContainText("/skill:demo-skill");

    await window.getByRole("button", { name: "Try", exact: true }).click();
    await expect(window.getByRole("button", { name: "Threads", exact: true })).toBeVisible();
    await expect(window.getByTestId("composer")).toHaveValue("/skill:demo-skill ");

    await window.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(window.locator(".settings-view")).toBeVisible();
    await expect(window.getByText("Notifications", { exact: true })).toBeVisible();
    await expect(window.locator(".settings-view")).toContainText("Enable skill slash commands");
    const skillCommandsToggle = window.getByRole("checkbox", { name: "Enable skill slash commands" });
    await expect(skillCommandsToggle).toBeChecked();
    await skillCommandsToggle.click();

    await window.getByRole("button", { name: "Back to app", exact: true }).click();
    const composer = window.getByTestId("composer");
    await composer.fill("/skill");
    await expect(window.getByTestId("slash-menu")).toHaveCount(0);

    await window.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(skillCommandsToggle).not.toBeChecked();
    await skillCommandsToggle.click();
    await window.getByRole("button", { name: "Back to app", exact: true }).click();
    await composer.fill("/skill");
    const slashMenu = window.getByTestId("slash-menu");
    await expect(slashMenu).toContainText("Runtime Commands");
    await expect(slashMenu).toContainText("Demo Skill");
  } finally {
    await harness.close();
  }
});
