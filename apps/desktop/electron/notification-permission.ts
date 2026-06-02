import { app, type BrowserWindow, shell } from "electron";
import { execFile } from "node:child_process";
import { appendFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { DesktopNotificationPermissionStatus } from "../src/ipc";

const execFileAsync = promisify(execFile);
const TEST_STATUS_ENV = "PI_APP_TEST_NOTIFICATION_PERMISSION_STATUS";
const TEST_REQUEST_RESULT_ENV = "PI_APP_TEST_NOTIFICATION_PERMISSION_REQUEST_RESULT";
const TEST_REQUEST_LOG_PATH_ENV = "PI_APP_TEST_NOTIFICATION_PERMISSION_REQUEST_LOG_PATH";
const TEST_SETTINGS_LOG_PATH_ENV = "PI_APP_TEST_NOTIFICATION_SETTINGS_LOG_PATH";
const TEST_HELPER_STATUS_ENV = "PI_APP_TEST_NOTIFICATION_PERMISSION_HELPER_STATUS";
const TEST_HELPER_STATUS_FILE_ENV = "PI_APP_TEST_NOTIFICATION_PERMISSION_HELPER_STATUS_FILE";
const TEST_HELPER_FOLLOWS_REQUEST_ENV = "PI_APP_TEST_NOTIFICATION_PERMISSION_HELPER_FOLLOWS_REQUEST";
const NOTIFICATION_STATUS_HELPER_NAME = "pi-gui-notification-status-helper";
const RECONCILIATION_POLL_INTERVAL_MS = 500;
const RECONCILIATION_MAX_POLLS = 20;

let testPermissionStatus = normalizePermissionStatus(process.env[TEST_STATUS_ENV]);

export class NotificationPermissionService {
  private window: BrowserWindow | null = null;
  private stopTrackingWindow: (() => void) | undefined;
  private readonly listeners = new Set<(status: DesktopNotificationPermissionStatus) => void>();
  private lastPublishedStatus: DesktopNotificationPermissionStatus = "unknown";
  private reconciliationBaselineStatus: DesktopNotificationPermissionStatus | null = null;
  private reconciliationPollTimer: ReturnType<typeof setTimeout> | undefined;
  private reconciliationPollCount = 0;
  private readonly handleAppReactivation = () => {
    void this.reconcileOnActivation();
  };

  constructor(private readonly getWindow: () => BrowserWindow | null) {
    app.on("activate", this.handleAppReactivation);
    app.on("browser-window-focus", this.handleAppReactivation);
  }

  dispose(): void {
    app.off("activate", this.handleAppReactivation);
    app.off("browser-window-focus", this.handleAppReactivation);
    this.clearReconciliationPoll();
    this.trackWindow(null);
    this.listeners.clear();
  }

  trackWindow(window: BrowserWindow | null): void {
    if (window === this.window) {
      return;
    }

    this.stopTrackingWindow?.();
    this.stopTrackingWindow = undefined;
    this.window = window && !window.isDestroyed() ? window : null;
    if (!this.window) {
      return;
    }

    const handleWindowActivation = () => {
      void this.reconcileOnActivation();
    };
    const clearTrackedWindow = () => {
      this.trackWindow(null);
    };

    this.window.on("focus", handleWindowActivation);
    this.window.on("show", handleWindowActivation);
    this.window.on("restore", handleWindowActivation);
    this.window.once("closed", clearTrackedWindow);
    this.stopTrackingWindow = () => {
      this.window?.off("focus", handleWindowActivation);
      this.window?.off("show", handleWindowActivation);
      this.window?.off("restore", handleWindowActivation);
      this.window?.off("closed", clearTrackedWindow);
    };
  }

  subscribe(listener: (status: DesktopNotificationPermissionStatus) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async getCurrentStatus(): Promise<DesktopNotificationPermissionStatus> {
    const status = await readNotificationPermissionStatus(this.getWindow());
    this.publish(status);
    return status;
  }

  async requestPermission(): Promise<DesktopNotificationPermissionStatus> {
    const status = await requestNotificationPermissionInternal(this.getWindow());
    this.publish(status);
    return status;
  }

  async ensurePermission(): Promise<DesktopNotificationPermissionStatus> {
    const current = await this.getCurrentStatus();
    if (current !== "default") {
      return current;
    }
    return this.requestPermission();
  }

  async openSystemSettings(): Promise<void> {
    this.reconciliationBaselineStatus = await this.getCurrentStatus();
    this.clearReconciliationPoll();
    await openSystemNotificationSettingsInternal();
  }

  private async reconcileOnActivation(): Promise<void> {
    const status = await this.getCurrentStatus();
    const baseline = this.reconciliationBaselineStatus;
    if (baseline === null) {
      return;
    }
    if (status !== baseline) {
      this.reconciliationBaselineStatus = null;
      this.clearReconciliationPoll();
      return;
    }
    this.startReconciliationPoll();
  }

  private startReconciliationPoll(): void {
    if (this.reconciliationPollTimer) {
      return;
    }

    this.reconciliationPollCount = 0;
    const tick = async () => {
      const baseline = this.reconciliationBaselineStatus;
      if (baseline === null) {
        this.clearReconciliationPoll();
        return;
      }

      const status = await this.getCurrentStatus();
      this.reconciliationPollCount += 1;
      if (status !== baseline || this.reconciliationPollCount >= RECONCILIATION_MAX_POLLS) {
        this.reconciliationBaselineStatus = null;
        this.clearReconciliationPoll();
        return;
      }

      this.reconciliationPollTimer = setTimeout(() => {
        void tick();
      }, RECONCILIATION_POLL_INTERVAL_MS);
    };

    this.reconciliationPollTimer = setTimeout(() => {
      void tick();
    }, RECONCILIATION_POLL_INTERVAL_MS);
  }

  private clearReconciliationPoll(): void {
    if (!this.reconciliationPollTimer) {
      return;
    }
    clearTimeout(this.reconciliationPollTimer);
    this.reconciliationPollTimer = undefined;
    this.reconciliationPollCount = 0;
  }

  private publish(status: DesktopNotificationPermissionStatus): void {
    if (status === this.lastPublishedStatus) {
      return;
    }
    this.lastPublishedStatus = status;
    for (const listener of this.listeners) {
      listener(status);
    }
  }
}

async function readNotificationPermissionStatus(
  window: BrowserWindow | null,
): Promise<DesktopNotificationPermissionStatus> {
  if (testPermissionStatus) {
    return testPermissionStatus;
  }

  const packagedMacOsStatus = await readPackagedMacOsNotificationPermissionStatus();
  if (packagedMacOsStatus) {
    return packagedMacOsStatus;
  }

  return readRendererNotificationPermission(window);
}

async function requestNotificationPermissionInternal(
  window: BrowserWindow | null,
): Promise<DesktopNotificationPermissionStatus> {
  await logPermissionRequestAttempt();
  const override = normalizePermissionStatus(process.env[TEST_REQUEST_RESULT_ENV]);
  if (process.platform === "darwin" && app.isPackaged) {
    if (override) {
      await updatePackagedHelperOverrideStatus(override);
      return readNotificationPermissionStatus(window);
    }

    const packagedMacOsStatus = await requestPackagedMacOsNotificationPermission();
    if (packagedMacOsStatus) {
      return packagedMacOsStatus;
    }
  }

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
    await updatePackagedHelperOverrideStatus(normalized);
    return readNotificationPermissionStatus(window);
  } catch {
    return "unknown";
  }
}

async function requestPackagedMacOsNotificationPermission(): Promise<DesktopNotificationPermissionStatus | undefined> {
  const helperPath = resolveNotificationStatusHelperPath();
  if (!helperPath) {
    return undefined;
  }

  try {
    const { stdout } = await execFileAsync(helperPath, ["--request"], {
      env: process.env,
    });
    const parsed = JSON.parse(stdout) as { status?: unknown };
    return normalizePermissionStatus(parsed.status) ?? "unknown";
  } catch {
    return undefined;
  }
}

async function openSystemNotificationSettingsInternal(): Promise<void> {
  const testLogPath = process.env[TEST_SETTINGS_LOG_PATH_ENV]?.trim();
  if (testLogPath) {
    await appendFile(testLogPath, `${new Date().toISOString()}\n`, "utf8");
    return;
  }

  if (process.platform === "win32") {
    await shell.openExternal("ms-settings:notifications");
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

async function readPackagedMacOsNotificationPermissionStatus(): Promise<DesktopNotificationPermissionStatus | undefined> {
  const helperPath = resolveNotificationStatusHelperPath();
  if (!helperPath) {
    return undefined;
  }
  try {
    const { stdout } = await execFileAsync(helperPath, [], {
      env: process.env,
    });
    const parsed = JSON.parse(stdout) as { status?: unknown };
    return normalizePermissionStatus(parsed.status);
  } catch {
    return undefined;
  }
}

function resolveNotificationStatusHelperPath(): string | undefined {
  if (process.platform !== "darwin" || !app.isPackaged) {
    return undefined;
  }

  return path.join(process.resourcesPath, "..", "MacOS", NOTIFICATION_STATUS_HELPER_NAME);
}

async function logPermissionRequestAttempt(): Promise<void> {
  const testLogPath = process.env[TEST_REQUEST_LOG_PATH_ENV]?.trim();
  if (!testLogPath) {
    return;
  }

  await appendFile(testLogPath, `${new Date().toISOString()}\n`, "utf8");
}

async function updatePackagedHelperOverrideStatus(status: DesktopNotificationPermissionStatus): Promise<void> {
  if (process.env[TEST_HELPER_FOLLOWS_REQUEST_ENV] !== "1") {
    return;
  }

  const helperStatusFilePath = process.env[TEST_HELPER_STATUS_FILE_ENV]?.trim();
  if (helperStatusFilePath) {
    await writeFile(helperStatusFilePath, `${status}\n`, "utf8");
    return;
  }

  if (!(TEST_HELPER_STATUS_ENV in process.env) || !normalizePermissionStatus(process.env[TEST_HELPER_STATUS_ENV])) {
    return;
  }
  process.env[TEST_HELPER_STATUS_ENV] = status;
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
