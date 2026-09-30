import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { PiSdkDriver } from "@pi-gui/pi-sdk-driver";
import type { SessionMessageInput } from "@pi-gui/session-driver";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";
import { appendMessagesToSessionFile, sessionFilePathFromCatalog } from "../helpers/session-file";
import { formatAnnotatedPrompt } from "../../src/features/conversation/annotations/annotation-prompt";

const REPLY =
  "I wouldn't hold up the reply for TN stamps. Your I-94 is the official admission record.";
const SENT_EARLIER = formatAnnotatedPrompt(
  [{ quote: "An earlier quoted line from a reply", note: "Earlier note" }],
  "Earlier follow-up",
);

/** Drags the real mouse across `phrase` inside the assistant reply. */
async function dragSelect(page: Page, phrase: string): Promise<void> {
  const box = await page.evaluate((target) => {
    const root = [...document.querySelectorAll(".timeline-item--assistant [data-annotation-root]")]
      .reverse()
      .find((element) => element.textContent?.includes(target));
    if (!root) throw new Error(`Missing reply text ${target}`);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const index = node.nodeValue?.indexOf(target) ?? -1;
      if (index < 0) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + target.length);
      const rect = range.getBoundingClientRect();
      return { left: rect.left, right: rect.right, y: rect.top + rect.height / 2 };
    }
    throw new Error(`Phrase not in one text node: ${target}`);
  }, phrase);
  await page.mouse.move(box.left + 1, box.y);
  await page.mouse.down();
  await page.mouse.move(box.right - 1, box.y, { steps: 8 });
  await page.mouse.up();
}

/** Launches the app on a thread whose saved transcript holds `messages`. */
async function launchWithTranscript(
  name: string,
  messages: Parameters<typeof appendMessagesToSessionFile>[1],
) {
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace(name);
  const firstRun = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  let workspaceId = "";
  let sessionId = "";
  try {
    const window = await firstRun.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await createNamedThread(window, "Annotations");
    const state = await getDesktopState(window);
    workspaceId = state.selectedWorkspaceId;
    sessionId = state.selectedSessionId;
  } finally {
    await firstRun.close();
  }
  const sessionFilePath = await sessionFilePathFromCatalog(userDataDir, { workspaceId, sessionId });
  await appendMessagesToSessionFile(sessionFilePath, messages);
  return launchDesktop(userDataDir, { testMode: "background" });
}

test("adds transcript selections to chat with comments and sends them before the message", async () => {
  test.setTimeout(90_000);
  const harness = await launchWithTranscript("transcript-annotations", [
    { role: "user", text: SENT_EARLIER },
    { role: "assistant", text: REPLY },
  ]);
  try {
    const page = await harness.firstWindow();
    await expect(page.locator(".timeline-item--assistant").last()).toContainText("TN stamps");

    // A sent message shows its quote as a collapsed block, its note, then the body.
    const sent = page.getByTestId("sent-annotation");
    await expect(sent).toHaveCount(1);
    await expect(sent).toContainText("An earlier quoted line from a reply");
    await expect(sent).toContainText("Earlier note");
    await expect(page.locator(".timeline-item--user")).toContainText("Earlier follow-up");
    await expect(page.locator(".timeline-item--user")).not.toContainText("<annotation>");
    await expect(sent.locator("details")).not.toHaveAttribute("open");

    // Record what reaches pi without a provider.
    await harness.electronApp.evaluate(
      (_electron, input) => {
        const { createRequire } = process.getBuiltinModule("module");
        const load = createRequire(input.entry);
        const { PiSdkDriver: Driver } = load("@pi-gui/pi-sdk-driver") as {
          PiSdkDriver: typeof PiSdkDriver;
        };
        const sent: SessionMessageInput[] = [];
        const hooks = globalThis as {
          __annotationSends?: SessionMessageInput[];
          __failNextAnnotationSend?: boolean;
        };
        hooks.__annotationSends = sent;
        Driver.prototype.sendUserMessage = async function (_ref, message) {
          if (hooks.__failNextAnnotationSend) {
            hooks.__failNextAnnotationSend = false;
            throw new Error("Simulated send failure");
          }
          sent.push(message);
        };
      },
      { entry: resolve("apps/desktop/out/main/main.js") },
    );

    // Select, then add with the shortcut; the comment box opens on a numbered marker.
    await dragSelect(page, "hold up the reply");
    await expect(page.getByTestId("add-to-chat")).toContainText("Add to Chat");
    await page.keyboard.press("Control+L");
    const editor = page.getByTestId("annotation-editor");
    await expect(editor.getByRole("textbox")).toBeFocused();
    await editor.getByRole("textbox").fill("Why not?");
    await editor.getByRole("textbox").press("Enter");
    await expect(editor).toHaveCount(0);
    await expect(page.getByTestId("annotation-marker")).toHaveText("1");
    const chip = page.getByTestId("annotation-chip");
    await expect(chip).toContainText("1 annotation");

    // Second one through the button.
    await dragSelect(page, "official admission record");
    await page.getByTestId("add-to-chat").click();
    await page.getByTestId("annotation-editor").getByRole("textbox").press("Enter");
    await expect(page.getByTestId("annotation-marker")).toHaveText(["1", "2"]);
    await expect(chip).toContainText("2 annotations");

    // Hovering the chip lists each quote and note.
    await chip.getByRole("button", { name: "2 annotations" }).hover();
    const popover = page.getByTestId("annotation-chip-popover");
    await expect(popover).toBeVisible();
    await expect(popover).toContainText("hold up the reply");
    await expect(popover).toContainText("Why not?");
    await expect(popover).toContainText("official admission record");

    // Clicking a marker edits its note; removing drops it and renumbers.
    await page.getByTestId("annotation-marker").first().click();
    await expect(page.getByTestId("annotation-editor").getByRole("textbox")).toHaveValue(
      "Why not?",
    );
    // Switching straight to another marker keeps what was typed in the first.
    await page.getByTestId("annotation-editor").getByRole("textbox").fill("Why not wait?");
    await page.getByTestId("annotation-marker").nth(1).click();
    await expect(page.getByTestId("annotation-editor").getByRole("textbox")).toHaveValue("");
    await expect(popover).toContainText("Why not wait?");
    await page.getByTestId("annotation-remove").click();
    await expect(page.getByTestId("annotation-marker")).toHaveText(["1"]);

    // The mouse can travel diagonally from the chip up to its list and remove from there.
    await dragSelect(page, "Your I-94");
    await page.getByTestId("add-to-chat").click();
    await page.getByTestId("annotation-editor").getByRole("textbox").press("Enter");
    await expect(chip).toContainText("2 annotations");
    await chip.getByRole("button", { name: "2 annotations" }).hover();
    await expect(popover).toBeVisible();
    const removeSecond = popover.getByRole("button", { name: "Remove annotation 2" });
    const removeBox = (await removeSecond.boundingBox())!;
    await page.mouse.move(removeBox.x + removeBox.width / 2, removeBox.y + removeBox.height / 2, {
      steps: 12,
    });
    await removeSecond.click();
    await expect(page.getByTestId("annotation-marker")).toHaveText(["1"]);
    await expect(chip).toContainText("1 annotation");

    // A failed send gives back the typed text and the annotation, not the formatted blocks.
    await harness.electronApp.evaluate(() => {
      (globalThis as { __failNextAnnotationSend?: boolean }).__failNextAnnotationSend = true;
    });
    await page.getByTestId("composer").fill("Thanks, one more thing.");
    await page.getByTestId("send").click();
    await expect(page.getByTestId("composer-error-banner")).toContainText("Simulated send failure");
    await expect(page.getByTestId("composer")).toHaveValue("Thanks, one more thing.");
    await expect(chip).toContainText("1 annotation");
    await expect(page.getByTestId("annotation-marker")).toHaveText(["1"]);

    // Sending puts the annotation before the typed text and clears the markers.
    await page.getByTestId("send").click();
    await expect
      .poll(() =>
        harness.electronApp.evaluate(
          () =>
            (globalThis as { __annotationSends?: SessionMessageInput[] }).__annotationSends?.map(
              (message) => message.text,
            ) ?? [],
        ),
      )
      .toEqual([
        formatAnnotatedPrompt(
          [{ quote: "hold up the reply", note: "Why not wait?" }],
          "Thanks, one more thing.",
        ),
      ]);
    await expect(page.getByTestId("annotation-chip")).toHaveCount(0);
    await expect(page.getByTestId("annotation-marker")).toHaveCount(0);
  } finally {
    await harness.close();
  }
});

/** Where `phrase` sits in the reply: the middle of its first line, and its left and right edges. */
async function phraseBox(page: Page, phrase: string) {
  return page.evaluate((target) => {
    const root = [...document.querySelectorAll("[data-annotation-root]")].find((element) =>
      element.textContent?.includes(target),
    );
    const walker = root && document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker?.nextNode(); node; node = walker?.nextNode()) {
      const index = node.nodeValue?.indexOf(target) ?? -1;
      if (index < 0) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + target.length);
      const rect = range.getClientRects()[0]!;
      const rootRect = root!.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        y: rect.top + rect.height / 2,
        rootLeft: rootRect.left,
        rootRight: rootRect.right,
      };
    }
    throw new Error(`Missing reply text ${target}`);
  }, phrase);
}

test("a multi-line drag that runs past the text still adds its lines", async () => {
  test.setTimeout(90_000);
  const paragraph = (label: string) =>
    `${label} starts here and carries on for a while so the line is long enough to read.`;
  const harness = await launchWithTranscript("transcript-annotation-drags", [
    { role: "user", text: "Tell me three things." },
    {
      role: "assistant",
      text: [paragraph("First"), paragraph("Second"), paragraph("Third")].join("\n\n"),
    },
    { role: "user", text: "And one more." },
    { role: "assistant", text: "A short last reply." },
  ]);
  try {
    const page = await harness.firstWindow();
    await expect(page.getByTestId("transcript")).toContainText("A short last reply.");
    const drag = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 10 });
      await page.mouse.up();
    };

    // Past the end of the second line, out into the margin beside the text.
    const first = await phraseBox(page, "First starts");
    const second = await phraseBox(page, "Second starts");
    await drag({ x: first.left + 1, y: first.y }, { x: second.rootRight + 40, y: second.y });
    await expect(page.getByTestId("add-to-chat")).toBeVisible();
    await page.keyboard.press("Control+L");
    await page.getByTestId("annotation-editor").getByRole("textbox").press("Enter");

    // Down past the reply's last line, onto its Fork button.
    const third = await phraseBox(page, "Third starts");
    await drag({ x: second.left + 1, y: second.y }, { x: third.left + 40, y: third.y + 30 });
    await expect(page.getByTestId("add-to-chat")).toBeVisible();
    await page.keyboard.press("Control+L");
    await page.getByTestId("annotation-editor").getByRole("textbox").press("Enter");

    await page.getByRole("button", { name: "2 annotations" }).hover();
    const items = page.getByTestId("annotation-chip-popover").locator(".annotation-chip__quote");
    await expect(items).toHaveText([
      `${paragraph("First")}\n\n${paragraph("Second")}`,
      `${paragraph("Second")}\n\n${paragraph("Third")}`,
    ]);

    // A drag on into the next message is not one message's text.
    const last = await phraseBox(page, "A short last reply");
    await drag({ x: third.left + 1, y: third.y }, { x: last.right - 1, y: last.y });
    await expect(page.getByTestId("add-to-chat")).toHaveCount(0);
  } finally {
    await harness.close();
  }
});
