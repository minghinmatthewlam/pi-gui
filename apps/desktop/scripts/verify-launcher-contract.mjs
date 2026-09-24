import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { run, spawnProcess } from "./launcher.mjs";

const require = createRequire(import.meta.url);
const { augmentPosixPath } = require("./augment-path.cjs");

const POSIX_DELIMITER = ":";

// ---------------------------------------------------------------------------
// PATH augmentation contract
// ---------------------------------------------------------------------------

function verifyPathContract() {
  // Windows PATH must be left completely untouched (no POSIX entries, no
  // delimiter rewriting).
  const win = augmentPosixPath({
    platform: "win32",
    env: { PATH: "C:\\Windows;C:\\Windows\\System32", HOME: undefined },
  });
  assert.equal(win.changed, false, "win32 PATH must not change");
  assert.equal(win.path, "C:\\Windows;C:\\Windows\\System32", "win32 PATH must be verbatim");

  // POSIX with HOME set prepends the missing bin dirs using the POSIX delimiter.
  const posix = augmentPosixPath({
    platform: "darwin",
    env: { PATH: "/usr/bin", HOME: "/Users/pi" },
    delimiter: POSIX_DELIMITER,
  });
  assert.equal(posix.changed, true, "posix PATH should be augmented");
  assert.deepEqual(
    posix.path.split(POSIX_DELIMITER),
    ["/opt/homebrew/bin", "/usr/local/bin", "/Users/pi/.npm-global/bin", "/usr/bin"],
    "posix PATH must prepend missing bin dirs in order",
  );

  // POSIX without HOME must not inject a literal `undefined/.npm-global/bin`.
  const noHome = augmentPosixPath({
    platform: "linux",
    env: { PATH: "/usr/bin", HOME: undefined },
    delimiter: POSIX_DELIMITER,
  });
  assert.ok(!noHome.path.includes("undefined"), "must not inject `undefined/.npm-global/bin`");
  assert.deepEqual(noHome.path.split(POSIX_DELIMITER), [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
  ]);

  // Idempotent: entries already present are not duplicated.
  const already = augmentPosixPath({
    platform: "darwin",
    env: {
      PATH: "/opt/homebrew/bin:/usr/local/bin:/Users/pi/.npm-global/bin:/usr/bin",
      HOME: "/Users/pi",
    },
    delimiter: POSIX_DELIMITER,
  });
  assert.equal(already.changed, false, "already-present entries must not be re-added");

  console.log("ok - PATH augmentation contract");
}

// ---------------------------------------------------------------------------
// Launcher argv contract + path-with-spaces dev-launch smoke
// ---------------------------------------------------------------------------

// Mirrors what `pnpm dev -- --remoteDebuggingPort 9222` forwards, plus
// arguments that a shell would mangle (spaces, `=`, quotes, globs).
const FORWARDED_ARGV = [
  "--remoteDebuggingPort",
  "9222",
  "--flag=value with spaces",
  "a b c",
  "*.ts",
  'quote"inside',
];

function writeArgvEchoScript(dir) {
  const scriptPath = path.join(dir, "echo-argv.mjs");
  writeFileSync(
    scriptPath,
    [
      "import { writeFileSync } from 'node:fs';",
      "const out = process.env.ARGV_OUT;",
      "writeFileSync(out, JSON.stringify(process.argv.slice(2)));",
      "",
    ].join("\n"),
  );
  return scriptPath;
}

function writeShim(dir, marker) {
  // A stand-in for the pnpm `.cmd`/executable shim that broke
  // `spawn` on Windows. cross-spawn must resolve it by name off PATH without a
  // shell.
  if (process.platform === "win32") {
    const shimPath = path.join(dir, "pi-launch-shim.cmd");
    writeFileSync(shimPath, `@echo off\r\necho ${marker}\r\n`);
    return shimPath;
  }
  const shimPath = path.join(dir, "pi-launch-shim");
  writeFileSync(shimPath, `#!/bin/sh\necho ${marker}\n`);
  chmodSync(shimPath, 0o755);
  return shimPath;
}

async function verifyLauncherContract() {
  const spacedDir = mkdtempSync(path.join(os.tmpdir(), "pi gui launcher "));
  const workdir = path.join(spacedDir, "work dir");
  mkdirSync(workdir, { recursive: true });

  // Capture Node deprecation warnings (DEP0190 fires for spawn with
  // `{ shell: true }` and an args array — the pattern we removed).
  const warnings = [];
  const onWarning = (warning) => warnings.push(warning);
  process.on("warning", onWarning);

  try {
    // 1) argv is forwarded verbatim, from a working dir containing spaces.
    // `run` inherits process.env, so the child reads ARGV_OUT from there.
    const argvOut = path.join(workdir, "argv.json");
    const echoScript = writeArgvEchoScript(workdir);
    process.env.ARGV_OUT = argvOut;
    try {
      await run(process.execPath, [echoScript, ...FORWARDED_ARGV], workdir);
    } finally {
      delete process.env.ARGV_OUT;
    }
    const receivedArgv = JSON.parse(readFileSync(argvOut, "utf8"));
    assert.deepEqual(
      receivedArgv,
      FORWARDED_ARGV,
      "argv must be forwarded exactly (no shell re-interpretation)",
    );
    console.log("ok - argv preserved exactly from a path containing spaces");

    // 2) a `.cmd`/executable shim resolves by name off PATH (no `spawn ENOENT`).
    const marker = "pi-launch-shim-ok";
    writeShim(workdir, marker);
    const shimOutput = await captureStdout("pi-launch-shim", [], {
      cwd: workdir,
      env: { ...process.env, PATH: `${workdir}${path.delimiter}${process.env.PATH ?? ""}` },
    });
    assert.ok(
      shimOutput.includes(marker),
      `shim must launch without ENOENT (got: ${JSON.stringify(shimOutput)})`,
    );
    console.log("ok - .cmd/executable shim resolves without ENOENT");

    // 3) none of the above emitted the DEP0190 shell-spawn deprecation.
    const dep0190 = warnings.find(
      (w) => w?.code === "DEP0190" || /DEP0190/.test(String(w?.message)),
    );
    assert.equal(dep0190, undefined, "launcher must not emit the DEP0190 shell-spawn deprecation");
    console.log("ok - no DEP0190 deprecation warning");
  } finally {
    process.off("warning", onWarning);
    rmSync(spacedDir, { recursive: true, force: true });
  }
}

function captureStdout(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
    child.once("error", reject);
    // "close" waits for stdout to drain; "exit" can fire before the last chunk arrives.
    child.once("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(`${command} exited with ${code}: ${stderr}`));
    });
  });
}

verifyPathContract();
await verifyLauncherContract();
console.log("Verified dev launcher argv/PATH contract");
