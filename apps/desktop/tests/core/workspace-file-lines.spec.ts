import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Locator } from "@playwright/test";
import {
  type DesktopHarness,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  seedNamedTextSessionFixture,
  selectSession,
  selectSidePanel,
} from "../helpers/electron-app";

const SESSION_TITLE = "File line fixture session";

function assistantMessage(workspacePath: string): string {
  return [
    "See src/app.ts:3 for the marker.",
    "Inline `src/app.ts:10-20` covers a range.",
    "[Implementation](src/app.ts#L3) uses a hash.",
    "Column [notes](notes.md:2:4).",
    `Absolute ${workspacePath}/src/app.ts:3 is in this workspace.`,
    "Outside /etc/hosts:1 stays plain.",
    "Missing missing.ts:2 is absent.",
    "Ignored secret.txt:1 is gitignored.",
    "Long src/long.ts:350 sits far down.",
    "Tree nested/file-79.txt:1 is the last row.",
    "Web [Docs](https://example.com/docs) and [email fallback](mailto:test@example.com).",
    "",
    "```",
    "src/app.ts:3",
    "```",
    "",
  ].join("\n");
}

async function captureOpenedExternalUrls(
  harness: DesktopHarness,
): Promise<() => Promise<readonly string[]>> {
  await harness.electronApp.evaluate(({ shell }) => {
    const globals = globalThis as typeof globalThis & { __piGuiOpenedExternalUrls?: string[] };
    globals.__piGuiOpenedExternalUrls = [];
    shell.openExternal = async (url: string) => {
      globals.__piGuiOpenedExternalUrls?.push(url);
    };
  });
  return () =>
    harness.electronApp.evaluate(
      () =>
        (globalThis as typeof globalThis & { __piGuiOpenedExternalUrls?: string[] })
          .__piGuiOpenedExternalUrls ?? [],
    );
}

function fileButton(assistant: Locator, name: string): Locator {
  return assistant.getByRole("button", { name, exact: true });
}

async function expectBoxInside(inner: Locator, outer: Locator): Promise<void> {
  const innerBox = await inner.boundingBox();
  const outerBox = await outer.boundingBox();
  expect(innerBox).not.toBeNull();
  expect(outerBox).not.toBeNull();
  if (!innerBox || !outerBox) {
    return;
  }
  expect(innerBox.y).toBeGreaterThanOrEqual(outerBox.y - 2);
  expect(innerBox.y + innerBox.height).toBeLessThanOrEqual(outerBox.y + outerBox.height + 2);
}

test("assistant file lines open in the Files panel and web links stay external", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("file-line-workspace");
  await mkdir(join(workspacePath, "src"), { recursive: true });
  await mkdir(join(workspacePath, "nested"), { recursive: true });
  const appLines = Array.from({ length: 25 }, (_, index) => {
    const line = index + 1;
    if (line === 3 || line === 10 || line === 20) {
      return `marker-${line}`;
    }
    return `app line ${line}`;
  });
  await writeFile(join(workspacePath, "src", "app.ts"), `${appLines.join("\n")}\n`, "utf8");
  const longLines = Array.from({ length: 400 }, (_, index) =>
    index + 1 === 350 ? "marker-350" : `long line ${index + 1}`,
  );
  await writeFile(join(workspacePath, "src", "long.ts"), `${longLines.join("\n")}\n`, "utf8");
  await writeFile(
    join(workspacePath, "notes.md"),
    "# Title\nLine two is here\nLine three\n",
    "utf8",
  );
  await writeFile(join(workspacePath, ".gitignore"), "secret.txt\n", "utf8");
  await writeFile(join(workspacePath, "secret.txt"), "ignored secret line\n", "utf8");
  await Promise.all(
    Array.from({ length: 80 }, (_, index) =>
      writeFile(
        join(workspacePath, "nested", `file-${String(index).padStart(2, "0")}.txt`),
        `nested ${index}\n`,
        "utf8",
      ),
    ),
  );
  await seedAgentDir(agentDir);
  await seedNamedTextSessionFixture(agentDir, workspacePath, {
    title: SESSION_TITLE,
    userText: "Please open src/app.ts:3",
    assistantText: assistantMessage(workspacePath),
  });

  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await selectSession(window, SESSION_TITLE);
    const appUrl = window.url();
    const openedExternalUrls = await captureOpenedExternalUrls(harness);
    const assistant = window.locator(".timeline-item--assistant");
    const user = window.locator(".timeline-item--user");

    await expect(user).toContainText("src/app.ts:3");
    await expect(user.getByTestId("workspace-file-link")).toHaveCount(0);
    await expect(assistant.locator("pre").getByTestId("workspace-file-link")).toHaveCount(0);
    await expect(assistant.locator("pre")).toContainText("src/app.ts:3");
    await expect(fileButton(assistant, "/etc/hosts:1")).toHaveCount(0);
    await expect(assistant).toContainText("/etc/hosts:1");

    await assistant.getByRole("link", { name: "Docs" }).click();
    await expect.poll(openedExternalUrls).toEqual(["https://example.com/docs"]);
    expect(window.url()).toBe(appUrl);
    await expect(window.getByTestId("file-workbench")).toHaveCount(0);

    await selectSidePanel(window, "Changes");
    await expect(window.locator(".diff-panel")).toBeVisible();
    await fileButton(assistant, "missing.ts:2").click();
    await expect(window.locator(".diff-panel")).toBeVisible();
    await expect(window.getByTestId("file-workbench")).toHaveCount(0);

    await fileButton(assistant, "src/app.ts:3").click();
    await expect(window.getByTestId("file-workbench")).toBeVisible();
    await expect(window.locator(".diff-panel")).toHaveCount(0);
    const appRow = window.locator('.file-workbench__tree-row--file[data-file-path="src/app.ts"]');
    await expect(appRow).toBeVisible();
    await expect(appRow).toHaveClass(/file-workbench__tree-row--selected/);
    const lineThree = window.locator('[data-testid="file-line-mark"][data-line="3"]');
    await expect(lineThree).toHaveCount(1);
    await expect(lineThree).toContainText("marker-3");

    await appRow.click();
    await expect(window.getByTestId("file-line-mark")).toHaveCount(0);
    await expect(window.getByTestId("file-workbench-preview")).toContainText("marker-3");

    await fileButton(assistant, "src/app.ts:10-20").click();
    const range = window.getByTestId("file-line-mark");
    await expect(range).toHaveCount(11);
    await expect(range.first()).toHaveAttribute("data-line", "10");
    await expect(range.last()).toHaveAttribute("data-line", "20");
    await expect(range.first()).toContainText("marker-10");
    await expect(range.last()).toContainText("marker-20");

    await fileButton(assistant, "Implementation").click();
    await expect(window.locator('[data-testid="file-line-mark"][data-line="3"]')).toContainText(
      "marker-3",
    );
    await fileButton(assistant, `${workspacePath}/src/app.ts:3`).click();
    await expect(window.locator('[data-testid="file-line-mark"][data-line="3"]')).toBeVisible();

    await fileButton(assistant, "notes").click();
    await expect(window.locator(".file-editor__source")).toBeVisible();
    await expect(window.locator('[data-testid="file-line-mark"][data-line="2"]')).toContainText(
      "Line two is here",
    );
    await window.getByRole("button", { name: "View source" }).click();
    await expect(window.locator(".file-editor__markdown")).toBeVisible();
    await expect(window.locator(".file-editor__source")).toHaveCount(0);
    await window.getByRole("button", { name: "View source" }).click();
    await expect(window.locator(".file-editor__source")).toBeVisible();
    await expect(window.locator('[data-testid="file-line-mark"][data-line="2"]')).toBeVisible();

    await fileButton(assistant, "src/long.ts:350").click();
    const longMark = window.locator('[data-testid="file-line-mark"][data-line="350"]');
    await expect(longMark).toContainText("marker-350");
    await expectBoxInside(longMark, window.locator(".file-editor__body"));

    await fileButton(assistant, "nested/file-79.txt:1").click();
    const lastRow = window.locator(
      '.file-workbench__tree-row--file[data-file-path="nested/file-79.txt"]',
    );
    await expect(lastRow).toBeVisible();
    await expectBoxInside(lastRow, window.locator(".file-workbench__tree"));

    await fileButton(assistant, "secret.txt:1").click();
    await expect(window.getByTestId("file-workbench-preview")).toContainText("ignored secret line");
    await expect(
      window.locator('.file-workbench__tree-row--file[data-file-path="secret.txt"]'),
    ).toHaveCount(0);
    await expect(window.getByTestId("file-line-mark")).toContainText("ignored secret line");
  } finally {
    await harness.close();
  }
});
