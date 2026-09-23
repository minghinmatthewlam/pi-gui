import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  desktopShortcut,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
} from "../helpers/electron-app";

test("shows skills and settings surfaces from runtime data", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
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

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Skill test session");

    await window.getByRole("button", { name: "Skills", exact: true }).click();
    await expect(window.getByTestId("skills-surface")).toBeVisible();
    await expect(window.getByTestId("skills-list")).toContainText("Demo Skill");
    await window.getByRole("button", { name: /Demo Skill/i }).click();
    await expect(window.locator(".skill-detail")).toContainText("/skill:demo-skill");

    await window.getByRole("button", { name: "Try", exact: true }).click();
    await expect(window.getByRole("button", { name: "Threads", exact: true })).toBeVisible();
    await expect(window.getByTestId("composer")).toHaveValue("/skill:demo-skill ");

    await window.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(window.locator(".settings-view")).toBeVisible();
    await expect(window.getByText("Notifications", { exact: true })).toBeVisible();
    await expect(window.locator(".settings-view")).toContainText("Skill slash commands");
    const skillCommandsToggle = window.getByRole("switch", {
      name: "Enable skill slash commands",
    });
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

test("skills and extensions live inside settings as one tabbed page", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("skills-in-settings-workspace");
  await mkdir(join(workspacePath, ".agents", "skills", "demo-skill"), { recursive: true });
  await writeFile(
    join(workspacePath, ".agents", "skills", "demo-skill", "SKILL.md"),
    "# Demo Skill\n\nUse this skill when the user wants a short demo workflow.\n",
    "utf8",
  );
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await window.keyboard.press(desktopShortcut(","));
    await expect(window.getByTestId("settings-surface")).toBeVisible();
    await window.getByRole("button", { name: "Skills and extensions", exact: true }).click();

    const surface = window.getByTestId("skills-surface");
    await expect(surface).toBeVisible();
    await expect(surface.getByRole("tab", { name: /Skills/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const list = window.getByTestId("skills-list");
    await expect(list.getByRole("heading", { name: /Workspace/ })).toBeVisible();

    const rowSwitch = list.getByRole("switch", { name: "Enable Demo Skill" });
    await expect(rowSwitch).toBeChecked();
    await rowSwitch.click();
    await expect(rowSwitch).not.toBeChecked();

    const row = list.getByRole("button", { name: /Demo Skill/ });
    await row.click();
    await expect(window.locator(".skill-detail")).toContainText("/skill:demo-skill");
    await expect(window.getByRole("button", { name: "All skills" })).toBeFocused();
    await expect(window.getByRole("switch", { name: "Enabled", exact: true })).not.toBeChecked();
    await window.keyboard.press("Escape");
    await expect(list).toBeVisible();
    await expect(surface).toBeVisible();
    await expect(row).toBeFocused();

    const search = surface.getByLabel("Search skills");
    await search.fill("demo");
    await surface.getByRole("tab", { name: /Skills/ }).focus();
    await window.keyboard.press("ArrowRight");
    const extensionsSurface = window.getByTestId("extensions-surface");
    await expect(extensionsSurface).toBeVisible();
    await expect(extensionsSurface.getByRole("tab", { name: /Extensions/ })).toBeFocused();
    await expect(extensionsSurface.getByLabel("Search extensions")).toHaveValue("");

    await window.getByRole("button", { name: "General", exact: true }).click();
    await expect(window.getByTestId("settings-surface")).toBeVisible();
    await expect(window.locator(".view-header__title")).toHaveText("General");
  } finally {
    await harness.close();
  }
});

test("matches skill slash commands by skill name aliases", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("skills-alias-workspace");
  await mkdir(join(workspacePath, ".agents", "skills", "plan-loop"), { recursive: true });
  await writeFile(
    join(workspacePath, ".agents", "skills", "plan-loop", "SKILL.md"),
    `# Plan Loop

Use this skill for complex or high-risk implementation work that needs plan-first execution.
`,
    "utf8",
  );

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Skill alias session");

    const composer = window.getByTestId("composer");
    const slashMenu = window.getByTestId("slash-menu");

    await composer.fill("/plan");
    await expect(slashMenu).toContainText("Plan Loop");
    await expect(slashMenu).toContainText("/skill:plan-loop");

    await composer.fill("/plan-loop");
    await expect(slashMenu).toContainText("Plan Loop");

    await composer.fill("/skill:plan-loop");
    await expect(slashMenu).toContainText("Plan Loop");
  } finally {
    await harness.close();
  }
});
