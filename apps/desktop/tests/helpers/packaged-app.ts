import { execFile } from "node:child_process";
import { cp, mkdtemp, readdir, realpath, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

const desktopDir = resolve(__dirname, "..", "..");
const packagedReleaseDir = join(desktopDir, "release");
const execFileAsync = promisify(execFile);

export async function resolvePackagedAppBundle(releaseDir = packagedReleaseDir): Promise<string> {
  let appBundles: string[];
  try {
    appBundles = await findAppBundles(releaseDir);
  } catch (error) {
    if (isMissingPathError(error)) {
      throw new Error(
        `Packaged release directory not found: ${releaseDir}. Run pnpm --filter @pi-gui/desktop run package:dir first.`,
      );
    }
    throw error;
  }

  const appBundle =
    appBundles.find((candidate) => basename(candidate) === "pi-gui.app") ?? appBundles[0];
  if (!appBundle) {
    throw new Error(
      `No .app bundle found under ${releaseDir}. Run pnpm --filter @pi-gui/desktop run package:dir first.`,
    );
  }

  return appBundle;
}

export async function resolvePackagedAppExecutable(
  releaseDir = packagedReleaseDir,
): Promise<string> {
  return resolveAppBundleExecutable(await resolvePackagedAppBundle(releaseDir));
}

export async function resolveAppBundleExecutable(appBundle: string): Promise<string> {
  const macOsDir = join(appBundle, "Contents", "MacOS");
  const entries = await readdir(macOsDir, { withFileTypes: true });
  const expectedExecutableName = basename(appBundle, ".app");
  const executableEntry =
    entries.find((entry) => entry.isFile() && entry.name === expectedExecutableName) ??
    entries.find((entry) => entry.isFile());

  if (!executableEntry) {
    throw new Error(`No packaged executable found under ${macOsDir}.`);
  }

  return join(macOsDir, executableEntry.name);
}

export async function resolvePackagedReleaseZip(releaseDir = packagedReleaseDir): Promise<string> {
  const entries = await readdir(releaseDir, { withFileTypes: true });
  const zipEntry =
    entries.find((entry) => entry.isFile() && entry.name.endsWith("-universal.zip")) ??
    entries.find((entry) => entry.isFile() && entry.name.endsWith("-arm64.zip")) ??
    entries.find((entry) => entry.isFile() && entry.name.endsWith("-mac.zip")) ??
    entries.find((entry) => entry.isFile() && entry.name.endsWith(".zip"));

  if (!zipEntry) {
    throw new Error(
      `No packaged macOS release zip found under ${releaseDir}. Run pnpm --filter @pi-gui/desktop run package first.`,
    );
  }

  return join(releaseDir, zipEntry.name);
}

export async function extractPackagedReleaseZipAppBundle(
  releaseDir = packagedReleaseDir,
  appName = "pi-gui 2.app",
): Promise<string> {
  const zipPath = await resolvePackagedReleaseZip(releaseDir);
  return extractAppBundleFromReleaseZip(zipPath, appName);
}

export async function extractAppBundleFromReleaseZip(
  zipPath: string,
  appName = "pi-gui 2.app",
): Promise<string> {
  const extractionDir = await mkdtemp(join(tmpdir(), "pi-gui-release-zip-"));
  await execFileAsync("ditto", ["-x", "-k", zipPath, extractionDir]);

  const extractedAppBundle = await resolvePackagedAppBundle(extractionDir);
  const renamedBundle = join(extractionDir, appName);

  if (extractedAppBundle !== renamedBundle) {
    try {
      await rename(extractedAppBundle, renamedBundle);
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "EXDEV"
      ) {
        throw error;
      }

      await cp(extractedAppBundle, renamedBundle, { recursive: true });
    }
  }

  return realpath(renamedBundle);
}

export async function copyAppBundle(
  sourceAppBundle: string,
  targetAppBundle: string,
): Promise<void> {
  await execFileAsync("ditto", [sourceAppBundle, targetAppBundle]);
}

async function findAppBundles(rootDir: string): Promise<string[]> {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const bundles: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const fullPath = join(rootDir, entry.name);
    if (entry.name.endsWith(".app")) {
      bundles.push(fullPath);
      continue;
    }

    bundles.push(...(await findAppBundles(fullPath)));
  }

  return bundles;
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
