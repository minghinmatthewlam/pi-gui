import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  createNamedThread,
  desktopShortcut,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  selectSidePanel,
} from "../helpers/electron-app";

async function chooseLanguage(window: Page, locale: "en" | "zh-CN" | "ja") {
  await window.keyboard.press(desktopShortcut(","));
  await window.getByRole("button", { name: /^(Appearance|外观|外観)$/ }).click();
  await window.getByRole("combobox", { name: /^(Language|语言|言語)$/ }).selectOption(locale);
  await expect(window.locator("html")).toHaveAttribute("lang", locale);
  await window.keyboard.press("Escape");
  await expect(window.getByTestId("settings-surface")).toHaveCount(0);
}

const languages = [
  {
    locale: "zh-CN",
    explorer: "文件浏览器",
    refresh: "刷新",
    close: (name: string) => `关闭 ${name}`,
    source: "查看源代码",
    path: "文件路径",
    filter: "筛选文件",
    noMatches: "没有匹配的文件",
    binary: "无法预览二进制文件或目录。",
    copy: "复制文件",
  },
  {
    locale: "ja",
    explorer: "ファイルエクスプローラー",
    refresh: "更新",
    close: (name: string) => `${name} を閉じる`,
    source: "ソースを表示",
    path: "ファイルパス",
    filter: "ファイルを絞り込む",
    noMatches: "一致するファイルはありません",
    binary: "バイナリファイルやディレクトリはプレビューできません。",
    copy: "ファイルをコピー",
  },
] as const;

for (const language of languages) {
  test(`Files preserves content and restores the ${language.locale} locale`, async () => {
    const userDataDir = await makeUserDataDir();
    const workspacePath = await makeWorkspace("files-i18n");
    const name = "View source 中文.md";
    const content = "# View source\n\nFilter files / 打开 / {name}\n";
    await writeFile(join(workspacePath, name), content, "utf8");
    const options = { initialWorkspaces: [workspacePath], testMode: "background" as const };
    let harness = await launchDesktop(userDataDir, options);
    try {
      const window = await harness.firstWindow();
      await chooseLanguage(window, "en");
      await createNamedThread(window, "Files language regression");
      await selectSidePanel(window, "Files");
      // Leave room for the long Unicode filename beside the preview actions.
      await window.getByRole("separator", { name: "Side panel width", exact: true }).press("End");
      await expect(window.getByLabel("File explorer", { exact: true })).toBeVisible();
      await expect(window.getByTestId("file-editor")).toContainText(
        "Select a file from the explorer.",
      );
      await window.getByRole("button", { name, exact: true }).click();
      await window.getByRole("button", { name: "View source", exact: true }).click();
      await expect(window.getByTestId("file-workbench-preview")).toContainText(
        "Filter files / 打开 / {name}",
      );
      await window.getByTestId("composer").fill("Filter files / 用户草稿");

      await chooseLanguage(window, language.locale);
      const explorer = window.getByLabel(language.explorer, { exact: true });
      await expect(explorer).toBeVisible();
      await expect(
        explorer.getByRole("button", { name: language.refresh, exact: true }),
      ).toBeVisible();
      await expect(
        window.getByRole("button", { name: language.close(name), exact: true }),
      ).toBeVisible();
      await expect(
        window.getByRole("button", { name: language.source, exact: true }),
      ).toBeVisible();
      await expect(window.getByLabel(language.path, { exact: true })).toContainText(name);
      await expect(window.getByTestId("file-workbench-preview")).toContainText(
        "Filter files / 打开 / {name}",
      );
      await expect(window.getByTestId("composer")).toHaveValue("Filter files / 用户草稿");
      await explorer.getByRole("searchbox", { name: language.filter }).fill("no-such-file-unique");
      await expect(explorer).toContainText(language.noMatches);
      await explorer.getByRole("searchbox", { name: language.filter }).fill("");
      await expect(explorer.getByRole("button", { name, exact: true })).toBeVisible();
      await window.screenshot({ path: test.info().outputPath(`files-${language.locale}.png`) });
      expect(await readFile(join(workspacePath, name), "utf8")).toBe(content);
    } finally {
      await harness.close();
    }

    harness = await launchDesktop(userDataDir, options);
    try {
      const window = await harness.firstWindow();
      await expect(window.locator("html")).toHaveAttribute("lang", language.locale);
      await expect(window.getByLabel(language.explorer, { exact: true })).toBeVisible();
      await expect(window.getByTestId("composer")).toHaveValue("Filter files / 用户草稿");
      await chooseLanguage(window, "en");
      await expect(window.getByLabel("File explorer", { exact: true })).toBeVisible();
      await expect(
        window.getByRole("button", { name: `Close ${name}`, exact: true }),
      ).toBeVisible();
      await expect(window.getByTestId("file-workbench-preview")).toContainText(
        "Filter files / 打开 / {name}",
      );
      await window.getByRole("button", { name: `Close ${name}`, exact: true }).click();
      await expect(window.getByTestId("file-editor")).toContainText(
        "Select a file from the explorer.",
      );
    } finally {
      await harness.close();
    }
  });

  test(`Files shows the ${language.locale} binary preview state`, async () => {
    const userDataDir = await makeUserDataDir();
    const workspacePath = await makeWorkspace("files-i18n-binary");
    await writeFile(join(workspacePath, "sample.bin"), Buffer.from([0, 1, 2, 3]));
    const harness = await launchDesktop(userDataDir, {
      initialWorkspaces: [workspacePath],
      testMode: "background",
    });
    try {
      const window = await harness.firstWindow();
      await chooseLanguage(window, "en");
      await createNamedThread(window, "Binary preview language");
      await selectSidePanel(window, "Files");
      await chooseLanguage(window, language.locale);
      await window.getByRole("button", { name: "sample.bin", exact: true }).click();
      await expect(window.getByTestId("file-editor")).toContainText(language.binary);
      await expect(window.getByRole("button", { name: language.copy, exact: true })).toBeDisabled();
    } finally {
      await harness.close();
    }
  });
}
