import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  selectSession,
} from "../helpers/electron-app";

test("opening New thread flushes the current conversation draft before navigation", async () => {
  const harness = await launchDesktop(await makeUserDataDir(), {
    initialWorkspaces: [await makeWorkspace("new-thread-draft")],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Original conversation");
    // Hold the ordinary debounce so the navigation flush, not elapsed time, must save the draft.
    await window.evaluate(() => {
      const schedule = globalThis.window.setTimeout.bind(globalThis.window);
      globalThis.window.setTimeout = (handler: TimerHandler, delay?: number, ...args: unknown[]) =>
        schedule(handler, delay === 350 ? 60_000 : delay, ...args);
    });
    const draft = "Keep this unsent draft in the original conversation";
    await window.getByTestId("composer").fill(draft);
    await window
      .getByRole("complementary")
      .getByRole("button", { name: "New thread", exact: true })
      .click();
    await expect(window.getByLabel("New thread prompt", { exact: true })).toBeVisible();
    await expect.poll(async () => (await getDesktopState(window)).composerDraft).toBe(draft);
    await createNamedThread(window, "Another conversation");
    await expect(window.getByTestId("composer")).toHaveValue("");
    await selectSession(window, "Original conversation");
    await expect(window.getByTestId("composer")).toHaveValue(draft);
  } finally {
    await harness.close();
  }
});
