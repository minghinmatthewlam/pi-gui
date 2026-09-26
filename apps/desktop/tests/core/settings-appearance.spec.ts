import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { themePresets, themeTokensFor, type ResolvedTheme } from "../../contracts/theme";
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
  const workspacePath = await makeWorkspace("appearance-theme-preset");
  let harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await openAppearance(window);
    await window.getByRole("radio", { name: "Light", exact: true }).click();
    await selectThemePreset(window, "Catppuccin");
    await expect.poll(async () => (await getDesktopState(window)).themePresetId).toBe("catppuccin");
    await expectDerivedTokens(window, "catppuccin", "light");

    await selectThemePreset(window, "Tokyo Night");
    await window.getByRole("radio", { name: "Dark", exact: true }).click();
    await expect
      .poll(() => window.evaluate(() => document.documentElement.classList.contains("dark")))
      .toBe(true);
    await expectDerivedTokens(window, "tokyo-night", "dark");
    await expect.poll(() => rootCssVariable(window, "--accent")).toBe("#7aa2f7");
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
    await expect.poll(() => rootThemePreset(window)).toBe("tokyo-night");
    await expectDerivedTokens(window, "tokyo-night", "dark");
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

test("every preset recolours the same design instead of restyling it", async () => {
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("appearance-one-design");
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

    for (const variant of ["light", "dark"] as const) {
      for (const preset of themePresets) {
        await openAppearance(window);
        await window
          .getByRole("radio", { name: variant === "light" ? "Light" : "Dark", exact: true })
          .click();
        await selectThemePreset(window, preset.name);
        await expect(window.getByLabel("Color preset")).toHaveValue(preset.id);
        await expectDerivedTokens(window, preset.id, variant);
        await window.getByRole("button", { name: "Back to app" }).click();
        await expect(window.locator(".main")).toBeVisible();
        await expectSameDesign(window);
      }
    }
  } finally {
    await harness.close();
  }
});

async function openAppearance(window: Page): Promise<void> {
  await window.keyboard.press(desktopShortcut(","));
  await expect(window.getByTestId("settings-surface")).toBeVisible();
  await window.getByRole("button", { name: "Appearance", exact: true }).click();
}

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

/** The page's tokens are exactly what the preset's seed derives. */
async function expectDerivedTokens(
  window: Page,
  presetId: (typeof themePresets)[number]["id"],
  variant: ResolvedTheme,
): Promise<void> {
  const expected = themeTokensFor(presetId, variant);
  for (const name of ["--main", "--sidebar", "--surface", "--line", "--muted-icon", "--accent"]) {
    await expect
      .poll(() => rootCssVariable(window, name), name)
      .toBe(expected[name as `--${string}`]);
  }
}

async function resolveColor(window: Page, value: string): Promise<string> {
  return window.evaluate((cssValue) => {
    const probe = document.createElement("div");
    probe.style.backgroundColor = cssValue;
    document.body.append(probe);
    const resolved = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return resolved;
  }, value);
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

/** Each surface reads the same token in every preset, as Default does. */
async function expectSameDesign(window: Page): Promise<void> {
  const surfaces: readonly (readonly [selector: string, property: string, token: string])[] = [
    [".main", "background-color", "var(--main)"],
    [".sidebar", "background-color", "var(--sidebar)"],
    [".topbar", "background-color", "var(--main)"],
    [".sidebar__new", "background-color", "var(--surface)"],
    [".session-row--active", "background-color", "var(--surface)"],
    [".composer__surface", "background-color", "var(--surface)"],
    [".message__content pre", "background-color", "var(--code-block-bg)"],
  ];
  for (const [selector, property, token] of surfaces) {
    await expect
      .poll(() => elementCssProperty(window, selector, property), selector)
      .toBe(await resolveColor(window, token));
  }
}

async function selectThemePreset(window: Page, name: string): Promise<void> {
  await window.getByLabel("Color preset").selectOption({ label: name });
}
