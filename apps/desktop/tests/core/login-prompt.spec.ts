import { expect, test, type Page } from "@playwright/test";
import {
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

/**
 * Electron doesn't implement window.prompt(), so the provider-login text prompt
 * used to throw for every login. It's now served by a dedicated modal window.
 * These drive that modal on the real Electron surface via the test hook.
 */

type PromptOutcome = { ok: true; value: string } | { ok: false; error: string };

async function beginPrompt(
  electronApp: Awaited<ReturnType<typeof launchDesktop>>["electronApp"],
  message: string,
  placeholder: string,
): Promise<void> {
  await electronApp.evaluate(
    (_electron, payload) => {
      const hooks = (
        globalThis as {
          __PI_APP_TEST_HOOKS?: {
            promptForText?: (
              message: string,
              placeholder?: string,
              allowEmpty?: boolean,
            ) => Promise<string>;
          };
        }
      ).__PI_APP_TEST_HOOKS;
      if (!hooks?.promptForText) {
        throw new Error("promptForText test hook is unavailable");
      }
      (globalThis as { __promptOutcome?: Promise<PromptOutcome> }).__promptOutcome = hooks
        .promptForText(payload.message, payload.placeholder, false)
        .then((value) => ({ ok: true as const, value }))
        .catch((error: unknown) => ({
          ok: false as const,
          error: error instanceof Error ? error.message : String(error),
        }));
    },
    { message, placeholder },
  );
}

// Clicking OK or Cancel resolves the prompt, and main then destroys the modal.
// That can land while Playwright is still finishing the click (the mouse-up
// reply or its hit-target cleanup), which rejects the click with "Target page
// closed" even though the click worked. Wait for the window to close instead,
// and only tolerate a click error once the window is really gone.
async function clickAndWaitForClose(modal: Page, selector: string): Promise<void> {
  const closed = modal.waitForEvent("close");
  await modal.click(selector).catch((error: unknown) => {
    if (!modal.isClosed()) {
      throw error;
    }
  });
  await closed;
}

async function readPromptOutcome(
  electronApp: Awaited<ReturnType<typeof launchDesktop>>["electronApp"],
): Promise<PromptOutcome> {
  return electronApp.evaluate(
    () =>
      (globalThis as { __promptOutcome?: Promise<PromptOutcome> })
        .__promptOutcome as Promise<PromptOutcome>,
  );
}

test("resolves the login prompt from the modal input", async () => {
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("login-prompt-submit");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);

    const modalPromise = harness.electronApp.waitForEvent("window");
    await beginPrompt(harness.electronApp, "Enter your API key", "sk-...");
    const modal = await modalPromise;

    await modal.waitForSelector("body[data-pi-ready='1']");
    await modal.fill("#pi-prompt-input", "  secret-token  ");
    await clickAndWaitForClose(modal, "#pi-prompt-ok");

    const outcome = await readPromptOutcome(harness.electronApp);
    expect(outcome).toEqual({ ok: true, value: "secret-token" });
  } finally {
    await harness.close();
  }
});

test("rejects the login prompt when cancelled", async () => {
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("login-prompt-cancel");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);

    const modalPromise = harness.electronApp.waitForEvent("window");
    await beginPrompt(harness.electronApp, "Enter your API key", "sk-...");
    const modal = await modalPromise;

    await modal.waitForSelector("body[data-pi-ready='1']");
    await clickAndWaitForClose(modal, "#pi-prompt-cancel");

    const outcome = await readPromptOutcome(harness.electronApp);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain("cancelled");
    }
  } finally {
    await harness.close();
  }
});
