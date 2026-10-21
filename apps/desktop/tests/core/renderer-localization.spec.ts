import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { translatorFor } from "../../src/i18n/translate";
import {
  desktopShortcut,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
} from "../helpers/electron-app";

async function chooseLanguage(window: Page, locale: "zh-CN" | "ja") {
  await window.keyboard.press(desktopShortcut(","));
  await window.getByRole("button", { name: /^(Appearance|外观|外観)$/ }).click();
  await window.getByRole("combobox", { name: /^(Language|语言|言語)$/ }).selectOption(locale);
  await expect(window.locator("html")).toHaveAttribute("lang", locale);
}

for (const locale of ["zh-CN", "ja"] as const) {
  const t = translatorFor(locale);
  test(`${locale} translates the complete Models, Providers, custom endpoint and MCP forms`, async () => {
    const userDataDir = await makeUserDataDir();
    const workspacePath = await makeWorkspace("localized-settings");
    const agentDir = join(userDataDir, "agent");
    await seedAgentDir(agentDir, { withDefaultModel: false });
    const harness = await launchDesktop(userDataDir, {
      initialWorkspaces: [workspacePath],
      agentDir,
      // Exercise the visible application without test hooks, using fixture credentials only.
      envOverrides: { PI_APP_TEST_MODE: undefined },
    });
    try {
      const window = await harness.firstWindow();
      await chooseLanguage(window, locale);
      const surface = window.getByTestId("settings-surface");
      await window.getByRole("button", { name: t("settings.nav.models"), exact: true }).click();
      await expect(
        surface.getByRole("combobox", { name: t("ui.defaultModel"), exact: true }),
      ).toBeVisible();
      await expect(
        surface.getByRole("combobox", { name: t("ui.reasoning"), exact: true }),
      ).toBeVisible();
      await expect(surface).toContainText(t("ui.onlyEnabledModelsAppearInModelPickers"));
      await expect(surface.getByTestId("settings-model-list")).toContainText("GPT-5");
      await expect(surface).not.toContainText("Default model");
      await expect(surface).not.toContainText("Enabled models");
      await window.screenshot({ path: test.info().outputPath(`models-${locale}.png`) });

      await window.getByRole("button", { name: t("settings.nav.providers"), exact: true }).click();
      await expect(surface).toContainText(t("ui.piPicksModelsFromConnectedProvidersFirst"));
      await expect(surface.getByRole("searchbox", { name: t("ui.searchProviders") })).toBeVisible();
      await expect(surface).not.toContainText("Custom endpoints");
      await expect(surface).toContainText("OpenAI");
      await window.screenshot({ path: test.info().outputPath(`providers-${locale}.png`) });
      await surface.getByRole("button", { name: t("ui.addEndpoint"), exact: true }).click();
      const dialog = window.getByTestId("custom-endpoint-dialog");
      await expect(dialog).toBeVisible();
      await dialog.getByLabel(t("ui.providerID"), { exact: true }).fill("local-models");
      await expect(dialog).toContainText(
        t("ui.lowercaseLettersDigitsAndDashesCannotBeChangedLater"),
      );
      await dialog.getByLabel(t("ui.baseURL"), { exact: true }).fill("http://127.0.0.1:11434/v1");
      await expect(dialog.getByLabel(t("ui.baseURL"), { exact: true })).toHaveValue(
        "http://127.0.0.1:11434/v1",
      );
      await expect(
        dialog.getByRole("button", { name: t("ui.detectModels"), exact: true }),
      ).toBeVisible();
      await expect(dialog).not.toContainText("Save changes");
      await window.screenshot({ path: test.info().outputPath(`endpoint-${locale}.png`) });
      await dialog.getByRole("button", { name: t("common.cancel"), exact: true }).click();

      await window.getByRole("button", { name: t("settings.nav.mcp"), exact: true }).click();
      await expect(surface.getByTestId("mcp-servers-empty")).toContainText(
        locale === "zh-CN" ? "暂无 MCP 服务器" : "MCP サーバーはまだありません",
      );
      await expect(surface.getByLabel(t("ui.serverName"), { exact: true })).toBeVisible();
      await expect(surface.getByLabel(t("ui.serverDescription"), { exact: true })).toHaveAttribute(
        "placeholder",
        t("ui.searchesTheTeamSDocs"),
      );
      await expect(surface.getByLabel(t("ui.serverCommand"), { exact: true })).toHaveAttribute(
        "placeholder",
        "npx",
      );
      await expect(
        surface.getByRole("button", { name: t("ui.command"), exact: true }),
      ).toBeVisible();
      await expect(surface).toContainText(t("ui.codeMode"));
      await expect(surface).not.toContainText("Always on");
      await expect(surface).not.toContainText("Add server");
      await window.screenshot({ path: test.info().outputPath(`mcp-${locale}.png`) });
    } finally {
      await harness.close();
    }
  });

  test(`${locale} translates Skills and New thread without translating skill descriptions or drafts`, async () => {
    const userDataDir = await makeUserDataDir();
    const workspacePath = await makeWorkspace("localized-workspace");
    const agentDir = join(userDataDir, "agent");
    await seedAgentDir(agentDir, { withDefaultModel: false });
    const skillDir = join(workspacePath, ".agents", "skills", "locale-demo");
    await mkdir(skillDir, { recursive: true });
    const skill =
      "---\nname: locale-demo\ndescription: Keep this English description and /skill:locale-demo unchanged.\n---\n# Locale demo\n";
    await writeFile(join(skillDir, "SKILL.md"), skill, "utf8");
    const harness = await launchDesktop(userDataDir, {
      initialWorkspaces: [workspacePath],
      agentDir,
      envOverrides: { PI_APP_TEST_MODE: undefined },
    });
    try {
      const window = await harness.firstWindow();
      await chooseLanguage(window, locale);
      await window.getByRole("button", { name: t("settings.nav.customize"), exact: true }).click();
      const surface = window.getByTestId("skills-surface");
      await expect(surface).toBeVisible();
      await expect(
        surface.getByRole("button", { name: t("ui.newSkill"), exact: true }),
      ).toBeVisible();
      await expect(
        surface.getByRole("searchbox", { name: t("resources.skillsSearch"), exact: true }),
      ).toBeVisible();
      await expect(surface.getByTestId("skills-list")).toContainText(
        "Keep this English description",
      );
      await expect(surface).not.toContainText("Skills and extensions");
      await expect(surface).not.toContainText("New skill");
      await window.screenshot({ path: test.info().outputPath(`skills-${locale}.png`) });
      await window.keyboard.press("Escape");
      await window
        .locator("#primary-sidebar")
        .getByRole("button", { name: t("topbar.newThread"), exact: true })
        .click();
      const draft = window.getByTestId("new-thread-composer");
      await expect(draft).toHaveAttribute(
        "placeholder",
        t("ui.askPiAnythingUseForCommandsAndSkills"),
      );
      await expect(window.getByTestId("model-onboarding-notice")).toContainText(
        t("models.noDefault"),
      );
      await expect(window.getByRole("button", { name: t("ui.local"), exact: true })).toBeVisible();
      await draft.fill("Keep this English draft / 日本語 / 中文");
      await expect(draft).toHaveValue("Keep this English draft / 日本語 / 中文");
      await expect(window.getByTestId("model-onboarding-notice")).not.toContainText(
        "No default model set",
      );
      await window.screenshot({ path: test.info().outputPath(`new-thread-${locale}.png`) });
      expect(await readFile(join(skillDir, "SKILL.md"), "utf8")).toBe(skill);
    } finally {
      await harness.close();
    }
  });
}
