import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify, parseArgs } from "node:util";
import { computeFileSha256, renderCask, resolveCaskPath } from "./homebrew-tap-utils.mjs";

const execFile = promisify(execFileCallback);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const desktopDir = path.join(repoRoot, "apps", "desktop");

async function run(command, args, options = {}) {
  try {
    return await execFile(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: options.env ?? process.env,
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch (error) {
    if (error?.stdout) {
      process.stdout.write(error.stdout);
    }
    if (error?.stderr) {
      process.stderr.write(error.stderr);
    }
    throw error;
  }
}

async function packageDmg(version, outputDir) {
  await run(
    "pnpm",
    [
      "--dir",
      desktopDir,
      "exec",
      "electron-builder",
      "--mac",
      "dmg",
      "--publish",
      "never",
      `-c.directories.output=${outputDir}`,
      `-c.extraMetadata.version=${version}`,
    ],
    {
      env: {
        ...process.env,
        CSC_IDENTITY_AUTO_DISCOVERY: "false",
      },
    },
  );

  return path.join(outputDir, `pi-gui-${version}-arm64.dmg`);
}

async function plistVersion(appPath) {
  const { stdout } = await run("/usr/libexec/PlistBuddy", [
    "-c",
    "Print :CFBundleShortVersionString",
    path.join(appPath, "Contents", "Info.plist"),
  ]);
  return stdout.trim();
}

async function ensureBrewCommand(args, env) {
  const result = await run("brew", args, { env });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  return result;
}

async function brewRepo(tapName, env) {
  const { stdout } = await run("brew", ["--repo", tapName], { env });
  return stdout.trim();
}

async function verifyExecutableLaunch(executablePath, tempRoot) {
  const userDataDir = path.join(tempRoot, "launch-user-data");
  const agentDir = path.join(userDataDir, "agent");
  await mkdir(agentDir, { recursive: true });

  const child = spawn(executablePath, [], {
    cwd: path.dirname(executablePath),
    env: {
      ...process.env,
      PI_APP_OPEN_DEVTOOLS: "0",
      PI_APP_TEST_MODE: "background",
      PI_APP_USER_DATA_DIR: userDataDir,
      PI_CODING_AGENT_DIR: agentDir,
    },
    stdio: "ignore",
  });

  const stayedAlive = await new Promise((resolve, reject) => {
    const launchTimer = setTimeout(() => {
      cleanup();
      resolve(true);
    }, 8_000);

    const cleanup = () => {
      clearTimeout(launchTimer);
      child.removeAllListeners("error");
      child.removeAllListeners("exit");
    };

    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      resolve({ code, signal });
    });
  });

  if (stayedAlive !== true) {
    throw new Error(
      `Upgraded app exited too early: ${JSON.stringify(stayedAlive)}.`,
    );
  }

  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const forceKillTimer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(undefined);
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(forceKillTimer);
      resolve(undefined);
    });
  });
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "cask-token": { type: "string", default: `pi-gui-homebrew-proof-${process.pid}` },
      "keep-temp": { type: "boolean", default: false },
      "tap-name": { type: "string", default: `codex/pi-gui-proof-${process.pid}` },
      "version-a": { type: "string", default: "0.1.0-beta.9000" },
      "version-b": { type: "string", default: "0.1.0-beta.9001" },
    },
    strict: true,
  });

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-gui-homebrew-proof-"));
  const appDir = path.join(tempRoot, "Applications");
  const cacheDir = path.join(tempRoot, "cache");
  const releaseDirA = path.join(tempRoot, "release-a");
  const releaseDirB = path.join(tempRoot, "release-b");
  const tapDir = path.join(tempRoot, "homebrew-tap");
  const brewEnv = {
    ...process.env,
    HOMEBREW_CACHE: cacheDir,
    HOMEBREW_NO_AUTO_UPDATE: "1",
    HOMEBREW_NO_ENV_HINTS: "1",
  };
  const qualifiedToken = `${values["tap-name"]}/${values["cask-token"]}`;
  const caskPath = resolveCaskPath(tapDir, values["cask-token"]);
  const appBundlePath = path.join(appDir, "pi-gui.app");
  const executablePath = path.join(appBundlePath, "Contents", "MacOS", "pi-gui");

  await mkdir(appDir, { recursive: true });
  await mkdir(cacheDir, { recursive: true });
  await mkdir(path.join(tapDir, "Casks"), { recursive: true });

  try {
    await run("pnpm", ["--filter", "@pi-gui/desktop", "run", "build"]);

    const dmgA = await packageDmg(values["version-a"], releaseDirA);
    const dmgB = await packageDmg(values["version-b"], releaseDirB);
    const shaA = await computeFileSha256(dmgA);
    const shaB = await computeFileSha256(dmgB);

    await writeFile(
      caskPath,
      renderCask({
        assetUrl: pathToFileURL(dmgA).toString(),
        caskToken: values["cask-token"],
        sha256: shaA,
        version: values["version-a"],
      }),
      "utf8",
    );

    await run("git", ["init", "-b", "main"], { cwd: tapDir });
    await run("git", ["config", "user.name", "Codex"], { cwd: tapDir });
    await run("git", ["config", "user.email", "codex@example.com"], { cwd: tapDir });
    await run("git", ["add", "."], { cwd: tapDir });
    await run("git", ["commit", "-m", `Seed ${values["cask-token"]} ${values["version-a"]}`], { cwd: tapDir });

    await ensureBrewCommand(["untap", values["tap-name"]], brewEnv).catch(() => undefined);
    await ensureBrewCommand(["uninstall", "--cask", "--force", values["cask-token"]], brewEnv).catch(() => undefined);
    await ensureBrewCommand(["tap", "--custom-remote", values["tap-name"], tapDir], brewEnv);
    const tappedRepoDir = await brewRepo(values["tap-name"], brewEnv);
    const tappedCaskPath = resolveCaskPath(tappedRepoDir, values["cask-token"]);
    await ensureBrewCommand(["install", "--cask", qualifiedToken, "--appdir", appDir], brewEnv);

    assert.equal(await plistVersion(appBundlePath), values["version-a"]);

    await writeFile(
      tappedCaskPath,
      renderCask({
        assetUrl: pathToFileURL(dmgB).toString(),
        caskToken: values["cask-token"],
        sha256: shaB,
        version: values["version-b"],
      }),
      "utf8",
    );
    await run("git", ["add", tappedCaskPath], { cwd: tappedRepoDir });
    await run("git", ["commit", "-m", `Upgrade ${values["cask-token"]} to ${values["version-b"]}`], {
      cwd: tappedRepoDir,
    });

    await ensureBrewCommand(["upgrade", "--cask", qualifiedToken, "--appdir", appDir], brewEnv);
    assert.equal(await plistVersion(appBundlePath), values["version-b"]);
    await verifyExecutableLaunch(executablePath, tempRoot);

    process.stdout.write(`Verified Homebrew install and upgrade flow in ${tempRoot}.\n`);
  } finally {
    await ensureBrewCommand(["uninstall", "--cask", "--force", values["cask-token"]], brewEnv).catch(() => undefined);
    await ensureBrewCommand(["untap", values["tap-name"]], brewEnv).catch(() => undefined);
    if (!values["keep-temp"]) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
