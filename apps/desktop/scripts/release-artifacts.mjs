import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

const PRODUCT_NAME = "pi-gui";
const SCHEMA_VERSION = 1;
const PLATFORMS = ["macos", "linux", "windows"];

function platformSpec(platform, version) {
  const base = `${PRODUCT_NAME}-${version}`;
  switch (platform) {
    case "macos":
      return {
        manifestName: "release-manifest-macos.json",
        updateManifest: "latest-mac.yml",
        primaryUpdateAsset: `${base}-universal.zip`,
        updateAssets: [`${base}-universal.zip`, `${base}-universal.dmg`],
        files: [
          { name: `${base}-universal.dmg`, role: "dmg" },
          { name: `${base}-universal.dmg.blockmap`, role: "dmg-blockmap" },
          { name: `${base}-universal.zip`, role: "update-archive" },
          { name: `${base}-universal.zip.blockmap`, role: "update-blockmap" },
          { name: "latest-mac.yml", role: "update-manifest" },
        ],
      };
    case "linux":
      return {
        manifestName: "release-manifest-linux.json",
        updateManifest: "latest-linux.yml",
        primaryUpdateAsset: `${base}-x86_64.AppImage`,
        updateAssets: [
          `${base}-x86_64.AppImage`,
          `${PRODUCT_NAME}_${version}_amd64.deb`,
        ],
        files: [
          { name: `${base}-x86_64.AppImage`, role: "appimage" },
          { name: `${PRODUCT_NAME}_${version}_amd64.deb`, role: "debian-package" },
          { name: "latest-linux.yml", role: "update-manifest" },
        ],
      };
    case "windows":
      return {
        manifestName: "release-manifest-windows.json",
        updateManifest: "latest.yml",
        primaryUpdateAsset: `${base}-x64-setup.exe`,
        updateAssets: [`${base}-x64-setup.exe`],
        files: [
          { name: `${base}-x64-setup.exe`, role: "installer" },
          { name: `${base}-x64-setup.exe.blockmap`, role: "installer-blockmap" },
          { name: `${base}-x64-portable.exe`, role: "portable" },
          { name: "latest.yml", role: "update-manifest" },
        ],
      };
    default:
      throw new Error(`Unsupported release platform: ${platform}`);
  }
}

export function expectedFiles(platform, version) {
  return platformSpec(platform, version).files.map(({ name }) => name);
}

export async function hashFile(filePath) {
  const sha256 = createHash("sha256");
  const sha512 = createHash("sha512");
  let size = 0;

  for await (const chunk of createReadStream(filePath)) {
    size += chunk.length;
    sha256.update(chunk);
    sha512.update(chunk);
  }

  return {
    size,
    sha256: sha256.digest("hex"),
    sha512: sha512.digest("base64"),
  };
}

async function assertRegularFile(filePath) {
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch {
    throw new Error(`Missing release artifact: ${filePath}`);
  }
  if (!fileStat.isFile()) {
    throw new Error(`Release artifact is not a regular file: ${filePath}`);
  }
}

function parseUpdateManifest(contents, manifestPath) {
  const document = parseDocument(contents, { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error(
      `Invalid update manifest ${manifestPath}: ${document.errors.map((error) => error.message).join("; ")}`,
    );
  }
  const value = document.toJS();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Update manifest must contain a mapping: ${manifestPath}`);
  }
  return value;
}

function assertFileName(value, field, manifestPath) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    path.basename(value) !== value ||
    value.includes("\\")
  ) {
    throw new Error(`${field} must be a plain artifact filename in ${manifestPath}`);
  }
}

async function verifyUpdateManifest(inputDir, platform, version) {
  const spec = platformSpec(platform, version);
  const manifestPath = path.join(inputDir, spec.updateManifest);
  const manifest = parseUpdateManifest(await readFile(manifestPath, "utf8"), manifestPath);

  if (manifest.version !== version) {
    throw new Error(
      `${spec.updateManifest} version mismatch: expected ${version}, got ${String(manifest.version)}`,
    );
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error(`${spec.updateManifest} must list update payloads`);
  }

  const expectedUpdateAssets = new Set(spec.updateAssets);
  const seenUpdateAssets = new Set();
  for (const entry of manifest.files) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${spec.updateManifest} contains an invalid files entry`);
    }
    assertFileName(entry.url, "files[].url", manifestPath);
    if (!expectedUpdateAssets.has(entry.url)) {
      throw new Error(`${spec.updateManifest} references unexpected payload ${entry.url}`);
    }
    if (seenUpdateAssets.has(entry.url)) {
      throw new Error(`${spec.updateManifest} references ${entry.url} more than once`);
    }
    seenUpdateAssets.add(entry.url);

    const digest = await hashFile(path.join(inputDir, entry.url));
    if (entry.size !== digest.size) {
      throw new Error(
        `${spec.updateManifest} size mismatch for ${entry.url}: expected ${digest.size}, got ${String(entry.size)}`,
      );
    }
    if (entry.sha512 !== digest.sha512) {
      throw new Error(`${spec.updateManifest} SHA-512 mismatch for ${entry.url}`);
    }

    if (entry.blockMapSize !== undefined) {
      const blockmapName = `${entry.url}.blockmap`;
      if (spec.files.some(({ name }) => name === blockmapName)) {
        const blockmap = await hashFile(path.join(inputDir, blockmapName));
        if (entry.blockMapSize !== blockmap.size) {
          throw new Error(
            `${spec.updateManifest} blockmap size mismatch for ${entry.url}: expected ${blockmap.size}, got ${String(entry.blockMapSize)}`,
          );
        }
      } else if (
        platform !== "linux" ||
        entry.url !== spec.primaryUpdateAsset ||
        !Number.isSafeInteger(entry.blockMapSize) ||
        entry.blockMapSize <= 0 ||
        entry.blockMapSize > digest.size
      ) {
        throw new Error(`${spec.updateManifest} has an invalid embedded blockmap size for ${entry.url}`);
      }
    }
  }

  for (const expected of expectedUpdateAssets) {
    if (!seenUpdateAssets.has(expected)) {
      throw new Error(`${spec.updateManifest} does not reference required payload ${expected}`);
    }
  }

  if (manifest.path !== spec.primaryUpdateAsset) {
    throw new Error(
      `${spec.updateManifest} primary path must be ${spec.primaryUpdateAsset}, got ${String(manifest.path)}`,
    );
  }
  const primaryDigest = await hashFile(path.join(inputDir, spec.primaryUpdateAsset));
  if (manifest.sha512 !== primaryDigest.sha512) {
    throw new Error(`${spec.updateManifest} primary SHA-512 does not match ${spec.primaryUpdateAsset}`);
  }
}

function validateVersion(version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid release version: ${version}`);
  }
}

function validateCommit(commit) {
  if (!/^[0-9a-f]{40}$/i.test(commit)) {
    throw new Error(`Release commit must be a 40-character Git SHA: ${commit}`);
  }
}

async function buildPlatformManifest(inputDir, platform, version, commit) {
  const spec = platformSpec(platform, version);
  const files = [];
  for (const entry of spec.files) {
    const digest = await hashFile(path.join(inputDir, entry.name));
    files.push({ name: entry.name, role: entry.role, ...digest });
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    platform,
    version,
    commit: commit.toLowerCase(),
    updateManifest: spec.updateManifest,
    files,
  };
}

export async function stageArtifacts({ platform, version, commit, inputDir, outputDir }) {
  validateVersion(version);
  validateCommit(commit);
  const spec = platformSpec(platform, version);

  await mkdir(outputDir, { recursive: true });
  const existing = await readdir(outputDir);
  if (existing.length > 0) {
    throw new Error(`Release staging directory must be empty: ${outputDir}`);
  }

  for (const entry of spec.files) {
    const source = path.join(inputDir, entry.name);
    const destination = path.join(outputDir, entry.name);
    await assertRegularFile(source);
    await copyFile(source, destination);
  }

  await verifyUpdateManifest(outputDir, platform, version);
  const manifest = await buildPlatformManifest(outputDir, platform, version, commit);
  await writeFile(
    path.join(outputDir, spec.manifestName),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  await verifyArtifacts({ platform, version, commit, inputDir: outputDir });
  return manifest;
}

async function readPlatformManifest(inputDir, platform, version) {
  const manifestName = platformSpec(platform, version).manifestName;
  const manifestPath = path.join(inputDir, manifestName);
  await assertRegularFile(manifestPath);

  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Invalid release manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { manifest, manifestName };
}

async function verifyPlatformArtifacts({ platform, version, commit, inputDir }) {
  const spec = platformSpec(platform, version);
  const { manifest, manifestName } = await readPlatformManifest(inputDir, platform, version);

  if (
    manifest.schemaVersion !== SCHEMA_VERSION ||
    manifest.platform !== platform ||
    manifest.version !== version ||
    manifest.commit !== commit.toLowerCase() ||
    manifest.updateManifest !== spec.updateManifest
  ) {
    throw new Error(`${manifestName} release identity does not match the requested candidate`);
  }
  if (!Array.isArray(manifest.files) || manifest.files.length !== spec.files.length) {
    throw new Error(`${manifestName} does not contain the expected file set`);
  }

  for (let index = 0; index < spec.files.length; index += 1) {
    const expected = spec.files[index];
    const recorded = manifest.files[index];
    if (recorded?.name !== expected.name || recorded?.role !== expected.role) {
      throw new Error(`${manifestName} entry ${index} does not match ${expected.name}`);
    }
    await assertRegularFile(path.join(inputDir, expected.name));
    const actual = await hashFile(path.join(inputDir, expected.name));
    if (
      recorded.size !== actual.size ||
      recorded.sha256 !== actual.sha256 ||
      recorded.sha512 !== actual.sha512
    ) {
      throw new Error(`${manifestName} digest mismatch for ${expected.name}`);
    }
  }

  await verifyUpdateManifest(inputDir, platform, version);
  return manifest;
}

export async function verifyArtifacts({ platform, version, commit, inputDir }) {
  validateVersion(version);
  validateCommit(commit);
  const platforms = platform === "all" ? PLATFORMS : [platform];
  const manifests = [];

  for (const item of platforms) {
    manifests.push(
      await verifyPlatformArtifacts({ platform: item, version, commit, inputDir }),
    );
  }

  if (platform === "all") {
    const expected = new Set();
    for (const item of PLATFORMS) {
      const spec = platformSpec(item, version);
      expected.add(spec.manifestName);
      for (const file of spec.files) {
        if (expected.has(file.name)) {
          throw new Error(`Release platforms produce a colliding filename: ${file.name}`);
        }
        expected.add(file.name);
      }
    }

    const actual = new Set();
    for (const entry of await readdir(inputDir, { withFileTypes: true })) {
      if (entry.isFile()) {
        actual.add(entry.name);
      }
    }
    const missing = [...expected].filter((name) => !actual.has(name));
    const extra = [...actual].filter((name) => !expected.has(name));
    if (missing.length > 0 || extra.length > 0) {
      throw new Error(
        `Combined release candidate file set mismatch (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"})`,
      );
    }
  }

  return manifests;
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument list near ${key ?? "<end>"}`);
    }
    options[key.slice(2)] = value;
  }
  return { command, options };
}

async function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  const required = ["platform", "version", "commit", "input"];
  if (command === "stage") {
    required.push("output");
  }
  for (const name of required) {
    if (!options[name]) {
      throw new Error(`Missing required --${name}`);
    }
  }

  if (command === "stage") {
    const manifest = await stageArtifacts({
      platform: options.platform,
      version: options.version,
      commit: options.commit,
      inputDir: path.resolve(options.input),
      outputDir: path.resolve(options.output),
    });
    console.log(
      `Staged ${manifest.platform} ${manifest.version} artifacts at ${path.resolve(options.output)}`,
    );
    return;
  }
  if (command === "verify") {
    const manifests = await verifyArtifacts({
      platform: options.platform,
      version: options.version,
      commit: options.commit,
      inputDir: path.resolve(options.input),
    });
    console.log(
      `Verified ${manifests.map(({ platform }) => platform).join(", ")} release artifacts at ${path.resolve(options.input)}`,
    );
    return;
  }
  throw new Error("Usage: release-artifacts.mjs <stage|verify> --platform <name|all> --version <version> --commit <sha> --input <dir> [--output <dir>]");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
