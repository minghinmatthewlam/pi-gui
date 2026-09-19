import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 20_000;

const OPEN_PANEL_SCRIPT = `
on run argv
  set targetPath to item 1 of argv
  tell application "System Events"
    set frontmostProcess to first application process whose frontmost is true
    set frontmost of frontmostProcess to true
    delay 0.6
    keystroke "g" using {command down, shift down}
    delay 0.5
    keystroke targetPath
    key code 36
    delay 0.75
    key code 36
    delay 0.75
    key code 36
  end tell
end run
`;

const APP_RUNNING_SCRIPT = `
on run argv
  set targetApp to item 1 of argv
  tell application "System Events"
    if exists application process targetApp then
      return "true"
    end if
  end tell
  return "false"
end run
`;

const QUIT_APP_SCRIPT = `
on run argv
  set targetApp to item 1 of argv
  tell application "System Events"
    if not (exists application process targetApp) then
      return
    end if
  end tell
  tell application targetApp to quit
end run
`;

const LOCK_DESKTOP_SCRIPT = `
tell application "System Events"
  key code 12 using {control down, command down}
end tell
`;

const LOCK_DESKTOP_COMMAND =
  "/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession";

export async function assertAccessibilityReady(): Promise<void> {
  const { stdout } = await execFileAsync(
    "osascript",
    ["-e", 'tell application "System Events" to UI elements enabled'],
    { timeout: DEFAULT_TIMEOUT_MS },
  );

  if (stdout.trim() !== "true") {
    throw new Error("macOS Accessibility permission is not enabled for UI scripting");
  }
}

export async function acceptOpenFolderDialog(pathValue: string): Promise<void> {
  await assertAccessibilityReady();
  await runAppleScript(OPEN_PANEL_SCRIPT, [pathValue], DEFAULT_TIMEOUT_MS);
}

export async function acceptOpenImageDialog(pathValue: string): Promise<void> {
  await assertAccessibilityReady();
  await runAppleScript(OPEN_PANEL_SCRIPT, [pathValue], DEFAULT_TIMEOUT_MS);
}

export async function getFrontmostAppName(): Promise<string> {
  const { stdout } = await execFileAsync(
    "osascript",
    [
      "-e",
      'tell application "System Events" to name of first application process whose frontmost is true',
    ],
    { timeout: DEFAULT_TIMEOUT_MS },
  );
  const appName = stdout.trim();
  if (!appName) {
    throw new Error("Could not determine the frontmost app from System Events.");
  }
  return appName;
}

async function openAppInBackground(appName: string): Promise<void> {
  await execFileAsync("open", ["-g", "-a", appName], { timeout: DEFAULT_TIMEOUT_MS });
}

export async function resetAppInBackground(appName: string): Promise<void> {
  await runAppleScript(QUIT_APP_SCRIPT, [appName], DEFAULT_TIMEOUT_MS);
  await waitForAppRunning(appName, false);
  await openAppInBackground(appName);
  await waitForAppRunning(appName, true);
}

export async function getDesktopLockState(): Promise<"locked" | "unlocked" | "unknown"> {
  if (process.platform !== "darwin") {
    return "unlocked";
  }

  let stdout = "";
  try {
    ({ stdout } = await execFileAsync("ioreg", ["-n", "Root", "-d1"], {
      timeout: DEFAULT_TIMEOUT_MS,
    }));
  } catch {
    return "unknown";
  }
  if (
    /"CGSSessionScreenIsLocked"\s*=\s*Yes/.test(stdout) ||
    /"IOConsoleLocked"\s*=\s*Yes/.test(stdout)
  ) {
    return "locked";
  }
  return "unlocked";
}

export async function lockDesktop(): Promise<void> {
  try {
    await execFileAsync(LOCK_DESKTOP_COMMAND, ["-suspend"], { timeout: DEFAULT_TIMEOUT_MS });
    return;
  } catch (error) {
    if (!isCgSessionFallbackError(error)) {
      throw error;
    }
  }
  await assertAccessibilityReady();
  await runAppleScript(LOCK_DESKTOP_SCRIPT, [], DEFAULT_TIMEOUT_MS);
}

export async function waitForDesktopLocked(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
  await waitForDesktopLockState("locked", timeoutMs);
}

async function waitForDesktopLockState(
  expected: "locked" | "unlocked",
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await getDesktopLockState()) === expected) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Desktop did not become ${expected} within ${timeoutMs}ms.`);
}

async function waitForAppRunning(appName: string, expected: boolean): Promise<void> {
  const deadline = Date.now() + DEFAULT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { stdout } = await execFileAsync(
      "osascript",
      ["-e", APP_RUNNING_SCRIPT.trim(), appName],
      {
        timeout: DEFAULT_TIMEOUT_MS,
      },
    );
    if ((stdout.trim() === "true") === expected) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(
    `${appName} did not become ${expected ? "running" : "not running"} within ${DEFAULT_TIMEOUT_MS}ms.`,
  );
}

async function runAppleScript(
  script: string,
  values: readonly string[],
  timeoutMs: number,
): Promise<void> {
  try {
    await execFileAsync("osascript", ["-e", script.trim(), ...values], {
      timeout: timeoutMs,
    });
  } catch (error) {
    if (typeof error === "object" && error !== null) {
      const message = "message" in error ? String(error.message) : String(error);
      const stdout = "stdout" in error ? String(error.stdout ?? "") : "";
      const stderr = "stderr" in error ? String(error.stderr ?? "") : "";
      const code = "code" in error ? String(error.code ?? "") : "";
      const signal = "signal" in error ? String(error.signal ?? "") : "";
      throw new Error(
        `${message}\nexit code: ${code || "<unknown>"}\nsignal: ${signal || "<none>"}\nstdout:\n${stdout || "<empty>"}\nstderr:\n${stderr || "<empty>"}`,
      );
    }

    throw new Error(String(error));
  }
}

function isCgSessionFallbackError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return error.code === "ENOENT" || typeof error.code === "number";
}
