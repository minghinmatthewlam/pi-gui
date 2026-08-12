import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";
import { appendMessagesToSessionFile, sessionFilePathFromCatalog } from "../helpers/session-file";

const markdownResponse = [
  "## Markdown rendering proof",
  "",
  "Assistant responses should render **strong text**, *emphasis*, and `inline code`.",
  "",
  "- First bullet",
  "- Second bullet",
  "",
  "1. First numbered item",
  "2. Second numbered item",
  "",
  "```ts",
  'const rendered: string = "markdown";',
  "```",
  "",
  "Open the [issue](https://github.com/minghinmatthewlam/pi-gui/issues/19).",
].join("\n");

const tableResponse = [
  "## Table layout proof",
  "",
  "| Key | Value |",
  "| --- | --- |",
  "| Status | Ready |",
  "",
  "| Package | Platform | Architecture | Artifact | Checksum | Distribution channel |",
  "| --- | --- | --- | --- | --- | --- |",
  `| desktop | macOS | arm64 | ${"pi-gui-release-artifact-".repeat(4)}.dmg | ${"abcdef0123456789".repeat(4)} | GitHub prerelease with automatic updates |`,
].join("\n");

test("renders markdown formatting in assistant responses", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const proofDir = process.env.PI_APP_MARKDOWN_RENDERING_PROOF_DIR?.trim();
  if (proofDir) {
    await mkdir(proofDir, { recursive: true });
  }
  const workspacePath = await makeWorkspace("message-markdown-workspace");
  const firstRun = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  let workspaceId = "";
  let sessionId = "";
  try {
    const window = await firstRun.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await createNamedThread(window, "Markdown proof thread");
    const state = await getDesktopState(window);
    workspaceId = state.selectedWorkspaceId;
    sessionId = state.selectedSessionId;
    expect(workspaceId).toBeTruthy();
    expect(sessionId).toBeTruthy();
  } finally {
    await firstRun.close();
  }

  const sessionFilePath = await sessionFilePathFromCatalog(userDataDir, { workspaceId, sessionId });
  await appendMessagesToSessionFile(sessionFilePath, [
    { role: "user", text: "Return the verification report." },
    { role: "assistant", text: markdownResponse },
  ]);

  const secondRun = await launchDesktop(userDataDir, { testMode: "background" });
  try {
    const window = await secondRun.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);

    const messageRow = window.locator(".timeline-item--assistant", { hasText: "Markdown rendering proof" });
    await expect(messageRow).toBeVisible();
    await expect(messageRow.getByRole("heading", { level: 2, name: "Markdown rendering proof" })).toBeVisible();
    await expect(messageRow.locator("strong")).toHaveText("strong text");
    await expect(messageRow.locator("em")).toHaveText("emphasis");
    await expect(messageRow.locator(":not(pre) > code")).toHaveText("inline code");
    await expect(messageRow.locator("ul > li")).toHaveText(["First bullet", "Second bullet"]);
    await expect(messageRow.locator("ol > li")).toHaveText(["First numbered item", "Second numbered item"]);
    await expect(messageRow.locator("pre code")).toContainText('const rendered: string = "markdown";');

    const issueLink = messageRow.getByRole("link", { name: "issue" });
    await expect(issueLink).toHaveAttribute("href", "https://github.com/minghinmatthewlam/pi-gui/issues/19");
    await expect(messageRow).not.toContainText("## Markdown rendering proof");
    await expect(messageRow).not.toContainText("```ts");

    if (proofDir) {
      await window.screenshot({
        path: join(proofDir, "assistant-markdown-rendering.png"),
        fullPage: true,
      });
    }
  } finally {
    await secondRun.close();
  }
});

test("keeps compact GFM tables content-sized and scrolls wide tables locally", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("message-markdown-tables-workspace");
  const firstRun = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  let workspaceId = "";
  let sessionId = "";
  try {
    const window = await firstRun.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await createNamedThread(window, "Markdown table proof thread");
    const state = await getDesktopState(window);
    workspaceId = state.selectedWorkspaceId;
    sessionId = state.selectedSessionId;
  } finally {
    await firstRun.close();
  }

  const sessionFilePath = await sessionFilePathFromCatalog(userDataDir, { workspaceId, sessionId });
  await appendMessagesToSessionFile(sessionFilePath, [
    { role: "user", text: "Return tables with compact and wide content." },
    { role: "assistant", text: tableResponse },
  ]);

  const secondRun = await launchDesktop(userDataDir, { testMode: "background" });
  try {
    const window = await secondRun.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);

    const messageRow = window.locator(".timeline-item--assistant", { hasText: "Table layout proof" });
    await expect(messageRow).toBeVisible();
    const tableScrollers = messageRow.locator(".message__table-scroll");
    await expect(tableScrollers).toHaveCount(2);

    await expect.poll(() => messageRow.evaluate((element) => {
      const content = element.querySelector<HTMLElement>(".message__content");
      const transcript = document.querySelector<HTMLElement>('[data-testid="transcript"]');
      const scrollers = element.querySelectorAll<HTMLElement>(".message__table-scroll");
      if (!content || !transcript || scrollers.length !== 2) {
        throw new Error("Expected message content, transcript, and two table scrollers");
      }

      const compact = scrollers[0];
      const wide = scrollers[1];
      const tolerance = 1;
      return {
        compactUsesContentWidth: compact.clientWidth < content.clientWidth - 80,
        compactNeedsNoHorizontalScroll: compact.scrollWidth <= compact.clientWidth + tolerance,
        wideStaysWithinContent: wide.getBoundingClientRect().right <= content.getBoundingClientRect().right + tolerance,
        wideHasLocalHorizontalScroll: wide.scrollWidth > wide.clientWidth + tolerance,
        transcriptHasNoHorizontalOverflow: transcript.scrollWidth <= transcript.clientWidth + tolerance,
      };
    })).toEqual({
      compactUsesContentWidth: true,
      compactNeedsNoHorizontalScroll: true,
      wideStaysWithinContent: true,
      wideHasLocalHorizontalScroll: true,
      transcriptHasNoHorizontalOverflow: true,
    });
  } finally {
    await secondRun.close();
  }
});
