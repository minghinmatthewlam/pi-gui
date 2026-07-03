import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopDir, "..", "..");
const rawArgs = process.argv.slice(2);
const extraArgs = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;

// pnpm uses package filters to identify workspace packages
const packageFilters = ["@pi-gui/session-driver", "@pi-gui/pi-sdk-driver", "@pi-gui/catalogs"];

// Bun handles these manually by directory
const packagePaths = [
  path.resolve(repoRoot, "packages/session-driver"),
  path.resolve(repoRoot, "packages/pi-sdk-driver"),
  path.resolve(repoRoot, "packages/catalogs"),
];

const isBun = process.versions.bun || process.env.npm_config_user_agent?.includes("bun");
const isWin = process.platform === "win32";
const pnpmCmd = isWin ? "pnpm.cmd" : "pnpm";

async function run(cmd, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: "inherit",
      env: process.env,
      shell: isWin,
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${cmd} ${args.join(" ")} exited with ${signal ?? code}`));
    });
  });
}

function start(cmd, args, cwd) {
  return spawn(cmd, args, {
    cwd,
    stdio: "inherit",
    env: process.env,
    shell: isWin,
  });
}

async function main() {
  if (isBun) {
    for (const pkgPath of packagePaths) {
      await run("bun", ["run", "build"], pkgPath);
    }
  } else {
    await run(
      pnpmCmd,
      ["--dir", repoRoot, "--filter", packageFilters[0], "--filter", packageFilters[1], "--filter", packageFilters[2], "run", "build"],
      desktopDir,
    );
  }

  const children = isBun
    ? [
        ...packagePaths.map((pkgPath) =>
          start("bun", ["x", "tsc", "-w", "-p", "tsconfig.json"], pkgPath),
        ),
        start("bun", ["x", "electron-vite", "dev", "--watch", ...extraArgs], desktopDir),
      ]
    : [
        start(
          pnpmCmd,
          [
            "--dir",
            repoRoot,
            "--parallel",
            "--filter",
            packageFilters[0],
            "--filter",
            packageFilters[1],
            "--filter",
            packageFilters[2],
            "run",
            "build",
            "--watch",
          ],
          desktopDir,
        ),
        start(pnpmCmd, ["exec", "electron-vite", "dev", "--watch", ...extraArgs], desktopDir),
      ];

  let exiting = false;
  const stopChildren = () => {
    if (exiting) {
      return;
    }
    exiting = true;
    for (const child of children) {
      if (!child.killed) {
        child.kill("SIGTERM");
      }
    }
  };

  for (const child of children) {
    child.once("exit", (code, signal) => {
      stopChildren();
      process.exitCode = code ?? (signal ? 1 : 0);
    });
    child.once("error", (error) => {
      console.error(error);
      stopChildren();
      process.exitCode = 1;
    });
  }

  process.once("SIGINT", () => {
    stopChildren();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    stopChildren();
    process.exit(143);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});