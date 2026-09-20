import { expect, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  initGitRepo,
  commitAllInGitRepo,
  writeProjectExtension,
} from "../../../../apps/desktop/tests/helpers/electron-app";

export async function prepareMaintenanceWorkspace(workspace: string) {
  const skill = join(workspace, ".agents", "skills", "demo-skill");
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, "SKILL.md"), "# Demo Skill\n\nSummarize the current repository.\n");
  await writeProjectExtension(
    workspace,
    "maintenance-dock.ts",
    `export default function(pi) {
    pi.on("session_start", async (_event, ctx) => {
      ctx.ui.setStatus("maintenance", "Maintenance ready");
      ctx.ui.setWidget("maintenance", ["Maintenance widget"]);
    });
  }`,
  );
  await initGitRepo(workspace);
  await commitAllInGitRepo(workspace, "Seed maintenance workspace");
}

export async function driveMaintenanceFeatures(
  page: Page,
  workspace: string,
  checkpoint: (name: string) => Promise<void>,
) {
  const composer = page.getByTestId("composer");
  await expect(page.getByTestId("extension-dock-summary")).toHaveText("Maintenance ready");
  await page.getByTestId("extension-dock-toggle").click();
  await expect(page.getByTestId("extension-dock-body")).toContainText("Maintenance widget");
  await composer.fill("/reload ");
  await composer.press("Enter");
  await expect(page.getByTestId("transcript")).toContainText("Reloaded session resources");
  await expect(page.getByTestId("extension-dock-summary")).toHaveText("Maintenance ready");
  await expect(page.getByTestId("extension-dock-body")).toHaveCount(0);
  await checkpoint("maintenance-extension-dock");
  await page.getByRole("button", { name: "Skills", exact: true }).click();
  await expect(page.getByTestId("skills-list")).toContainText("Demo Skill");
  await page.getByRole("button", { name: /Demo Skill/i }).click();
  await expect(page.locator(".skill-detail")).toContainText("/skill:demo-skill");
  await page.getByRole("button", { name: "Try", exact: true }).click();
  await expect(composer).toHaveValue("/skill:demo-skill ");
  await checkpoint("maintenance-skills");
  await composer.fill("");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "General", exact: true }).click();
  const toggle = page.getByRole("checkbox", { name: "Enable skill slash commands" });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await page.getByRole("button", { name: "Back to app", exact: true }).click();
  await composer.fill("/skill");
  await expect(page.getByTestId("slash-menu")).toHaveCount(0);
  await composer.fill("");
  await checkpoint("maintenance-settings");

  await page
    .getByRole("complementary")
    .getByRole("button", { name: "New thread", exact: true })
    .click();
  await page
    .getByLabel("New thread prompt", { exact: true })
    .fill(
      "Use the bash tool to run exactly `echo queue-start; sleep 20; echo queue-end`. After the tool finishes, reply with exactly BASELINE_DONE.",
    );
  await page.getByRole("button", { name: "Start thread", exact: true }).click();
  await expect(page.locator(".timeline-tool")).not.toHaveCount(0, { timeout: 90_000 });
  const active = page.locator(".session-row--active");
  await expect(active).toHaveAttribute("data-sidebar-indicator", "running");
  await active.hover();
  await active.getByLabel(/^Pin /).click();
  await expect(active.getByLabel(/^Unpin /)).toBeVisible();
  await expect(active).toHaveAttribute("data-sidebar-indicator", "running");
  await active.getByLabel(/^Unpin /).click();
  await expect(active.getByLabel(/^Pin /)).toBeVisible();
  await expect(active).toHaveAttribute("data-sidebar-indicator", "running");
  await checkpoint("maintenance-pin-running");
  await composer.fill("After the current run fully finishes, reply with exactly FOLLOW_UP_DONE.");
  await composer.press("Enter");
  await expect(
    page.getByTestId("queued-composer-message").filter({ hasText: "FOLLOW_UP_DONE" }),
  ).toHaveCount(1);
  await composer.fill(
    "Change your pending final answer for the current run to exactly STEER_DONE.",
  );
  await composer.press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");
  const assistants = page.locator(".timeline-item--assistant .message__content");
  await expect(assistants.filter({ hasText: "STEER_DONE" })).toHaveCount(1, { timeout: 120_000 });
  await expect(assistants.filter({ hasText: "FOLLOW_UP_DONE" })).toHaveCount(1, {
    timeout: 120_000,
  });
  const messages = await assistants.allTextContents();
  const steerIndex = messages.findIndex((text) => text.includes("STEER_DONE"));
  const followUpIndex = messages.findIndex((text) => text.includes("FOLLOW_UP_DONE"));
  expect(followUpIndex).toBeGreaterThan(steerIndex);
  expect(messages.join("\n")).not.toContain("BASELINE_DONE");
  await expect(page.getByTestId("queued-composer-messages")).toHaveCount(0);
  await expect(active).not.toHaveAttribute("data-sidebar-indicator", "running");
  await checkpoint("maintenance-follow-ups");

  const state = await page.evaluate(() => window.piApp!.getState());
  const root = state.workspaces.find((entry) => entry.path === workspace)!;
  expect(root).toBeTruthy();
  await page
    .getByRole("button", { name: `Workspace actions for ${root.name}`, exact: true })
    .click();
  await page.getByRole("button", { name: "Create permanent worktree", exact: true }).click();
  await expect
    .poll(async () => {
      const next = await page.evaluate(() => window.piApp!.getState());
      return next.workspaces.find((entry) => entry.id === next.selectedWorkspaceId)?.kind;
    })
    .toBe("worktree");
  const next = await page.evaluate(() => window.piApp!.getState());
  const created = next.workspaces.find((entry) => entry.id === next.selectedWorkspaceId)!;
  expect(
    execFileSync("git", ["-C", workspace, "worktree", "list", "--porcelain"], { encoding: "utf8" }),
  ).toContain(created.path);
  await page
    .getByRole("complementary")
    .getByRole("button", { name: "New thread", exact: true })
    .click();
  await expect(page.getByRole("button", { name: "Local", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Worktree", exact: true })).toBeVisible();
  await checkpoint("maintenance-worktrees");
}
