import { expect, test, type Locator } from "@playwright/test";
import {
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

const longUrl = `https://example.com/${"long-url-segment".repeat(24)}`;
const longInlineToken = `INLINE_${"token".repeat(48)}`;
const longFencedLine = `FENCED_${"line".repeat(72)}`;
const wrappingMessage = [
  `Paragraph marker ${longUrl} with inline code \`${longInlineToken}\` at the end.`,
  "",
  "```ts",
  longFencedLine,
  "```",
].join("\n");

interface WrappingMetrics {
  readonly contentWithinRow: boolean;
  readonly paragraphWithinContent: boolean;
  readonly inlineCodeWithinContent: boolean;
  readonly preWithinContent: boolean;
  readonly preHasNoHorizontalOverflow: boolean;
  readonly transcriptHasNoHorizontalOverflow: boolean;
  readonly paragraphText: string;
  readonly inlineCodeText: string;
  readonly fencedCodeText: string;
}

async function getWrappingMetrics(row: Locator): Promise<WrappingMetrics> {
  return row.evaluate((element) => {
    const rowElement = element as HTMLElement;
    const transcript = document.querySelector<HTMLElement>('[data-testid="transcript"]');
    const content = rowElement.querySelector<HTMLElement>(".message__content");
    const paragraph = content?.querySelector<HTMLElement>("p");
    const inlineCode = content?.querySelector<HTMLElement>(":not(pre) > code");
    const pre = content?.querySelector<HTMLElement>("pre");
    const fencedCode = pre?.querySelector<HTMLElement>("code");
    if (!transcript || !content || !paragraph || !inlineCode || !pre || !fencedCode) {
      throw new Error(
        "Expected markdown paragraph, inline code, and fenced code to render in the message row",
      );
    }

    const tolerance = 1;
    const rowRect = rowElement.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    const paragraphRect = paragraph.getBoundingClientRect();
    const inlineCodeRect = inlineCode.getBoundingClientRect();
    const preRect = pre.getBoundingClientRect();
    const within = (child: DOMRect, parent: DOMRect) =>
      child.left >= parent.left - tolerance && child.right <= parent.right + tolerance;

    return {
      contentWithinRow: within(contentRect, rowRect),
      paragraphWithinContent: within(paragraphRect, contentRect),
      inlineCodeWithinContent: within(inlineCodeRect, contentRect),
      preWithinContent: within(preRect, contentRect),
      preHasNoHorizontalOverflow: pre.scrollWidth <= pre.clientWidth + tolerance,
      transcriptHasNoHorizontalOverflow:
        transcript.scrollWidth <= transcript.clientWidth + tolerance,
      paragraphText: paragraph.innerText,
      inlineCodeText: inlineCode.innerText,
      fencedCodeText: fencedCode.innerText,
    };
  });
}

test("wraps long markdown content inside transcript message bubbles", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("message-wrapping-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await window
      .getByRole("complementary")
      .getByRole("button", { name: "New thread", exact: true })
      .click();

    const prompt = window.getByLabel("New thread prompt");
    await expect(prompt).toBeVisible();
    await prompt.fill(wrappingMessage);
    await window.getByRole("button", { name: "Start thread" }).click();

    const messageRow = window.locator(".timeline-item--user", { hasText: "Paragraph marker" });
    await expect(messageRow).toBeVisible({ timeout: 15_000 });
    await expect(messageRow.locator(".message__content pre")).toBeVisible();

    await expect
      .poll(() => getWrappingMetrics(messageRow))
      .toMatchObject({
        contentWithinRow: true,
        paragraphWithinContent: true,
        inlineCodeWithinContent: true,
        preWithinContent: true,
        preHasNoHorizontalOverflow: true,
        transcriptHasNoHorizontalOverflow: true,
        paragraphText: expect.stringContaining(longUrl),
        inlineCodeText: longInlineToken,
        fencedCodeText: expect.stringContaining(longFencedLine),
      });
  } finally {
    await harness.close();
  }
});
