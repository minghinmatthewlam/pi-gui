import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { PiSdkDriver } from "@pi-gui/pi-sdk-driver";
import type { SessionMessageInput } from "@pi-gui/session-driver";
import {
  createNamedThread,
  desktopShortcut,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  waitForTimelineLayout,
  waitForWorkspaceByPath,
  writeProjectExtension,
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
    await page.keyboard.press("ControlOrMeta+L");
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
  const paragraph = (label: string) => `${label} starts here and ends on one line.`;
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
    const settled = () =>
      expect(page.getByTestId("timeline-pane")).toHaveAttribute("data-layout", "settled");
    const drag = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 10 });
      await page.mouse.up();
      // The button follows the selection a frame after release.
      await page.evaluate(
        () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
      );
    };
    await settled();

    // Past the end of the second line, out into the margin beside the text.
    const first = await phraseBox(page, "First starts");
    const second = await phraseBox(page, "Second starts");
    await drag({ x: first.left + 1, y: first.y }, { x: second.rootRight + 40, y: second.y });
    await expect(page.getByTestId("add-to-chat")).toBeVisible();
    await page.keyboard.press("ControlOrMeta+L");
    await page.getByTestId("annotation-editor").getByRole("textbox").press("Enter");

    // Down past the reply's last line, onto its Fork button.
    await settled();
    const third = await phraseBox(page, "Third starts");
    await drag({ x: second.left + 1, y: second.y }, { x: third.left + 40, y: third.y + 30 });
    await expect(page.getByTestId("add-to-chat")).toBeVisible();
    await page.keyboard.press("ControlOrMeta+L");
    await page.getByTestId("annotation-editor").getByRole("textbox").press("Enter");

    await settled();
    await page.getByRole("button", { name: "2 annotations" }).hover();
    const items = page.getByTestId("annotation-chip-popover").locator(".annotation-chip__quote");
    await expect(items).toHaveText([
      `${paragraph("First")}\n\n${paragraph("Second")}`,
      `${paragraph("Second")}\n\n${paragraph("Third")}`,
    ]);

    // A drag on into the next message is not one message's text.
    const last = await phraseBox(page, "A short last reply");
    await drag({ x: third.left + 1, y: third.y }, { x: last.right - 1, y: last.y });
    const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
    expect(selected).toContain("Third starts");
    expect(selected).toContain("A short last reply");
    await expect(page.getByTestId("add-to-chat")).toHaveCount(0);
  } finally {
    await harness.close();
  }
});

test("copies a transcript selection from the button beside Add to Chat", async () => {
  test.setTimeout(60_000);
  const harness = await launchWithTranscript("transcript-copy", [
    { role: "user", text: "Ask" },
    { role: "assistant", text: REPLY },
  ]);
  try {
    const page = await harness.firstWindow();
    await expect(page.locator(".timeline-item--assistant").last()).toContainText("TN stamps");
    await harness.electronApp.evaluate(({ clipboard }) => clipboard.writeText(""));

    await dragSelect(page, "official admission record");
    const copy = page.getByTestId("copy-selection");
    await expect(copy).toContainText("Copy");
    await expect(page.getByTestId("add-to-chat")).toBeVisible();
    await copy.click();
    await expect(copy).toContainText("Copied");
    await expect
      .poll(() => harness.electronApp.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe("official admission record");

    // Copying keeps the selection and adds nothing; Add to Chat still works on it.
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(
      "official admission record",
    );
    await expect(page.getByTestId("annotation-marker")).toHaveCount(0);
    await page.getByTestId("add-to-chat").click();
    await expect(page.getByTestId("annotation-editor")).toBeVisible();
  } finally {
    await harness.close();
  }
});

test("keeps the selection buttons inside the window when the selection ends at its right edge", async () => {
  test.setTimeout(60_000);
  const harness = await launchWithTranscript("transcript-actions-edge", [
    { role: "user", text: "Ask" },
    {
      role: "assistant",
      text: `${REPLY} Keep the approval notice with your passport and compare the dates before you travel.`,
    },
  ]);
  try {
    const page = await harness.firstWindow();
    await expect(page.locator(".timeline-item--assistant").last()).toContainText("TN stamps");
    await harness.electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(760, 700);
    });
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(760);
    // At this width the open sidebar is a drawer whose backdrop takes pointer input. A user
    // selects transcript text with it closed.
    await expect(page.getByTestId("sidebar-drawer-backdrop")).toBeVisible();
    await page.getByTestId("sidebar-toggle").click();
    await expect(page.locator(".sidebar")).toHaveCount(0);
    await expect(page.getByTestId("sidebar-drawer-backdrop")).toHaveCount(0);
    await waitForTimelineLayout(page);

    // Drag across the word that ends furthest right; the buttons would start at its left edge.
    const word = await page.evaluate(() => {
      const root = document.querySelector(".timeline-item--assistant [data-annotation-root]");
      if (!root) throw new Error("Missing reply text");
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let best = { left: 0, right: 0, y: 0 };
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        for (const match of (node.nodeValue ?? "").matchAll(/\S+/g)) {
          const range = document.createRange();
          range.setStart(node, match.index);
          range.setEnd(node, match.index + match[0].length);
          const rect = range.getBoundingClientRect();
          if (rect.right > best.right) {
            best = { left: rect.left, right: rect.right, y: rect.top + rect.height / 2 };
          }
        }
      }
      return best;
    });
    await page.mouse.move(word.left + 1, word.y);
    await page.mouse.down();
    await page.mouse.move(word.right - 1, word.y, { steps: 6 });
    await page.mouse.up();

    await expect(page.getByTestId("add-to-chat")).toBeVisible();
    const box = await page.locator(".annotation-add").boundingBox();
    expect(box).not.toBeNull();
    // Placed at the word, the buttons would run past the window.
    expect(word.left + box!.width).toBeGreaterThan(760);
    expect(box!.x).toBeGreaterThanOrEqual(8);
    expect(box!.x + box!.width).toBeLessThanOrEqual(760 - 8);
    expect(box!.height).toBe(32);
  } finally {
    await harness.close();
  }
});

// A model that streams one line of reply and then holds the run open until the app closes.
const STREAMING_REPLY = "Halfway through a reply that is still streaming";
const heldReplyProvider = String.raw`
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

export default function heldReplyProvider(pi) {
  pi.registerProvider("held-reply", {
    baseUrl: "http://127.0.0.1:9/never-contact",
    apiKey: "LOCAL_TEST_CANARY",
    api: "held-reply",
    models: [{
      id: "held", name: "Held reply", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000, maxTokens: 4096,
    }],
    streamSimple(model, _context, options) {
      const stream = createAssistantMessageEventStream();
      const message = (text) => ({
        role: "assistant", content: [{ type: "text", text }], api: model.api,
        provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop", timestamp: Date.now(),
      });
      stream.push({ type: "start", partial: { ...message(""), content: [] } });
      stream.push({ type: "text_start", contentIndex: 0, partial: message("") });
      const text = ${JSON.stringify(STREAMING_REPLY)};
      stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message(text) });
      options?.signal?.addEventListener("abort", () => {
        stream.push({ type: "error", reason: "aborted", error: { ...message(text), stopReason: "aborted" } });
      });
      return stream;
    },
  });
}
`;

test("a drag past the end of a streaming reply skips the Working line", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("transcript-annotation-working");
  await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: "held-reply",
      defaultModel: "held",
      enabledModels: ["held-reply/held"],
      packages: [],
      cacheWarming: "off",
      compaction: { enabled: false },
    }),
  );
  await writeProjectExtension(workspacePath, "held-reply.ts", heldReplyProvider);
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
  });
  try {
    const page = await harness.firstWindow();
    await waitForWorkspaceByPath(page, workspacePath);
    await page
      .getByRole("complementary")
      .getByRole("button", { name: "New thread", exact: true })
      .click();
    await page.getByLabel("New thread prompt", { exact: true }).fill("Start a long reply");
    await page.getByRole("button", { name: "Start thread", exact: true }).click();
    const reply = page.locator(".timeline-item--assistant [data-annotation-root]").last();
    await expect(reply).toHaveText(STREAMING_REPLY);
    const working = page.getByTestId("timeline-working");
    await expect(working).toContainText("Working");

    // Hold the clock so the label stops ticking: a tick rewrites its text and would drop it
    // from a selection that should never have taken it.
    await page.clock.setFixedTime(new Date());

    // From inside the reply down onto the Working line under it.
    const start = await reply.evaluate((root) => {
      const range = document.createRange();
      range.selectNodeContents(root);
      const rect = range.getClientRects()[0]!;
      return { x: rect.left + 1, y: rect.top + rect.height / 2 };
    });
    const end = await working.locator(".timeline-working__label").boundingBox();
    if (!end) throw new Error("Missing Working line");
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 10 });
    await page.mouse.up();
    await expect(page.getByTestId("add-to-chat")).toBeVisible();
    // A native copy of the selection leaves the status line out. (It still takes the Fork and
    // popover button labels, as any drag past the last row does.)
    await harness.electronApp.evaluate(({ clipboard }) => clipboard.writeText(""));
    await page.evaluate(() => document.execCommand("copy"));
    const copied = await harness.electronApp.evaluate(({ clipboard }) => clipboard.readText());
    expect(copied).toContain(STREAMING_REPLY);
    expect(copied).not.toContain("Working");
    await page.getByTestId("add-to-chat").click();
    await page.getByTestId("annotation-editor").getByRole("textbox").press("Enter");
    await page.getByRole("button", { name: "1 annotation" }).hover();
    await expect(
      page.getByTestId("annotation-chip-popover").locator(".annotation-chip__quote"),
    ).toHaveText([STREAMING_REPLY]);
  } finally {
    await harness.close();
  }
});

test("the narrow sidebar drawer covers selection buttons left over from before it opened", async () => {
  test.setTimeout(60_000);
  const harness = await launchWithTranscript("transcript-actions-drawer", [
    { role: "user", text: "Ask" },
    { role: "assistant", text: REPLY },
  ]);
  try {
    const page = await harness.firstWindow();
    await expect(page.locator(".timeline-item--assistant").last()).toContainText("TN stamps");
    await harness.electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(760, 700);
    });
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(760);
    await page.getByTestId("sidebar-toggle").click();
    await expect(page.locator(".sidebar")).toHaveCount(0);
    await waitForTimelineLayout(page);
    // The reply's first words sit where the drawer opens.
    await dragSelect(page, "I wouldn't hold up");
    await expect(page.getByTestId("add-to-chat")).toBeVisible();

    await page.keyboard.press(desktopShortcut("B"));
    await expect(page.getByTestId("sidebar-drawer-backdrop")).toBeVisible();
    // The buttons start over the drawer and end over the backdrop; each must cover its part.
    const topmost = await page.evaluate(() => {
      const buttons = document.querySelector(".annotation-add")?.getBoundingClientRect();
      if (!buttons) return null;
      const y = buttons.top + buttons.height / 2;
      const owner = (x: number) => {
        const hit = document.elementFromPoint(x, y);
        if (hit?.closest(".sidebar")) return "drawer";
        if (hit?.closest("[data-testid='sidebar-drawer-backdrop']")) return "backdrop";
        return hit?.closest(".annotation-popover") ? "selection buttons" : "other";
      };
      const drawerRight = document.querySelector(".sidebar")?.getBoundingClientRect().right ?? 0;
      return {
        start: owner(buttons.left + 4),
        end: owner(buttons.right - 4),
        drawerRight,
        buttonsRight: buttons.right,
      };
    });
    expect(topmost).not.toBeNull();
    expect(topmost!.buttonsRight).toBeGreaterThan(topmost!.drawerRight + 4);
    expect(topmost).toMatchObject({ start: "drawer", end: "backdrop" });
  } finally {
    await harness.close();
  }
});
