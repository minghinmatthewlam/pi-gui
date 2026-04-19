import { type BrowserWindow, shell } from "electron";
import { appendFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DesktopNotificationPermissionStatus } from "../src/ipc";

const execFileAsync = promisify(execFile);
const TEST_STATUS_ENV = "PI_APP_TEST_NOTIFICATION_PERMISSION_STATUS";
const TEST_REQUEST_RESULT_ENV = "PI_APP_TEST_NOTIFICATION_PERMISSION_REQUEST_RESULT";
const TEST_REQUEST_LOG_PATH_ENV = "PI_APP_TEST_NOTIFICATION_PERMISSION_REQUEST_LOG_PATH";
const TEST_SETTINGS_LOG_PATH_ENV = "PI_APP_TEST_NOTIFICATION_SETTINGS_LOG_PATH";

let testPermissionStatus = normalizePermissionStatus(process.env[TEST_STATUS_ENV]);

export async function getNotificationPermissionStatus(
  window: BrowserWindow | null,
): Promise<DesktopNotificationPermissionStatus> {
  if (testPermissionStatus) {
    return testPermissionStatus;
  }
  return readRendererNotificationPermission(window);
}

export async function requestNotificationPermission(
  window: BrowserWindow | null,
): Promise<DesktopNotificationPermissionStatus> {
  await logPermissionRequestAttempt();
  const override = normalizePermissionStatus(process.env[TEST_REQUEST_RESULT_ENV]);
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
    if (override) {
      testPermissionStatus = override;
      return override;
    }
    return "unknown";
  }

  try {
    const value = await window.webContents.executeJavaScript(
      override
        ? `globalThis.Notification ? Promise.resolve(${JSON.stringify(override)}) : Promise.resolve("unsupported")`
        : `globalThis.Notification ? Notification.requestPermission() : Promise.resolve("unsupported")`,
      true,
    );
    const normalized = normalizePermissionStatus(value) ?? "unknown";
    if (override) {
      testPermissionStatus = normalized;
    }
    return normalized;
  } catch {
    return "unknown";
  }
}

export async function ensureNotificationPermission(
  window: BrowserWindow | null,
): Promise<DesktopNotificationPermissionStatus> {
  const current = await getNotificationPermissionStatus(window);
  if (current !== "default") {
    return current;
  }
  return requestNotificationPermission(window);
}

export async function openSystemNotificationSettings(): Promise<void> {
  const testLogPath = process.env[TEST_SETTINGS_LOG_PATH_ENV]?.trim();
  if (testLogPath) {
    await appendFile(testLogPath, `${new Date().toISOString()}\n`, "utf8");
    return;
  }

  if (process.platform !== "darwin") {
    await shell.openExternal("https://support.apple.com/guide/mac-help/change-notifications-settings-mh40583/mac");
    return;
  }

  const targets = [
    "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
    "x-apple.systempreferences:com.apple.preference.notifications",
  ] as const;

  for (const target of targets) {
    try {
      await execFileAsync("open", [target]);
      return;
    } catch {
      // Try the next fallback.
    }
  }

  await shell.openPath("/System/Applications/System Settings.app");
}

async function readRendererNotificationPermission(
  window: BrowserWindow | null,
): Promise<DesktopNotificationPermissionStatus> {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
    return "unknown";
  }

  try {
    const value = await window.webContents.executeJavaScript(
      `globalThis.Notification?.permission ?? "unsupported"`,
      true,
    );
    return normalizePermissionStatus(value) ?? "unknown";
  } catch {
    return "unknown";
  }
}

async function logPermissionRequestAttempt(): Promise<void> {
  const testLogPath = process.env[TEST_REQUEST_LOG_PATH_ENV]?.trim();
  if (!testLogPath) {
    return;
  }

  await appendFile(testLogPath, `${new Date().toISOString()}\n`, "utf8");
}

function normalizePermissionStatus(value: unknown): DesktopNotificationPermissionStatus | undefined {
  switch (value) {
    case "granted":
    case "denied":
    case "default":
    case "unsupported":
    case "unknown":
      return value;
    default:
      return undefined;
  }
}
