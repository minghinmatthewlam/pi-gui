import { basename } from "node:path";
import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  desktopShortcut,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  selectSession,
  selectSidePanel,
  TINY_PNG_BASE64,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

// Linux terminals keep Ctrl+V for the shell and paste with Ctrl+Shift+V.
const TERMINAL_PASTE_SHORTCUT =
  process.platform === "linux" ? "Control+Shift+V" : desktopShortcut("V");

test("opens task terminals with persistent output and independent shell tabs", async () => {
  test.setTimeout(90_000);

  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("terminal-root");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await createNamedThread(window, "Terminal host thread");

    await selectSidePanel(window, "Terminal");
    const terminal = window.getByTestId("integrated-terminal");
    await expect(terminal).toBeVisible();
    await expect(window.getByTestId("terminal-tab")).toHaveCount(1);

    await terminal.locator(".xterm").click();
    await window.keyboard.type("printf 'PI_TERMINAL_OK\\n'; pwd");
    await window.keyboard.press("Enter");
    await expect(terminal.locator(".xterm-rows")).toContainText("PI_TERMINAL_OK", {
      timeout: 15_000,
    });
    await expect(terminal.locator(".xterm-rows")).toContainText(basename(workspacePath), {
      timeout: 15_000,
    });

    await window.keyboard.press(desktopShortcut("J"));
    await expect(terminal).toHaveCount(0);
    await window.keyboard.press(desktopShortcut("J"));
    await expect(window.getByTestId("integrated-terminal").locator(".xterm-rows")).toContainText(
      "PI_TERMINAL_OK",
      {
        timeout: 15_000,
      },
    );

    await createNamedThread(window, "Terminal other thread");
    await expect(window.getByTestId("integrated-terminal")).toHaveCount(0);
    await window.keyboard.press(desktopShortcut("J"));
    await expect(window.getByTestId("integrated-terminal")).toBeVisible();
    await expect(
      window.getByTestId("integrated-terminal").locator(".xterm-rows"),
    ).not.toContainText("PI_TERMINAL_OK");
    await selectSession(window, "Terminal host thread");
    await expect(window.getByTestId("integrated-terminal")).toBeVisible();
    await expect(window.getByTestId("integrated-terminal").locator(".xterm-rows")).toContainText(
      "PI_TERMINAL_OK",
      {
        timeout: 15_000,
      },
    );

    await window.getByTestId("integrated-terminal").locator(".xterm").click();
    await window.keyboard.press(desktopShortcut(","));
    await expect(window.getByTestId("settings-surface")).toHaveCount(0);
    await window.keyboard.press(desktopShortcut("Shift+O"));
    await expect(window.getByTestId("new-thread-composer")).toHaveCount(0);
    await harness.electronApp.evaluate(({ clipboard, nativeImage }, pngBase64) => {
      clipboard.writeImage(nativeImage.createFromDataURL(`data:image/png;base64,${pngBase64}`));
    }, TINY_PNG_BASE64);
    await window.keyboard.press(TERMINAL_PASTE_SHORTCUT);
    await expect
      .poll(async () => (await getDesktopState(window)).composerAttachments.length)
      .toBe(0);

    await window.getByLabel("New terminal").click();
    await expect(window.getByTestId("terminal-tab")).toHaveCount(2);
    await window.getByTestId("integrated-terminal").locator(".xterm").click();
    await window.keyboard.press(desktopShortcut("T"));
    await expect(window.getByTestId("terminal-tab")).toHaveCount(3);

    await expect(window.getByTestId("composer")).toBeVisible();

    await window
      .getByLabel(/Close Terminal/)
      .last()
      .click();
    await expect(window.getByTestId("terminal-tab")).toHaveCount(2);
  } finally {
    await harness.close();
  }
});

test("persists the integrated terminal shell setting", async () => {
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("terminal-settings");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);

    await window.keyboard.press(desktopShortcut(","));
    await expect(window.getByTestId("settings-surface")).toBeVisible();
    await window.getByRole("button", { name: "General", exact: true }).click();
    const shellInput = window.getByLabel("Shell of integrated terminal");
    await shellInput.fill("/bin/zsh");
    await shellInput.press("Enter");
    await expect
      .poll(async () => (await getDesktopState(window)).integratedTerminalShell)
      .toBe("/bin/zsh");
  } finally {
    await harness.close();
  }
});

test("pastes clipboard text into the integrated terminal once", async () => {
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("terminal-paste-once");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await createNamedThread(window, "Terminal paste thread");

    await selectSidePanel(window, "Terminal");
    const terminal = window.getByTestId("integrated-terminal");
    await expect(terminal).toBeVisible();
    await terminal.locator(".xterm").click();
    await expect(terminal.locator(".xterm-rows")).toContainText(
      new RegExp(`${escapeRegExp(basename(workspacePath))}|[#$%]\\s*$`),
      { timeout: 15_000 },
    );

    await harness.electronApp.evaluate(({ clipboard }) => {
      clipboard.writeText("PI_TERMINAL_PASTE_ONCE");
    });
    await window.keyboard.press(TERMINAL_PASTE_SHORTCUT);

    // Join rows so a paste that soft-wraps after a long prompt still counts once.
    await expect
      .poll(async () =>
        countOccurrences(
          ((await terminal.locator(".xterm-rows").innerText()) ?? "").replace(/\n/g, ""),
          "PI_TERMINAL_PASTE_ONCE",
        ),
      )
      .toBe(1);
  } finally {
    await harness.close();
  }
});

test("writes an oversized terminal paste in chunks instead of dropping it", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("terminal-paste-large");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await createNamedThread(window, "Terminal large paste thread");

    await selectSidePanel(window, "Terminal");
    const terminal = window.getByTestId("integrated-terminal");
    await expect(terminal).toBeVisible();
    await terminal.locator(".xterm").click();
    await expect(terminal.locator(".xterm-rows")).toContainText(
      new RegExp(`${escapeRegExp(basename(workspacePath))}|[#$%]\\s*$`),
      { timeout: 15_000 },
    );

    // Payload exceeds MAX_WRITE_LENGTH (128 KiB) so the old code path dropped the
    // whole write. 3000 lines of 63 chars + newline = 192000 bytes, then a unique
    // end marker so we can wait for the full paste to land before sending EOF.
    const lineCount = 3000;
    const payload = `${`${"X".repeat(63)}\n`.repeat(lineCount)}ENDMARKER\n`;
    expect(payload.length).toBeGreaterThan(128 * 1024);

    // Start a receiver that installs its stdin pipe before announcing readiness.
    // This keeps the test independent of whether the shell has handed the PTY to
    // the child by the time Playwright's Enter keypress resolves.
    const receiverReady = "PI_TERMINAL_RECEIVER_READY";
    const receiverDone = "PI_TERMINAL_RECEIVER_DONE";
    const receiverScript = [
      'const fs = require("node:fs")',
      'const output = fs.createWriteStream("payload.txt")',
      "process.stdin.pipe(output)",
      'process.stdout.write("PI_TERMINAL_RECEIVER_" + "READY\\n")',
    ].join(";");
    await window.keyboard.type(`node -e '${receiverScript}'; echo PI_TERMINAL_RECEIVER_""DONE`);
    await window.keyboard.press("Enter");
    await expect(terminal.locator(".xterm-rows")).toContainText(receiverReady, { timeout: 15_000 });

    await harness.electronApp.evaluate(({ clipboard }, text) => {
      clipboard.writeText(text);
    }, payload);
    await window.keyboard.press(TERMINAL_PASTE_SHORTCUT);
    await expect(terminal.locator(".xterm-rows")).toContainText("ENDMARKER", { timeout: 30_000 });

    await window.keyboard.press("Control+D");
    await expect(terminal.locator(".xterm-rows")).toContainText(receiverDone, { timeout: 15_000 });
    await window.keyboard.type("wc -l payload.txt");
    await window.keyboard.press("Enter");
    await expect(terminal.locator(".xterm-rows")).toContainText(`${lineCount + 1} payload.txt`, {
      timeout: 15_000,
    });
    await window.keyboard.type("tail -n 1 payload.txt");
    await window.keyboard.press("Enter");
    await expect(terminal.locator(".xterm-rows")).toContainText("ENDMARKER", { timeout: 15_000 });
  } finally {
    await harness.close();
  }
});

function countOccurrences(value: string, needle: string): number {
  let count = 0;
  let index = value.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = value.indexOf(needle, index + needle.length);
  }
  return count;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
