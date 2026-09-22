import { test, expect } from "@playwright/test";
import {
  launchDesktop,
  emitTestSessionEvent,
  makeUserDataDir,
  makeWorkspace,
  createSessionViaIpc,
  seedTranscriptMessages,
  streamAssistantDeltas,
  jumpTimelineToBottom,
  scrollTimelineAwayFromBottom,
  getTimelineScrollMetrics,
  desktopShortcut,
} from "../helpers/electron-app";

test("long messages stay windowed and wheel scrolling preserves the visible row during streaming", async () => {
  test.setTimeout(90000);
  const h = await launchDesktop(await makeUserDataDir(), {
    initialWorkspaces: [await makeWorkspace("viewport-long")],
    testMode: "background",
  });
  try {
    const p = await h.firstWindow();
    const state = await p.evaluate(() => window.piApp!.getState());
    await createSessionViaIpc(p, state.selectedWorkspaceId!, "Long viewport");
    await seedTranscriptMessages(h, p, {
      count: 120,
      textFactory: (i) =>
        `Row ${i}\n\n` + "Long prose with **formatting**. ".repeat(i === 115 ? 400 : 80),
    });
    await jumpTimelineToBottom(p);
    await expect
      .poll(async () => (await getTimelineScrollMetrics(p)).remainingFromBottom)
      .toBeLessThanOrEqual(2);
    await expect(p.locator(".timeline--virtualized")).toHaveCount(1);
    expect(await p.locator("[data-message-id]").count()).toBeLessThan(20);
    await scrollTimelineAwayFromBottom(p, 900);
    const capture = () =>
      p.evaluate(() => {
        const pane = document.querySelector<HTMLElement>('[data-testid="timeline-pane"]')!;
        const top = pane.getBoundingClientRect().top;
        const el = [...pane.querySelectorAll<HTMLElement>("[data-message-id]")].find(
          (row) => row.getBoundingClientRect().bottom > top,
        )!;
        return { id: el.dataset.messageId!, y: el.getBoundingClientRect().top - top };
      });
    const before = await capture();
    await streamAssistantDeltas(h, p, [
      "NEW_STREAM_CONTENT ",
      "keeps arriving ",
      "without moving the reader",
    ]);
    await expect.poll(capture).toEqual(before);
    expect(await p.locator("[data-message-id]").count()).toBeLessThan(20);
    await expect(p.getByTestId("timeline-jump")).toBeVisible();
    await p.getByTestId("timeline-jump").click();
    await expect(p.getByTestId("transcript")).toContainText("without moving the reader");
    await expect
      .poll(async () => (await getTimelineScrollMetrics(p)).remainingFromBottom)
      .toBeLessThanOrEqual(2);
  } finally {
    await h.close();
  }
});

test("clicks and downward wheel at the bottom do not stop following; search uses the same viewport", async () => {
  const h = await launchDesktop(await makeUserDataDir(), {
    initialWorkspaces: [await makeWorkspace("viewport-intent")],
    testMode: "background",
  });
  try {
    const p = await h.firstWindow();
    const state = await p.evaluate(() => window.piApp!.getState());
    await createSessionViaIpc(p, state.selectedWorkspaceId!, "Viewport intent");
    await seedTranscriptMessages(h, p, {
      count: 30,
      textFactory: (i) => `Searchable row ${i}. ` + "Text ".repeat(80),
    });
    await jumpTimelineToBottom(p);
    await p.locator(".timeline-item--assistant").last().click();
    await p.mouse.wheel(0, 300);
    await streamAssistantDeltas(h, p, ["FOLLOW_AFTER_CLICK ", "more text ".repeat(100)]);
    await expect
      .poll(async () => (await getTimelineScrollMetrics(p)).remainingFromBottom)
      .toBeLessThanOrEqual(2);
    await p.evaluate(() => {
      const fire = () =>
        window.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "f",
            code: "KeyF",
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      fire();
      fire();
    });
    const search = p.getByPlaceholder("Search thread...");
    await expect(search).toBeVisible();
    await search.press("Escape");
    await expect(search).toHaveCount(0);
    await p.waitForTimeout(250);
    await p.keyboard.press(desktopShortcut("f"));
    await expect(search).toBeVisible();
    await search.fill("Searchable row 2.");
    await expect(p.locator("mark.thread-find-active")).toBeVisible();
    const match = await p.locator("mark.thread-find-active").boundingBox();
    const pane = await p.getByTestId("timeline-pane").boundingBox();
    expect(match!.y).toBeGreaterThanOrEqual(pane!.y);
    expect(match!.y).toBeLessThan(pane!.y + pane!.height);
  } finally {
    await h.close();
  }
});

test("streaming inside a tall measured code row never substitutes estimated geometry", async ({}, info) => {
  const h = await launchDesktop(await makeUserDataDir(), {
    initialWorkspaces: [await makeWorkspace("viewport-tall-code")],
    testMode: "background",
  });
  try {
    const p = await h.firstWindow();
    const state = await p.evaluate(() => window.piApp!.getState());
    await createSessionViaIpc(p, state.selectedWorkspaceId!, "Tall code");
    const seeded = await seedTranscriptMessages(h, p, {
      count: 2,
      textFactory: (i) => `Prelude ${i}`,
    });
    const emit = async (text: string) =>
      emitTestSessionEvent(h, {
        type: "assistantDelta",
        sessionRef: seeded.sessionRef,
        timestamp: new Date().toISOString(),
        runId: "tall-code-run",
        text,
      });
    await emit(
      "```text\n" +
        Array.from({ length: 700 }, (_, i) => `line ${i}: a short code example`).join("\n") +
        "\n",
    );
    await expect(p.locator(".timeline-item--assistant").last()).toContainText("line 699");
    await jumpTimelineToBottom(p);
    await scrollTimelineAwayFromBottom(p, 1200);
    const before = (await getTimelineScrollMetrics(p)).scrollTop;
    const samples: number[] = [];
    const frames = p.evaluate(
      () =>
        new Promise<number[]>((resolve) => {
          const values: number[] = [];
          const until = performance.now() + 3000;
          let last = performance.now();
          function frame(now: number) {
            values.push(now - last);
            last = now;
            if (now < until) requestAnimationFrame(frame);
            else resolve(values);
          }
          requestAnimationFrame(frame);
        }),
    );
    for (let i = 0; i < 20; i++) {
      await emit(`additional line ${i}\n`);
      await p.waitForTimeout(65);
      samples.push((await getTimelineScrollMetrics(p)).scrollTop);
    }
    expect(Math.max(...samples.map((top) => Math.abs(top - before)))).toBeLessThanOrEqual(2);
    const intervals = (await frames).sort((a, b) => a - b);
    const metrics = {
      frameCount: intervals.length,
      p95: intervals[Math.floor(intervals.length * 0.95)],
      max: intervals.at(-1),
      over33: intervals.filter((ms) => ms > 33).length,
    };
    await info.attach("tall-row-frame-timing", {
      body: Buffer.from(JSON.stringify(metrics)),
      contentType: "application/json",
    });
    console.log("Tall-row streaming frames", metrics);
  } finally {
    await h.close();
  }
});

test("a layout clamp after user intent expires does not resume following", async () => {
  const h = await launchDesktop(await makeUserDataDir(), {
    initialWorkspaces: [await makeWorkspace("viewport-clamp")],
    testMode: "background",
  });
  try {
    const p = await h.firstWindow();
    const state = await p.evaluate(() => window.piApp!.getState());
    await createSessionViaIpc(p, state.selectedWorkspaceId!, "Clamp reading");
    await streamAssistantDeltas(h, p, [
      Array.from({ length: 150 }, (_, i) => `Paragraph ${i}.\n\n`).join(""),
    ]);
    await jumpTimelineToBottom(p);
    await scrollTimelineAwayFromBottom(p, 200);
    await p.waitForTimeout(1100);
    // Deterministic geometry fixture: represents content collapsing after user
    // input ends, with no wheel/pointer event to claim the browser's clamp.
    await p
      .locator(".message__content")
      .last()
      .evaluate((el) => {
        el.style.maxHeight = "80px";
        el.style.overflow = "hidden";
      });
    await expect.poll(async () => (await getTimelineScrollMetrics(p)).scrollTop).toBe(0);
    await streamAssistantDeltas(h, p, [
      Array.from({ length: 100 }, (_, i) => `New output ${i}.\n\n`).join(""),
    ]);
    await expect
      .poll(async () => (await getTimelineScrollMetrics(p)).remainingFromBottom)
      .toBeGreaterThan(100);
    await expect(p.getByTestId("timeline-jump")).toBeVisible();
  } finally {
    await h.close();
  }
});

test("typing within a fixed-height multiline draft never shifts the chat", async () => {
  const h = await launchDesktop(await makeUserDataDir(), {
    initialWorkspaces: [await makeWorkspace("viewport-typing")],
    testMode: "background",
  });
  try {
    const p = await h.firstWindow();
    const state = await p.evaluate(() => window.piApp!.getState());
    await createSessionViaIpc(p, state.selectedWorkspaceId!, "Typing viewport");
    await seedTranscriptMessages(h, p, { count: 30 });
    const composer = p.getByTestId("composer");
    await composer.fill("First line\nSecond line\nThird line\nFourth line\nFifth line\nTyping: ");
    await jumpTimelineToBottom(p);
    await p.waitForTimeout(200);
    const sampling = p.evaluate(async () => {
      const pane = document.querySelector<HTMLElement>('[data-testid="timeline-pane"]')!;
      const tops = [pane.scrollTop];
      const started = performance.now();
      while (performance.now() - started < 1600) {
        await new Promise(requestAnimationFrame);
        tops.push(pane.scrollTop);
      }
      return Math.max(...tops) - Math.min(...tops);
    });
    await composer.pressSequentially("abcdefghijklmnopqrstuvwxyz", { delay: 40 });
    expect(await sampling).toBeLessThanOrEqual(1);
  } finally {
    await h.close();
  }
});

test("small upward wheel input escapes bottom while typing and streaming overlap", async () => {
  const h = await launchDesktop(await makeUserDataDir(), {
    initialWorkspaces: [await makeWorkspace("viewport-small-wheel")],
    testMode: "background",
  });
  try {
    const p = await h.firstWindow();
    const state = await p.evaluate(() => window.piApp!.getState());
    await createSessionViaIpc(p, state.selectedWorkspaceId!, "Small wheel");
    const { sessionRef } = await seedTranscriptMessages(h, p, { count: 30 });
    await jumpTimelineToBottom(p);
    const composer = p.getByTestId("composer");
    await composer.focus();
    await p.getByTestId("timeline-pane").hover();
    const positions: number[] = [];
    await Promise.all([
      composer.pressSequentially("Typing a draft while the answer keeps arriving.", { delay: 45 }),
      (async () => {
        for (let i = 0; i < 25; i++) {
          await emitTestSessionEvent(h, {
            type: "assistantDelta",
            sessionRef,
            runId: "overlapping-scroll",
            timestamp: new Date().toISOString(),
            text: `word${i} `,
          });
          await p.waitForTimeout(80);
        }
      })(),
      (async () => {
        for (let i = 0; i < 25; i++) {
          await p.mouse.wheel(0, -4);
          await p.waitForTimeout(70);
          positions.push((await getTimelineScrollMetrics(p)).scrollTop);
        }
      })(),
    ]);
    // Position must progress upward even though each input is below the old
    // 32px near-bottom threshold. App renders must not rewind native motion.
    expect(positions[0]! - positions.at(-1)!).toBeGreaterThan(70);
    for (let i = 1; i < positions.length; i++)
      expect(positions[i]! - positions[i - 1]!).toBeLessThanOrEqual(1);
    await expect(composer).toHaveValue("Typing a draft while the answer keeps arriving.");
  } finally {
    await h.close();
  }
});
