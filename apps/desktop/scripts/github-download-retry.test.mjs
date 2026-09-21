import assert from "node:assert/strict";
import test from "node:test";

import {
  githubDownloadRetryDelayMs,
  isTransientGithubDownloadFailure,
  withGithubDownloadRetry,
} from "./github-download-retry.mjs";

const windowsWinCodeSign504 = [
  "  • updating asar integrity executable resource  executablePath=release\\win-unpacked\\pi-gui.exe",
  "  ⨯ cannot resolve https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-2.6.0/winCodeSign-2.6.0.7z: status code 504",
  "  ⨯ app-builder.exe process failed ERR_ELECTRON_BUILDER_CANNOT_EXECUTE",
].join("\n");

const linuxElectron504 =
  "cannot resolve https://github.com/electron/electron/releases/download/v37.10.3/electron-v37.10.3-linux-x64.zip: status code 504";

test("classifies GitHub 504 downloads of winCodeSign and Electron as transient", () => {
  assert.equal(isTransientGithubDownloadFailure(windowsWinCodeSign504), true);
  assert.equal(isTransientGithubDownloadFailure(linuxElectron504), true);
  assert.equal(
    isTransientGithubDownloadFailure(
      "cannot resolve https://github.com/electron/electron/releases/download/v37.10.3/electron-v37.10.3-linux-x64.zip: status code 502",
    ),
    true,
  );
  assert.equal(
    isTransientGithubDownloadFailure(
      "cannot resolve https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-2.6.0/winCodeSign-2.6.0.7z: status code 503",
    ),
    true,
  );
});

test("does not retry ordinary electron-builder failures", () => {
  assert.equal(isTransientGithubDownloadFailure(""), false);
  assert.equal(
    isTransientGithubDownloadFailure("ERR_ELECTRON_BUILDER_CANNOT_EXECUTE\nExit code:\n1"),
    false,
  );
  assert.equal(
    isTransientGithubDownloadFailure(
      "cannot resolve https://example.com/electron.zip: status code 504",
    ),
    false,
  );
  assert.equal(
    isTransientGithubDownloadFailure(
      "cannot resolve https://github.com/electron/electron/releases/download/v37.10.3/electron-v37.10.3-linux-x64.zip: status code 404",
    ),
    false,
  );
});

test("retries a GitHub 504 once and then succeeds", async () => {
  const attempts = [];
  const delays = [];
  const logs = [];
  const result = await withGithubDownloadRetry(
    async (attempt) => {
      attempts.push(attempt);
      if (attempt === 1) {
        return { ok: false, status: 1, output: windowsWinCodeSign504 };
      }
      return { ok: true, status: 0, output: "downloaded winCodeSign" };
    },
    {
      attempts: 3,
      baseDelayMs: 15_000,
      sleep: async (ms) => {
        delays.push(ms);
      },
      log: (message) => logs.push(message),
    },
  );

  assert.deepEqual(attempts, [1, 2]);
  assert.deepEqual(delays, [15_000]);
  assert.equal(githubDownloadRetryDelayMs(1), 15_000);
  assert.equal(githubDownloadRetryDelayMs(2), 30_000);
  assert.match(logs[0] ?? "", /transient download 5xx/);
  assert.equal(result.ok, true);
  assert.equal(result.status, 0);
});

test("stops immediately on a non-transient packaging failure", async () => {
  let runs = 0;
  const result = await withGithubDownloadRetry(
    async () => {
      runs += 1;
      return { ok: false, status: 1, output: "icon.ico: no such file" };
    },
    {
      sleep: async () => {
        throw new Error("should not sleep for a product failure");
      },
    },
  );
  assert.equal(runs, 1);
  assert.equal(result.ok, false);
  assert.equal(result.status, 1);
});

test("gives up after the last GitHub 504 attempt", async () => {
  const attempts = [];
  const result = await withGithubDownloadRetry(
    async (attempt) => {
      attempts.push(attempt);
      return { ok: false, status: 1, output: linuxElectron504 };
    },
    {
      attempts: 3,
      baseDelayMs: 1,
      sleep: async () => {},
      log: () => {},
    },
  );
  assert.deepEqual(attempts, [1, 2, 3]);
  assert.equal(result.ok, false);
  assert.equal(result.status, 1);
});
