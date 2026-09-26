import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { themePresets, type ResolvedTheme } from "../../contracts/theme";
import {
  chooseReviewScope,
  commitAllInGitRepo,
  createNamedThread,
  desktopShortcut,
  initGitRepo,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedTranscriptMessages,
  selectSidePanel,
  waitForWorkspaceByPath,
  writeTextFile,
} from "../helpers/electron-app";

// Walks every theme preset across the main surfaces (sidebar, New thread,
// timeline, composer, Review, terminal, settings) for screenshots and screen
// recordings. Set PI_APP_THEME_TOUR_DIR to keep screenshots; PI_APP_THEME_TOUR_PACE
// slows it down for video.
const shotDir = process.env.PI_APP_THEME_TOUR_DIR?.trim();
const pace = Number(process.env.PI_APP_THEME_TOUR_PACE ?? "0");

test("tours every theme preset", async () => {
  test.setTimeout(600_000);
  if (shotDir) await mkdir(shotDir, { recursive: true });
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("theme-tour");
  await initGitRepo(workspacePath);
  const source = [
    "export interface Preset {",
    "  readonly id: string;",
    "  readonly accent: string;",
    "}",
    "",
    "export function describe(preset: Preset): string {",
    "  // One seed, every surface.",
    "  return `${preset.id} uses ${preset.accent}`;",
    "}",
    "",
  ].join("\n");
  await writeTextFile(join(workspacePath, "preset.ts"), source);
  await commitAllInGitRepo(workspacePath, "init");
  await writeTextFile(
    join(workspacePath, "preset.ts"),
    source.replace(
      "return `${preset.id} uses ${preset.accent}`;",
      "const count = 42;\n  return `${preset.id} uses ${preset.accent} (${count})`;",
    ),
  );

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "foreground",
  });
  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await createNamedThread(window, "Theme tour");
    await createNamedThread(window, "Seed colours");
    await seedTranscriptMessages(harness, window, {
      count: 2,
      textFactory: (index) =>
        index === 0
          ? "Every preset is a seed. Can you show a snippet with `inline code`?"
          : 'Here is a block:\n\n```ts\nconst preset = { id: "gruvbox", accent: "#458588" };\n```\n\nBorders, icons and buttons all come from the same seed.',
    });
    await window.getByTestId("composer").fill("Check the composer in this theme.");
    await selectSidePanel(window, "Review");
    await chooseReviewScope(window, "Uncommitted");
    await expect(window.locator(".diff-panel")).toContainText("preset.ts");
    await selectSidePanel(window, "Terminal");
    await expect(window.getByTestId("integrated-terminal")).toBeVisible();
    await window.waitForTimeout(1_000);
    await window.keyboard.type(
      "printf '\\033[31mred \\033[32mgreen \\033[33myellow \\033[34mblue \\033[35mmagenta \\033[36mcyan\\033[0m\\n'; git status --short\n",
    );
    await window.waitForTimeout(800);

    for (const variant of ["light", "dark"] as const) {
      for (const preset of themePresets) {
        await setTheme(window, preset.name, variant);
        await selectSidePanel(window, "Review");
        await window
          .locator(".diff-panel")
          .getByText("preset.ts")
          .first()
          .click()
          .catch(() => {});
        await window.locator(".sidebar").hover();
        await shot(window, `${preset.id}-${variant}-review.png`);
        await selectSidePanel(window, "Terminal");
        await shot(window, `${preset.id}-${variant}-terminal.png`);
      }
    }
  } finally {
    await harness.close();
  }
});

async function setTheme(window: Page, presetName: string, variant: ResolvedTheme): Promise<void> {
  // The terminal keeps keystrokes, so move focus to the composer first.
  await window.getByTestId("composer").focus();
  await window.keyboard.press(desktopShortcut(","));
  await expect(window.getByTestId("settings-surface")).toBeVisible();
  await window.getByRole("button", { name: "Appearance", exact: true }).click();
  await window
    .getByRole("radio", { name: variant === "light" ? "Light" : "Dark", exact: true })
    .click();
  await window.getByLabel("Color preset").selectOption({ label: presetName });
  await expect
    .poll(() => window.evaluate(() => document.documentElement.classList.contains("dark")))
    .toBe(variant === "dark");
  await window.waitForTimeout(pace);
  await shot(window, `${presetName.toLowerCase().replace(/\s+/g, "-")}-${variant}-settings.png`);
  await window.getByRole("button", { name: "Back to app" }).click();
  await expect(window.locator(".main")).toBeVisible();
}

async function shot(window: Page, name: string): Promise<void> {
  await window.waitForTimeout(pace || 150);
  if (shotDir) await window.screenshot({ path: join(shotDir, name) });
}
