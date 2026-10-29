import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  createNamedThread,
  createSessionViaIpc,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  pasteTinyPng,
  selectSession,
  waitForWorkspaceByPath,
  writeProjectExtension,
  type DesktopHarness,
} from "../helpers/electron-app";
import { appendMessagesToSessionFile, sessionFilePathFromCatalog } from "../helpers/session-file";

type LoadedThreads = { readonly released: string[]; readonly transcripts: string[] };

/** Threads whose runtime the app released, and threads whose transcript it holds. */
async function loadedThreads(harness: DesktopHarness): Promise<LoadedThreads> {
  const loaded = await harness.electronApp.evaluate(() => {
    const hooks = (globalThis as { __PI_APP_TEST_HOOKS?: { loadedThreads?: () => LoadedThreads } })
      .__PI_APP_TEST_HOOKS;
    if (!hooks?.loadedThreads) {
      throw new Error("loadedThreads hook is unavailable");
    }
    return hooks.loadedThreads();
  });
  return { released: loaded.released.sort(), transcripts: loaded.transcripts.sort() };
}

/** Exactly these threads are held, and exactly these were released. */
async function expectThreads(
  harness: DesktopHarness,
  expected: { readonly held: string[]; readonly released: string[] },
): Promise<void> {
  await expect
    .poll(() => loadedThreads(harness))
    .toEqual({ released: [...expected.released].sort(), transcripts: [...expected.held].sort() });
}

const titles = ["Thread one", "Thread two", "Thread three", "Thread four", "Thread five"];
const platformModifier = process.platform === "darwin" ? "meta" : "control";

type ThreadRef = { workspaceId: string; sessionId: string };

const keyOf = (ref: ThreadRef) => `${ref.workspaceId}:${ref.sessionId}`;

/**
 * An extension that logs the id of every session whose runtime starts and, once the workspace
 * holds a starter-text file, puts its text in the composer as the runtime starts.
 */
const startLogExtension = String.raw`
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
export default function startLog(pi) {
  pi.on("session_start", async (_event, ctx) => {
    appendFileSync(join(ctx.cwd, "runtime-starts.log"), ctx.sessionManager.getSessionId() + "\n");
    const starter = join(ctx.cwd, "starter-text");
    if (existsSync(starter)) {
      ctx.ui.setEditorText(readFileSync(starter, "utf8"));
    }
  });
}
`;

/** How many times each session's runtime started. */
async function runtimeStarts(workspacePath: string): Promise<Map<string, number>> {
  const log = await readFile(join(workspacePath, "runtime-starts.log"), "utf8").catch(() => "");
  const starts = new Map<string, number>();
  for (const id of log.split("\n").filter(Boolean)) {
    starts.set(id, (starts.get(id) ?? 0) + 1);
  }
  return starts;
}

/** Five threads whose files contain a message each, then a fresh launch of the app. */
async function launchWithFiveThreads(
  name: string,
): Promise<{ harness: DesktopHarness; refs: ThreadRef[]; workspacePath: string }> {
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace(name);
  await writeProjectExtension(workspacePath, "start-log.ts", startLogExtension);
  const seed = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  const refs: ThreadRef[] = [];
  try {
    const window = await seed.firstWindow();
    for (const title of titles) {
      await createNamedThread(window, title);
      const state = await getDesktopState(window);
      refs.push({ workspaceId: state.selectedWorkspaceId, sessionId: state.selectedSessionId });
    }
  } finally {
    await seed.close();
  }
  for (const [index, ref] of refs.entries()) {
    await appendMessagesToSessionFile(await sessionFilePathFromCatalog(userDataDir, ref), [
      { role: "user", text: `question for ${titles[index]}` },
      { role: "assistant", text: `answer from ${titles[index]}` },
    ]);
  }
  const harness = await launchDesktop(userDataDir, { testMode: "background" });
  return { harness, refs, workspacePath };
}

/** Opens another window the way a person does, with Shift+Cmd+N. */
async function openSecondWindow(harness: DesktopHarness): Promise<Page> {
  const opened = harness.electronApp.waitForEvent("window");
  await harness.electronApp.evaluate(({ BrowserWindow }, modifier) => {
    BrowserWindow.getAllWindows()[0]?.webContents.sendInputEvent({
      type: "keyDown",
      keyCode: "n",
      modifiers: [modifier, "shift"],
    });
  }, platformModifier);
  const window = await opened;
  await window.waitForFunction(() => Boolean(globalThis.window.piApp));
  return window;
}

/**
 * Opened threads used to stay in memory until quit. Idle threads beyond the few viewed most
 * recently are released, and reload from their files, with their messages, when opened again.
 */
test("releases idle threads that weren't viewed recently and reloads them when opened", async () => {
  test.setTimeout(120_000);
  const { harness, refs, workspacePath } = await launchWithFiveThreads(
    "release-idle-threads-workspace",
  );
  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    const transcript = window.getByTestId("transcript");
    for (const title of titles) {
      await selectSession(window, title);
      await expect(transcript).toContainText(`answer from ${title}`);
    }

    // Only the threads viewed most recently stay loaded.
    await expectThreads(harness, {
      held: refs.slice(-3).map(keyOf),
      released: refs.slice(0, 2).map(keyOf),
    });

    // Refreshing the workspace's runtime (Customize > Refresh) reloads open threads only: the
    // released ones stay released, and their extensions do not start again.
    const startsBeforeRefresh = await runtimeStarts(workspacePath);
    await window.evaluate(async () => {
      await globalThis.window.piApp?.refreshRuntime();
    });
    await expectThreads(harness, {
      held: refs.slice(-3).map(keyOf),
      released: refs.slice(0, 2).map(keyOf),
    });
    const startsAfterRefresh = await runtimeStarts(workspacePath);
    expect(startsBeforeRefresh.get(refs[0]!.sessionId)).toBeGreaterThan(0);
    for (const ref of refs.slice(0, 2)) {
      expect(startsAfterRefresh.get(ref.sessionId)).toBe(startsBeforeRefresh.get(ref.sessionId));
    }

    // A released thread reloads from its file, with its messages, and still works.
    await selectSession(window, "Thread one");
    await expect(transcript).toContainText("question for Thread one");
    await expect(transcript).toContainText("answer from Thread one");
    await expect(transcript).not.toContainText("answer from Thread five");
    // The release was invisible, so reopening adds no "Resumed session" row.
    await expect(transcript).not.toContainText("Resumed session");
    await expectThreads(harness, {
      held: [keyOf(refs[0]!), ...refs.slice(-2).map(keyOf)],
      released: refs.slice(1, 3).map(keyOf),
    });
    const composer = window.getByTestId("composer");
    await composer.fill("draft after reload");
    await expect(composer).toHaveValue("draft after reload");
  } finally {
    await harness.close();
  }
});

/**
 * Reopening a released thread starts its extensions again, and one that sets the composer text
 * as it starts would replace an unsent draft. Threads with a draft or attachments stay loaded.
 */
test("a thread with an unsent draft or attachments stays loaded, so reopening never replaces them", async () => {
  test.setTimeout(120_000);
  const { harness, refs, workspacePath } = await launchWithFiveThreads("release-idle-draft");
  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    const transcript = window.getByTestId("transcript");
    const composer = window.getByTestId("composer");
    const attachment = window.locator(".composer-attachment--image");
    const draft = "half-written question for thread one";

    await selectSession(window, "Thread one");
    await expect(transcript).toContainText("answer from Thread one");
    await composer.fill(draft);
    await expect.poll(async () => (await getDesktopState(window)).composerDraft).toBe(draft);

    await selectSession(window, "Thread two");
    await expect(transcript).toContainText("answer from Thread two");
    await pasteTinyPng(window);
    await expect(attachment).toHaveCount(1);

    for (const title of titles.slice(2)) {
      await selectSession(window, title);
      await expect(transcript).toContainText(`answer from ${title}`);
    }
    await expectThreads(harness, { held: refs.map(keyOf), released: [] });

    // From now on, an extension sets the composer text whenever a thread's runtime starts.
    await writeFile(join(workspacePath, "starter-text"), "starter text");

    await selectSession(window, "Thread one");
    await expect(transcript).toContainText("answer from Thread one");
    await expect(composer).toHaveValue(draft);
    await expectThreads(harness, {
      held: [refs[0]!, refs[1]!, refs[3]!, refs[4]!].map(keyOf),
      released: [keyOf(refs[2]!)],
    });

    await selectSession(window, "Thread two");
    await expect(transcript).toContainText("answer from Thread two");
    await expect(attachment).toHaveCount(1);
    await expect(composer).toHaveValue("");

    // A thread without a draft was released, and reopening it ran the extension again: this is
    // what would have replaced Thread one's draft.
    await selectSession(window, "Thread three");
    await expect(transcript).toContainText("answer from Thread three");
    await expect(composer).toHaveValue("starter text");
  } finally {
    await harness.close();
  }
});

test("a thread showing in another window, even minimized, stays loaded while this window moves on", async () => {
  test.setTimeout(120_000);
  const { harness, refs, workspacePath } = await launchWithFiveThreads("release-idle-windows");
  try {
    const firstWindow = await harness.firstWindow();
    await waitForWorkspaceByPath(firstWindow, workspacePath);
    await selectSession(firstWindow, "Thread one");
    await expect(firstWindow.getByTestId("transcript")).toContainText("answer from Thread one");

    // The new window opens on the thread the first window shows.
    const secondWindow = await openSecondWindow(harness);
    await expect(secondWindow.locator(".chat-header__title")).toHaveText("Thread one");
    await expect(secondWindow.getByTestId("transcript")).toContainText("answer from Thread one");

    // A minimized window still depends on its thread: it shows it again when restored.
    await secondWindow.evaluate(() => {
      document.title = "release-idle-second-window";
    });
    await harness.electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getTitle() === "release-idle-second-window")
        ?.minimize();
    });

    // The first window moves through the other threads.
    for (const title of titles.slice(1)) {
      await selectSession(firstWindow, title);
      await expect(firstWindow.getByTestId("transcript")).toContainText(`answer from ${title}`);
    }
    await expectThreads(harness, {
      held: [keyOf(refs[0]!), ...refs.slice(-3).map(keyOf)],
      released: [keyOf(refs[1]!)],
    });

    // Restored, the second window still shows the thread, with its messages, and can use it.
    await harness.electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getTitle() === "release-idle-second-window")
        ?.restore();
    });
    await expect(secondWindow.getByTestId("transcript")).toContainText("answer from Thread one");
    const composer = secondWindow.getByTestId("composer");
    await composer.fill("still here");
    await expect(composer).toHaveValue("still here");
  } finally {
    await harness.close();
  }
});

test("starting new threads releases the ones not viewed recently", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("release-idle-new-threads");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    const refs: ThreadRef[] = [];
    // Created threads open by themselves; nothing selects an existing thread here.
    for (const title of titles) {
      await createSessionViaIpc(window, workspacePath, title);
      await expect(window.locator(".chat-header__title")).toHaveText(title);
      const state = await getDesktopState(window);
      refs.push({ workspaceId: state.selectedWorkspaceId, sessionId: state.selectedSessionId });
    }
    await expectThreads(harness, {
      held: refs.slice(-3).map(keyOf),
      released: refs.slice(0, 2).map(keyOf),
    });
  } finally {
    await harness.close();
  }
});
