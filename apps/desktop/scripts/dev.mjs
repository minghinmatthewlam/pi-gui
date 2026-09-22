import path from "node:path";
import { fileURLToPath } from "node:url";
import { run, start } from "./launcher.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopDir, "..", "..");
const rawArgs = process.argv.slice(2);
const extraArgs = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
const packageFilters = ["@pi-gui/session-driver", "@pi-gui/pi-sdk-driver", "@pi-gui/catalogs"];
const extensionUiPackage = "@pi-gui/extension-ui";

async function main() {
  await run(
    "pnpm",
    [
      "--dir",
      repoRoot,
      ...[...packageFilters, extensionUiPackage].flatMap((name) => ["--filter", name]),
      "run",
      "build",
    ],
    desktopDir,
  );

  const children = [
    start(
      "pnpm",
      [
        "--dir",
        repoRoot,
        "--parallel",
        ...packageFilters.flatMap((name) => ["--filter", name]),
        "run",
        "build",
        "--watch",
      ],
      desktopDir,
    ),
    start("pnpm", ["--dir", repoRoot, "--filter", extensionUiPackage, "run", "watch"], desktopDir),
    start("pnpm", ["exec", "electron-vite", "dev", "--watch", ...extraArgs], desktopDir),
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
