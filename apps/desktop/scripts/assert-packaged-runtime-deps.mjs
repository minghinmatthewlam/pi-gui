import { execFileSync } from "node:child_process";
import { constants, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import semver from "semver";

const requiredPackages = [
  // Keep packaging-sensitive runtime transitive deps explicit; electron-builder
  // can omit hoisted pnpm dependencies even when local development resolves them.
  "@anthropic-ai/sdk",
  "@aws-crypto/sha256-browser",
  "@aws-crypto/sha256-js",
  "@aws-sdk/client-bedrock-runtime",
  "@aws-sdk/core",
  "@aws-sdk/credential-provider-node",
  "@aws-sdk/eventstream-handler-node",
  "@aws-sdk/middleware-eventstream",
  "@aws-sdk/middleware-websocket",
  "@aws-sdk/nested-clients",
  "@aws-sdk/signature-v4-multi-region",
  "@aws-sdk/token-providers",
  "@aws-sdk/types",
  "@aws-sdk/xml-builder",
  "@aws/lambda-invoke-store",
  "@google/genai",
  "@mistralai/mistralai",
  "@opentelemetry/api",
  "@silvia-odwyer/photon-node",
  "@smithy/core",
  "@smithy/credential-provider-imds",
  "@smithy/fetch-http-handler",
  "@smithy/is-array-buffer",
  "@smithy/node-http-handler",
  "@smithy/property-provider",
  "@smithy/shared-ini-file-loader",
  "@smithy/signature-v4",
  "@smithy/types",
  "@smithy/util-buffer-from",
  "@smithy/util-utf8",
  "@xterm/addon-clipboard",
  "@xterm/addon-fit",
  "@xterm/addon-web-links",
  "@xterm/xterm",
  "ansi-regex",
  "balanced-match",
  "bowser",
  "brace-expansion",
  "chalk",
  "cross-spawn",
  "data-uri-to-buffer",
  "diff",
  "glob",
  "highlight.js",
  "hosted-git-info",
  "http-proxy-agent",
  "https-proxy-agent",
  "ignore",
  "jiti",
  "lru-cache",
  "mime-types",
  "minimatch",
  "node-pty",
  "openai",
  "parse5",
  "parse5-htmlparser2-tree-adapter",
  "path-key",
  "partial-json",
  "proper-lockfile",
  "proxy-agent",
  "retry",
  "semver",
  "shebang-command",
  "strip-ansi",
  "tslib",
  "typebox",
  "undici",
  "which",
  "yaml",
  "yargs",
];

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const packagePlatform = (process.env.PI_APP_PACKAGE_PLATFORM ?? process.platform)
  .trim()
  .toLowerCase();
const asarPath = resolveAsarPath(desktopDir, packagePlatform);
const notificationHelperPath =
  packagePlatform === "darwin"
    ? path.join(
        desktopDir,
        "release",
        "mac-arm64",
        "pi-gui.app",
        "Contents",
        "MacOS",
        "pi-gui-notification-status-helper",
      )
    : undefined;
const pnpmBinary = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const piCodingAgentPackageName = "@earendil-works/pi-coding-agent";
const requiredPiCodingAgentVersion = "0.87.0";
const modelChecks = [
  ...["luna", "sol", "terra"].map((variant) => ({
    provider: "openai-codex",
    id: `gpt-5.6-${variant}`,
    reason: "GPT 5.6 Codex support",
    requireReasoning: true,
    requireImageInput: true,
    requireMaxThinking: true,
  })),
  {
    provider: "anthropic",
    id: "claude-opus-4-7",
    reason: "issue #12 Opus 4.7 visibility",
    requireReasoning: true,
    requireImageInput: true,
  },
  {
    provider: "zai",
    id: "glm-5.3",
    reason: "issue #12 GLM visibility",
    requireReasoning: true,
    requireImageInput: false,
  },
];
const packagedRuntimeImportChecks = [
  // Import implementations: provider descriptors can defer loading their SDKs.
  ["@earendil-works", "pi-ai", "dist", "api", "google-generative-ai.js"],
  ["@earendil-works", "pi-ai", "dist", "api", "anthropic-messages.js"],
  ["@earendil-works", "pi-ai", "dist", "api", "openai-responses.js"],
  ["@earendil-works", "pi-ai", "dist", "bedrock-provider.js"],
  ["proxy-agent", "dist", "index.js"],
];

if (!existsSync(asarPath)) {
  throw new Error(`Packaged app.asar not found at ${asarPath}. Run the packaging step first.`);
}

if (notificationHelperPath && !existsSync(notificationHelperPath)) {
  throw new Error(`Packaged app is missing notification helper: ${notificationHelperPath}`);
}

const extractedDir = mkdtempSync(path.join(tmpdir(), "pi-gui-packaged-runtime-"));
let cleanupError;
try {
  execFileSync(pnpmBinary, ["exec", "asar", "extract", asarPath, extractedDir], {
    cwd: desktopDir,
    stdio: "pipe",
    shell: process.platform === "win32",
  });

  verifyRequiredPackages(extractedDir);
  verifyPiDependencyVersions(extractedDir);
  await verifyPackagedPiRuntime(extractedDir);
  await verifyPackagedRuntimeImports(extractedDir);
  await verifyNativeNodePty(asarPath);
} finally {
  try {
    rmSync(extractedDir, {
      recursive: true,
      force: true,
      maxRetries: process.platform === "win32" ? 5 : 0,
      retryDelay: process.platform === "win32" ? 200 : 0,
    });
  } catch (error) {
    if (process.platform === "win32") {
      console.warn(`Warning: could not remove temp dir ${extractedDir}: ${error.message}`);
    } else {
      cleanupError = error;
    }
  }
}

// Preserve a verification failure if cleanup also failed.
if (cleanupError) throw cleanupError;

console.log(`Verified packaged runtime dependencies in ${asarPath}`);

function resolveAsarPath(desktopDir, packagePlatform) {
  if (packagePlatform === "darwin") {
    return path.join(
      desktopDir,
      "release",
      "mac-arm64",
      "pi-gui.app",
      "Contents",
      "Resources",
      "app.asar",
    );
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

  if (packagePlatform === "win32") {
    const releaseDir = path.join(desktopDir, "release");
    const unpackedAsarPath = readdirSync(releaseDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^win(?:-[\w]+)?-unpacked$/.test(entry.name))
      .map((entry) => path.join(releaseDir, entry.name, "resources", "app.asar"))
      .find((candidatePath) => existsSync(candidatePath));

    if (unpackedAsarPath) {
      return unpackedAsarPath;
    }

    return path.join(releaseDir, "win-unpacked", "resources", "app.asar");
  }

  throw new Error(`Unsupported packaged runtime dependency target: ${packagePlatform}`);
}

function verifyRequiredPackages(extractedDir) {
  const missingPackages = requiredPackages.filter(
    (packageName) => !existsSync(path.join(extractedDir, "node_modules", packageName)),
  );

  if (missingPackages.length > 0) {
    throw new Error(`Packaged app is missing runtime dependencies: ${missingPackages.join(", ")}`);
  }
}

function verifyPiDependencyVersions(extractedDir) {
  const mismatches = [];
  // Validate the full required graph using the versions Node would resolve.
  // Hoisted packaging can include a dependency but lose its required nested version.
  const pending = [
    piCodingAgentPackageName,
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-tui",
    "@earendil-works/chord",
  ].map((packageName) => path.join(extractedDir, "node_modules", packageName, "package.json"));
  const visited = new Set();
  while (pending.length > 0) {
    const packageFile = pending.pop();
    if (visited.has(packageFile)) continue;
    visited.add(packageFile);
    const manifest = JSON.parse(readFileSync(packageFile, "utf8"));
    const resolveFromPackage = createRequire(packageFile);
    for (const [dependency, requiredVersion] of Object.entries(manifest.dependencies ?? {})) {
      const dependencyFile = (resolveFromPackage.resolve.paths(dependency) ?? [])
        // Never let dependencies installed outside the extracted app hide an omission.
        .filter((directory) => directory.startsWith(`${extractedDir}${path.sep}`))
        .map((directory) => path.join(directory, dependency, "package.json"))
        .find((candidate) => existsSync(candidate));
      const actualVersion = dependencyFile
        ? JSON.parse(readFileSync(dependencyFile, "utf8")).version
        : undefined;
      if (!actualVersion || !semver.satisfies(actualVersion, requiredVersion)) {
        mismatches.push(
          `${path.relative(extractedDir, packageFile)} (${manifest.version}) requires ${dependency}@${requiredVersion}; packaged resolution is ${actualVersion ?? "missing"}`,
        );
      }
      if (dependencyFile) pending.push(dependencyFile);
    }
  }
  if (mismatches.length > 0) {
    throw new Error(`Packaged Pi dependency versions do not match:\n${mismatches.join("\n")}`);
  }
}

async function verifyPackagedPiRuntime(extractedDir) {
  const packageJsonPath = path.join(
    extractedDir,
    "node_modules",
    ...piCodingAgentPackageName.split("/"),
    "package.json",
  );
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  if (packageJson.version !== requiredPiCodingAgentVersion) {
    throw new Error(
      `Packaged app has ${piCodingAgentPackageName} ${packageJson.version}; expected ${requiredPiCodingAgentVersion}.`,
    );
  }

  const runtimeEntry = path.join(
    extractedDir,
    "node_modules",
    ...piCodingAgentPackageName.split("/"),
    "dist",
    "index.js",
  );
  const { ModelRuntime } = await import(pathToFileURL(runtimeEntry).href);
  const authDir = mkdtempSync(path.join(tmpdir(), "pi-gui-packaged-runtime-models-"));
  const runtime = await ModelRuntime.create({
    authPath: path.join(authDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const models = runtime.getModels();
  for (const check of modelChecks) {
    const model = models.find(
      (entry) => entry.provider === check.provider && entry.id === check.id,
    );
    const modelKey = `${check.provider}/${check.id}`;
    if (!model) {
      throw new Error(`Packaged Pi runtime does not expose ${modelKey} for ${check.reason}.`);
    }
    if (check.requireReasoning && !model.reasoning) {
      throw new Error(`Packaged ${modelKey} is missing reasoning support for ${check.reason}.`);
    }
    if (check.requireImageInput && !model.input.includes("image")) {
      throw new Error(`Packaged ${modelKey} is missing image input support for ${check.reason}.`);
    }
    if (check.requireMaxThinking && model.thinkingLevelMap?.max !== "max") {
      throw new Error(`Packaged ${modelKey} is missing max thinking support for ${check.reason}.`);
    }
  }
}

async function verifyPackagedRuntimeImports(extractedDir) {
  for (const modulePath of packagedRuntimeImportChecks) {
    const runtimeEntry = path.join(extractedDir, "node_modules", ...modulePath);
    await import(pathToFileURL(runtimeEntry).href);
  }
}

async function verifyNativeNodePty(asarPath) {
  const unpackedResourcesDir = `${asarPath}.unpacked`;
  const nodePtyDir = path.join(unpackedResourcesDir, "node_modules", "node-pty");
  if (!existsSync(nodePtyDir) || !hasFileWithExtension(nodePtyDir, ".node")) {
    throw new Error(`Packaged app is missing unpacked node-pty native module under ${nodePtyDir}`);
  }
  if (packagePlatform !== "darwin") {
    return;
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
