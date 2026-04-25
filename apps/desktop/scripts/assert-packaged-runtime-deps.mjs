import { execFileSync } from "node:child_process";
import { constants, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const requiredPackages = [
  "@xterm/addon-clipboard",
  "@xterm/addon-fit",
  "@xterm/addon-web-links",
  "@xterm/xterm",
  "balanced-match",
  "brace-expansion",
  "chalk",
  "glob",
  "hosted-git-info",
  "lru-cache",
  "minimatch",
  "node-pty",
];

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const packagePlatform = (process.env.PI_APP_PACKAGE_PLATFORM ?? process.platform).trim().toLowerCase();
const asarPath = resolveAsarPath(desktopDir, packagePlatform);
const notificationHelperPath =
  packagePlatform === "darwin"
    ? path.join(desktopDir, "release", "mac-arm64", "pi-gui.app", "Contents", "MacOS", "pi-gui-notification-status-helper")
    : undefined;
const pnpmBinary = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const requiredPiCodingAgentVersion = "0.70.2";

if (!existsSync(asarPath)) {
  throw new Error(`Packaged app.asar not found at ${asarPath}. Run the packaging step first.`);
}

const asarListing = execFileSync(pnpmBinary, ["exec", "asar", "list", asarPath], {
  cwd: desktopDir,
  encoding: "utf8",
});

const missingPackages = requiredPackages.filter((packageName) => {
  const escaped = packageName.replace("/", "\\/");
  const pattern = new RegExp(`^/node_modules/${escaped}(/|$)`, "m");
  return !pattern.test(asarListing);
});

if (missingPackages.length > 0) {
  throw new Error(`Packaged app is missing runtime dependencies: ${missingPackages.join(", ")}`);
}

if (notificationHelperPath && !existsSync(notificationHelperPath)) {
  throw new Error(`Packaged app is missing notification helper: ${notificationHelperPath}`);
}

await verifyNativeNodePty(asarPath);
await verifyPackagedPiRuntime(asarPath);

console.log(`Verified packaged runtime dependencies in ${asarPath}`);

function resolveAsarPath(desktopDir, packagePlatform) {
  if (packagePlatform === "darwin") {
    return path.join(desktopDir, "release", "mac-arm64", "pi-gui.app", "Contents", "Resources", "app.asar");
  }

  if (packagePlatform === "linux") {
    const releaseDir = path.join(desktopDir, "release");
    const unpackedAsarPath = readdirSync(releaseDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^linux(?:-[\w]+)?-unpacked$/.test(entry.name))
      .map((entry) => path.join(releaseDir, entry.name, "resources", "app.asar"))
      .find((candidatePath) => existsSync(candidatePath));

    if (unpackedAsarPath) {
      return unpackedAsarPath;
    }

    return path.join(releaseDir, "linux-unpacked", "resources", "app.asar");
  }

  throw new Error(`Unsupported packaged runtime dependency target: ${packagePlatform}`);
}

async function verifyPackagedPiRuntime(asarPath) {
  const extractedDir = mkdtempSync(path.join(tmpdir(), "pi-gui-packaged-runtime-"));
  try {
    execFileSync(pnpmBinary, ["exec", "asar", "extract", asarPath, extractedDir], {
      cwd: desktopDir,
      stdio: "pipe",
    });

    const packageJsonPath = path.join(extractedDir, "node_modules", "@mariozechner", "pi-coding-agent", "package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    if (packageJson.version !== requiredPiCodingAgentVersion) {
      throw new Error(
        `Packaged app has @mariozechner/pi-coding-agent ${packageJson.version}; expected ${requiredPiCodingAgentVersion}.`,
      );
    }

    const runtimeEntry = path.join(extractedDir, "node_modules", "@mariozechner", "pi-coding-agent", "dist", "index.js");
    const { AuthStorage, ModelRegistry } = await import(pathToFileURL(runtimeEntry).href);
    const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
    const codexModel = registry.getAll().find((model) => model.provider === "openai-codex" && model.id === "gpt-5.5");
    if (!codexModel?.reasoning || !codexModel.input.includes("image")) {
      throw new Error("Packaged Pi runtime does not expose openai-codex/gpt-5.5 with reasoning and image input.");
    }
  } finally {
    rmSync(extractedDir, { recursive: true, force: true });
  }
}

async function verifyNativeNodePty(asarPath) {
  const unpackedResourcesDir = `${asarPath}.unpacked`;
  const nodePtyDir = path.join(unpackedResourcesDir, "node_modules", "node-pty");
  if (!existsSync(nodePtyDir) || !hasFileWithExtension(nodePtyDir, ".node")) {
    throw new Error(`Packaged app is missing unpacked node-pty native module under ${nodePtyDir}`);
  }
  const helperPath = findFileNamed(nodePtyDir, "spawn-helper");
  if (!helperPath) {
    throw new Error(`Packaged app is missing unpacked node-pty spawn-helper under ${nodePtyDir}`);
  }
  await access(helperPath, constants.X_OK);
}

function hasFileWithExtension(directoryPath, extension) {
  for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isFile() && entry.name.endsWith(extension)) {
      return true;
    }
    if (entry.isDirectory() && hasFileWithExtension(entryPath, extension)) {
      return true;
    }
  }
  return false;
}

function findFileNamed(directoryPath, fileName) {
  for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isFile() && entry.name === fileName) {
      return entryPath;
    }
    if (entry.isDirectory()) {
      const nestedMatch = findFileNamed(entryPath, fileName);
      if (nestedMatch) {
        return nestedMatch;
      }
    }
  }
  return undefined;
}
