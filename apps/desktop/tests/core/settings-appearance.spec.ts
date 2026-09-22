import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page, type Video } from "@playwright/test";
import { themePresets } from "../../src/features/settings/theme-presets";
import {
  createNamedThread,
  desktopShortcut,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedTranscriptMessages,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

const controlledLightTokenNames = [
  "--theme-selection-bg",
  "--theme-selection-border",
  "--theme-control-bg",
  "--theme-control-border",
  "--theme-code-bg",
  "--theme-code-border",
  "--theme-bubble-bg",
  "--theme-bubble-border",
] as const;

const pageLightTokenNames = [
  "--window",
  "--sidebar",
  "--main",
  "--surface",
  "--surface-muted",
  "--line",
  "--text",
  "--muted",
] as const;

test("toggles and restores window transparency", async () => {
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("appearance-transparency");
  let harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await expect.poll(() => hasTransparencyClass(window)).toBe(false);

    await window.keyboard.press(desktopShortcut(","));
    await expect(window.getByTestId("settings-surface")).toBeVisible();
    await window.getByRole("button", { name: "Appearance", exact: true }).click();

    const transparencyToggle = window.getByLabel("Window transparency");
    await expect(transparencyToggle).not.toBeChecked();
    await transparencyToggle.click();
    await expect.poll(async () => (await getDesktopState(window)).enableTransparency).toBe(true);
    await expect.poll(() => hasTransparencyClass(window)).toBe(true);
    await expect
      .poll(async () => {
        const persisted = JSON.parse(
          await readFile(join(userDataDir, "ui-state.json"), "utf8"),
        ) as {
          readonly enableTransparency?: unknown;
        };
        return persisted.enableTransparency;
      })
      .toBe(true);
  } finally {
    await harness.close();
  }

  harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await expect.poll(async () => (await getDesktopState(window)).enableTransparency).toBe(true);
    await expect.poll(() => hasTransparencyClass(window)).toBe(true);
  } finally {
    await harness.close();
  }
});

test("selects and restores theme presets", async () => {
  const userDataDir = await makeUserDataDir();
  const proofDir = process.env.PI_APP_THEME_PRESET_PROOF_DIR?.trim();
  if (proofDir) {
    await mkdir(proofDir, { recursive: true });
  }
  const workspacePath = await makeWorkspace("appearance-theme-preset");
  let harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
    ...(proofDir
      ? {
          recordVideoDir: proofDir,
          recordVideoSize: { width: 1480, height: 980 },
        }
      : {}),
  });
  let video: Video | null = null;

  try {
    const window = await harness.firstWindow();
    video = window.video();
    await waitForWorkspaceByPath(window, workspacePath);
    await createNamedThread(window, "Theme proof thread");
    await seedTranscriptMessages(harness, window, {
      count: 2,
      textFactory: (index) =>
        index === 0
          ? 'Theme surface proof with `inline code` and a small block:\n\n```ts\nconst preset = "visible";\n```'
          : "Controlled surfaces should show the selected row, composer border, code accents, and message bubble treatment.",
    });
    await expect(window.getByTestId("transcript")).toContainText("inline code");
    await window.getByTestId("composer").fill("Review the visible theme treatment.");

    await window.keyboard.press(desktopShortcut(","));
    await expect(window.getByTestId("settings-surface")).toBeVisible();
    await window.getByRole("button", { name: "Appearance", exact: true }).click();
    await window
      .locator(".settings-row", { hasText: "Light" })
      .locator('input[type="radio"]')
      .click();
    await selectThemePreset(window, "Default");
    await expect(window.locator(".view-header__title")).toHaveText("Appearance");
    await window.getByRole("button", { name: "Back to app" }).click();
    await expect(window.locator(".main")).toBeVisible();
    await saveProofScreenshot(window, proofDir, "16-app-surface-default-light-workbench.png");

    await window.keyboard.press(desktopShortcut(","));
    await expect(window.getByTestId("settings-surface")).toBeVisible();
    await window.getByRole("button", { name: "Appearance", exact: true }).click();
    await selectThemePreset(window, "Catppuccin");
    await expect.poll(async () => (await getDesktopState(window)).themePresetId).toBe("catppuccin");
    await expect.poll(() => rootInlineCssVariable(window, "--main")).toBe("#f1ecf8");
    await expect.poll(() => rootInlineCssVariable(window, "--sidebar")).toBe("#ded5ed");
    await expect.poll(() => rootInlineCssVariable(window, "--theme-selection-bg")).toBe("#e8dcff");
    await window.getByRole("button", { name: "Back to app" }).click();
    await expect(window.locator(".main")).toBeVisible();
    await expectThemedAppSurface(window);
    await saveProofScreenshot(window, proofDir, "17-app-surface-catppuccin-workbench-light.png");

    await window.keyboard.press(desktopShortcut(","));
    await expect(window.getByTestId("settings-surface")).toBeVisible();
    await window.getByRole("button", { name: "Appearance", exact: true }).click();
    await selectThemePreset(window, "Gruvbox");
    await expect.poll(async () => (await getDesktopState(window)).themePresetId).toBe("gruvbox");
    await expect.poll(() => rootInlineCssVariable(window, "--main")).toBe("#f3e8cf");
    await expect.poll(() => rootInlineCssVariable(window, "--sidebar")).toBe("#dfc99f");
    await expect.poll(() => rootInlineCssVariable(window, "--theme-selection-bg")).toBe("#ebd29a");
    await expect
      .poll(() => rootInlineCssVariable(window, "--theme-control-border"))
      .toBe("#b58a43");
    await window.getByRole("button", { name: "Back to app" }).click();
    await expect(window.locator(".main")).toBeVisible();
    await expectThemedAppSurface(window);
    await saveProofScreenshot(window, proofDir, "18-app-surface-gruvbox-workbench-light.png");

    await window.keyboard.press(desktopShortcut(","));
    await expect(window.getByTestId("settings-surface")).toBeVisible();
    await window.getByRole("button", { name: "Appearance", exact: true }).click();
    await selectThemePreset(window, "Tokyo Night");
    await expect
      .poll(async () => (await getDesktopState(window)).themePresetId)
      .toBe("tokyo-night");
    await expect.poll(() => rootThemePreset(window)).toBe("tokyo-night");
    await expect.poll(() => rootCssVariable(window, "--accent")).toBe("#34548a");
    await expect.poll(() => rootInlineCssVariable(window, "--main")).toBe("#eef3fb");
    await expect.poll(() => rootInlineCssVariable(window, "--sidebar")).toBe("#d6deef");
    await expect.poll(() => rootInlineCssVariable(window, "--theme-selection-bg")).toBe("#dbe8ff");
    await expect
      .poll(() => rootInlineCssVariable(window, "--theme-control-border"))
      .toBe("#98b7e5");
    await window.getByRole("button", { name: "Back to app" }).click();
    await expect(window.locator(".main")).toBeVisible();
    await expectThemedAppSurface(window);
    await saveProofScreenshot(window, proofDir, "19-app-surface-tokyo-workbench-light.png");

    await window.keyboard.press(desktopShortcut(","));
    await expect(window.getByTestId("settings-surface")).toBeVisible();
    await window.getByRole("button", { name: "Appearance", exact: true }).click();
    await window
      .locator(".settings-row", { hasText: "Dark" })
      .locator('input[type="radio"]')
      .click();
    await expect
      .poll(() => window.evaluate(() => document.documentElement.classList.contains("dark")))
      .toBe(true);
    await expect.poll(() => rootCssVariable(window, "--accent")).toBe("#7aa2f7");

    await window.getByRole("button", { name: "Back to app" }).click();
    await expect(window.locator(".main")).toBeVisible();
    await expectThemedAppSurface(window);
    await saveProofScreenshot(window, proofDir, "20-app-surface-tokyo-workbench-dark.png");

    await window.keyboard.press(desktopShortcut(","));
    await expect(window.getByTestId("settings-surface")).toBeVisible();
    await window.getByRole("button", { name: "Appearance", exact: true }).click();
    await saveProofScreenshot(window, proofDir, "21-appearance-theme-presets-workbench.png");
  } finally {
    await harness.close();
    await saveProofVideo(video, proofDir, "workbench-theme-switch-flow.webm");
  }

  harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await expect
      .poll(async () => (await getDesktopState(window)).themePresetId)
      .toBe("tokyo-night");
    await expect.poll(async () => (await getDesktopState(window)).themeMode).toBe("dark");
    await expect.poll(() => rootThemePreset(window)).toBe("tokyo-night");
    await expect.poll(() => rootCssVariable(window, "--accent")).toBe("#7aa2f7");
    await expect
      .poll(async () => {
        const persisted = JSON.parse(
          await readFile(join(userDataDir, "ui-state.json"), "utf8"),
        ) as {
          readonly themeMode?: unknown;
          readonly themePresetId?: unknown;
        };
        return `${persisted.themeMode}:${persisted.themePresetId}`;
      })
      .toBe("dark:tokyo-night");
  } finally {
    await harness.close();
  }
});

test("light theme presets apply coordinated workbench palettes", async () => {
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("appearance-light-restraint");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await createNamedThread(window, "Preset assertion thread");
    await seedTranscriptMessages(harness, window, {
      count: 1,
      textFactory: () =>
        'Preset assertion surface with `inline code`.\n\n```ts\nconst surface = "workbench";\n```',
    });
    await expect(window.getByTestId("transcript")).toContainText("inline code");

    await window.keyboard.press(desktopShortcut(","));
    await expect(window.getByTestId("settings-surface")).toBeVisible();
    await window.getByRole("button", { name: "Appearance", exact: true }).click();
    await window
      .locator(".settings-row", { hasText: "Light" })
      .locator('input[type="radio"]')
      .click();
    await expect
      .poll(() => window.evaluate(() => document.documentElement.classList.contains("dark")))
      .toBe(false);

    const baseline = await rootComputedCssVariables(window, pageLightTokenNames);
    const paletteSignatures = new Set<string>();
    for (const preset of themePresets) {
      if (preset.id === "default") {
        continue;
      }
      await selectThemePreset(window, preset.name);
      await expect.poll(() => rootThemePreset(window)).toBe(preset.id);

      const pageTokens = await rootInlineCssVariables(window, pageLightTokenNames);
      const controlledTokens = await rootInlineCssVariables(window, controlledLightTokenNames);
      expect(pageTokens.every((value) => value.length > 0)).toBe(true);
      expect(controlledTokens.every((value) => value.length > 0)).toBe(true);
      expect(
        new Set([pageTokens[1], pageTokens[2], pageTokens[3], controlledTokens[4]]).size,
      ).toBeGreaterThan(1);
      paletteSignatures.add([...pageTokens, ...controlledTokens].join("|"));
      await expect
        .poll(() => rootComputedCssVariables(window, pageLightTokenNames))
        .not.toEqual(baseline);

      const activeCardBg = await elementCssProperty(
        window,
        ".theme-preset-card--active",
        "background-color",
      );
      await expect
        .poll(() => rootCssVariableAsColor(window, "--theme-selection-bg"))
        .toBe(activeCardBg);
    }
    expect(paletteSignatures.size).toBe(themePresets.length - 1);

    await selectThemePreset(window, "Gruvbox");
    await window.getByRole("button", { name: "Back to app" }).click();
    await expect(window.locator(".main")).toBeVisible();
    await expectThemedAppSurface(window);
  } finally {
    await harness.close();
  }
});

async function hasTransparencyClass(window: Page): Promise<boolean> {
  return window.evaluate(() => document.documentElement.classList.contains("enable-transparency"));
}

async function rootThemePreset(window: Page): Promise<string | undefined> {
  return window.evaluate(() => document.documentElement.dataset.themePreset);
}

async function rootCssVariable(window: Page, name: string): Promise<string> {
  return window.evaluate(
    (tokenName) => getComputedStyle(document.documentElement).getPropertyValue(tokenName).trim(),
    name,
  );
}

async function rootInlineCssVariable(window: Page, name: string): Promise<string> {
  return window.evaluate(
    (tokenName) => document.documentElement.style.getPropertyValue(tokenName).trim(),
    name,
  );
}

async function rootInlineCssVariables(
  window: Page,
  names: readonly string[],
): Promise<readonly string[]> {
  return window.evaluate(
    (tokenNames) =>
      tokenNames.map((tokenName) =>
        document.documentElement.style.getPropertyValue(tokenName).trim(),
      ),
    [...names],
  );
}

async function rootComputedCssVariables(
  window: Page,
  names: readonly string[],
): Promise<readonly string[]> {
  return window.evaluate(
    (tokenNames) =>
      tokenNames.map((tokenName) =>
        getComputedStyle(document.documentElement).getPropertyValue(tokenName).trim(),
      ),
    [...names],
  );
}

async function rootCssVariableAsColor(window: Page, name: string): Promise<string> {
  return window.evaluate((tokenName) => {
    const value = getComputedStyle(document.documentElement).getPropertyValue(tokenName).trim();
    const probe = document.createElement("div");
    probe.style.backgroundColor = value;
    document.body.append(probe);
    const resolved = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return resolved;
  }, name);
}

async function elementCssProperty(
  window: Page,
  selector: string,
  property: string,
): Promise<string> {
  return window.evaluate(
    ({ targetSelector, targetProperty }) => {
      const element = document.querySelector<HTMLElement>(targetSelector);
      if (!element) {
        throw new Error(`Missing element for selector ${targetSelector}`);
      }
      return getComputedStyle(element).getPropertyValue(targetProperty).trim();
    },
    { targetSelector: selector, targetProperty: property },
  );
}

async function expectControlledAppSurface(
  window: Page,
  selectionTokenName: string,
  controlBorderTokenName: string,
): Promise<void> {
  const selectedRowBackground = await elementCssProperty(
    window,
    ".session-row--active",
    "background-color",
  );
  await expect
    .poll(() => rootCssVariableAsColor(window, selectionTokenName))
    .toBe(selectedRowBackground);

  const composerBorder = await elementCssProperty(window, ".composer__surface", "border-top-color");
  await expect
    .poll(() => rootCssVariableAsColor(window, controlBorderTokenName))
    .toBe(composerBorder);
}

async function expectThemedAppSurface(window: Page): Promise<void> {
  const mainBackground = await elementCssProperty(window, ".main", "background-color");
  await expect.poll(() => rootCssVariableAsColor(window, "--main")).toBe(mainBackground);

  const sidebarBackground = await elementCssProperty(window, ".sidebar", "background-color");
  await expect.poll(() => rootCssVariableAsColor(window, "--sidebar")).toBe(sidebarBackground);

  // The compact task header shares the conversation surface.
  const topbarBackground = await elementCssProperty(window, ".topbar", "background-color");
  await expect.poll(() => rootCssVariableAsColor(window, "--main")).toBe(topbarBackground);

  const codeBlockBackground = await elementCssProperty(
    window,
    ".message__content pre",
    "background-color",
  );
  await expect
    .poll(() => rootCssVariableAsColor(window, "--theme-code-bg"))
    .toBe(codeBlockBackground);

  await expectControlledAppSurface(window, "--theme-selection-bg", "--theme-control-border");
}

async function selectThemePreset(window: Page, name: string): Promise<void> {
  await window.locator(".theme-preset-card", { hasText: name }).click();
}

async function saveProofScreenshot(
  window: Page,
  proofDir: string | undefined,
  fileName: string,
): Promise<void> {
  if (!proofDir) {
    return;
  }
  await window.screenshot({ path: join(proofDir, fileName), fullPage: true });
}

async function saveProofVideo(
  video: Video | null,
  proofDir: string | undefined,
  fileName: string,
): Promise<void> {
  if (!proofDir || !video) {
    return;
  }
  await video.saveAs(join(proofDir, fileName));
}
