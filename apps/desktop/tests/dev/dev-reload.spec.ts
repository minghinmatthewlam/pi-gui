import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, chromium, type Browser, type Page } from "@playwright/test";
import { makeUserDataDir } from "../helpers/electron-app";

const desktopDir = path.resolve(__dirname, "..", "..");
const cdpPort = 9333;
const devPort = 5174;
const cdpUrl = `http://127.0.0.1:${cdpPort}`;
const probes = {
  renderer: {
    markerName: "renderer",
    filePath: path.resolve(desktopDir, "src/dev-reload-probe.ts"),
    exportName: "RENDERER_DEV_RELOAD_MARKER",
    before: "renderer-probe-v1",
    after: "renderer-probe-v2",
  },
  main: {
    markerName: "main",
    filePath: path.resolve(desktopDir, "electron/dev-reload-main-probe.ts"),
    exportName: "MAIN_DEV_RELOAD_MARKER",
    before: "main-probe-v1",
    after: "main-probe-v2",
  },
  preload: {
    markerName: "preload",
    filePath: path.resolve(desktopDir, "electron/dev-reload-preload-probe.ts"),
    exportName: "PRELOAD_DEV_RELOAD_MARKER",
    before: "preload-probe-v1",
    after: "preload-probe-v2",
  },
  sessionDriver: {
    markerName: "session-driver",
    filePath: path.resolve(desktopDir, "../../packages/session-driver/src/dev-reload-probe.ts"),
    exportName: "SESSION_DRIVER_DEV_RELOAD_MARKER",
    before: "session-driver-probe-v1",
    after: "session-driver-probe-v2",
  },
  piSdkDriver: {
    markerName: "pi-sdk-driver",
    filePath: path.resolve(desktopDir, "../../packages/pi-sdk-driver/src/dev-reload-probe.ts"),
    exportName: "PI_SDK_DRIVER_DEV_RELOAD_MARKER",
    before: "pi-sdk-driver-probe-v1",
    after: "pi-sdk-driver-probe-v2",
  },
  catalogs: {
    markerName: "catalogs",
    filePath: path.resolve(desktopDir, "../../packages/catalogs/src/dev-reload-probe.ts"),
    exportName: "CATALOGS_DEV_RELOAD_MARKER",
    before: "catalogs-probe-v1",
    after: "catalogs-probe-v2",
  },
} as const;

test.setTimeout(240_000);

type ProbeName = keyof typeof probes;
type ProbeRecord = (typeof probes)[ProbeName];

class DevDesktopHarness {
  private browser: Browser | null = null;
  private page: Page | null = null;
  readonly logs: string[] = [];

  constructor(readonly process: ChildProcessWithoutNullStreams) {}

  appendLog(chunk: string) {
    this.logs.push(chunk);
    if (this.logs.length > 200) {
      this.logs.splice(0, this.logs.length - 200);
    }
  }

  async marker(name: string): Promise<string> {
    const readMarker = async (page: Page) =>
      page.evaluate(async (markerName) => {
        if (markerName === "main") {
          const pingValue = await globalThis.window.piApp?.ping();
          return pingValue?.split(":")[1] ?? null;
        }
        return (
          window.__piDevReloadRenderer?.[markerName] ??
          window.__piDevReloadHost?.[markerName] ??
          null
        );
      }, name);

    const page = await this.getPage(2_500);
    try {
      return await readMarker(page);
    } catch {
      const reconnectedPage = await this.getPage(2_500, true);
      return await readMarker(reconnectedPage);
    }
  }

  async dispose(): Promise<void> {
    this.page = null;
    if (this.browser && this.browser.isConnected()) {
      await this.browser.close().catch(() => {});
    }
    this.browser = null;
    if (this.process.pid && this.process.exitCode == null) {
      try {
        process.kill(-this.process.pid, "SIGTERM");
      } catch {
        return;
      }
    }
    if (this.process.exitCode != null) {
      return;
    }
    const exited = new Promise<void>((resolve) => {
      this.process.once("exit", () => resolve());
    });
    await Promise.race([exited, delay(5_000)]);
    if (this.process.exitCode == null && this.process.pid) {
      try {
        process.kill(-this.process.pid, "SIGKILL");
      } catch {
        return;
      }
      await exited;
    }
  }

  private async getPage(timeoutMs: number, forceReconnect = false): Promise<Page> {
    if (forceReconnect) {
      if (this.browser && this.browser.isConnected()) {
        await this.browser.close().catch(() => {});
      }
      this.page = null;
      this.browser = null;
    }

    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        if (!this.browser || !this.browser.isConnected()) {
          this.browser = await chromium.connectOverCDP(cdpUrl);
        }
        if (!this.page || this.page.isClosed()) {
          this.page = await this.findFirstPage(this.browser, timeoutMs);
        }
        await this.page.waitForLoadState("domcontentloaded", { timeout: 1_500 });
        await this.page.waitForFunction(
          () => Boolean((window as Window & { piApp?: unknown }).piApp),
          undefined,
          {
            timeout: 1_500,
          },
        );
        return this.page;
      } catch (error) {
        lastError = error;
        this.page = null;
        if (this.browser && this.browser.isConnected()) {
          await this.browser.close().catch(() => {});
        }
        this.browser = null;
        await delay(250);
      }
    }

    throw new Error(
      `Failed to connect to desktop dev app: ${String(lastError)}\n${this.recentLogs()}`,
    );
  }

  private async findFirstPage(browser: Browser, timeoutMs: number): Promise<Page> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const page = browser
        .contexts()
        .flatMap((context) => context.pages())
        .find((candidate) => !candidate.isClosed());
      if (page) {
        return page;
      }
      await delay(250);
    }
    throw new Error(`Timed out waiting for an Electron renderer page.\n${this.recentLogs()}`);
  }

  private recentLogs(): string {
    return this.logs.join("").slice(-6_000);
  }
}

function buildProbeSource(probe: ProbeRecord, value: string): string {
  return `export const ${probe.exportName} = ${JSON.stringify(value)};\n`;
}

async function startDesktopDev(): Promise<DevDesktopHarness> {
  const userDataDir = await makeUserDataDir("pi-gui-dev-reload-");
  const child = spawn("pnpm", ["dev", "--", "--remoteDebuggingPort", String(cdpPort)], {
    cwd: desktopDir,
    env: {
      ...process.env,
      PI_APP_DEV_RELOAD_MARKERS: "1",
      PI_APP_DEV_PORT: String(devPort),
      PI_APP_OPEN_DEVTOOLS: "0",
      PI_APP_TEST_MODE: "background",
      PI_APP_USER_DATA_DIR: userDataDir,
      VITE_PI_APP_DEV_RELOAD_MARKERS: "1",
    },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const harness = new DevDesktopHarness(child);
  child.stdout.on("data", (chunk: Buffer) => harness.appendLog(chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => harness.appendLog(chunk.toString()));
  try {
    await waitForMarker(harness, probes.renderer.markerName, probes.renderer.before, 45_000);
    return harness;
  } catch (error) {
    await harness.dispose();
    throw error;
  }
}

async function waitForMarker(
  harness: DevDesktopHarness,
  name: string,
  expected: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if ((await harness.marker(name)) === expected) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }

  throw new Error(
    `Timed out waiting for marker ${name}=${expected}: ${String(lastError ?? "no marker value")}`,
  );
}

async function replaceProbeText(name: ProbeName, nextValue: string): Promise<() => Promise<void>> {
  const probe = probes[name];
  const filePath = probe.filePath;
  const original = await readFile(filePath, "utf8");
  await writeFile(filePath, buildProbeSource(probe, nextValue), "utf8");
  return async () => {
    await writeFile(filePath, original, "utf8");
  };
}

test("reloads running desktop app for renderer, Electron, and shared package edits", async () => {
  const harness = await startDesktopDev();
  const restoreSteps: Array<() => Promise<void>> = [];

  try {
    await waitForMarker(harness, probes.main.markerName, probes.main.before, 20_000);
    await waitForMarker(harness, probes.preload.markerName, probes.preload.before, 20_000);
    await waitForMarker(
      harness,
      probes.sessionDriver.markerName,
      probes.sessionDriver.before,
      20_000,
    );
    await waitForMarker(harness, probes.piSdkDriver.markerName, probes.piSdkDriver.before, 20_000);
    await waitForMarker(harness, probes.catalogs.markerName, probes.catalogs.before, 20_000);

    restoreSteps.unshift(await replaceProbeText("renderer", probes.renderer.after));
    await waitForMarker(harness, probes.renderer.markerName, probes.renderer.after, 20_000);

    restoreSteps.unshift(await replaceProbeText("main", probes.main.after));
    await waitForMarker(harness, probes.main.markerName, probes.main.after, 30_000);

    restoreSteps.unshift(await replaceProbeText("preload", probes.preload.after));
    await waitForMarker(harness, probes.preload.markerName, probes.preload.after, 30_000);

    restoreSteps.unshift(await replaceProbeText("sessionDriver", probes.sessionDriver.after));
    await waitForMarker(
      harness,
      probes.sessionDriver.markerName,
      probes.sessionDriver.after,
      20_000,
    );

    restoreSteps.unshift(await replaceProbeText("piSdkDriver", probes.piSdkDriver.after));
    await waitForMarker(harness, probes.piSdkDriver.markerName, probes.piSdkDriver.after, 20_000);

    restoreSteps.unshift(await replaceProbeText("catalogs", probes.catalogs.after));
    await waitForMarker(harness, probes.catalogs.markerName, probes.catalogs.after, 20_000);
  } finally {
    for (const restore of restoreSteps) {
      await restore();
    }
    await harness.dispose();
  }
});
