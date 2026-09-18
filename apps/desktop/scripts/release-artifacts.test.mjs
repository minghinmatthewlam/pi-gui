import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse, stringify } from "yaml";
import { expectedFiles, hashFile, stageArtifacts, verifyArtifacts } from "./release-artifacts.mjs";
import { refreshMacUpdateMetadata } from "./refresh-macos-update-metadata.mjs";

const VERSION = "0.1.0-beta.34";
const COMMIT = "a".repeat(40);

function updateManifestName(platform) {
  if (platform === "macos") {
    return "latest-mac.yml";
  }
  if (platform === "linux") {
    return "latest-linux.yml";
  }
  return "latest.yml";
}

function primaryUpdateAsset(platform) {
  if (platform === "macos") {
    return `pi-gui-${VERSION}-arm64.zip`;
  }
  if (platform === "linux") {
    return `pi-gui-${VERSION}-x86_64.AppImage`;
  }
  return `pi-gui-${VERSION}-x64-setup.exe`;
}

function updateAssets(platform) {
  if (platform === "macos") {
    return [`pi-gui-${VERSION}-arm64.zip`, `pi-gui-${VERSION}-arm64.dmg`];
  }
  if (platform === "linux") {
    return [`pi-gui-${VERSION}-x86_64.AppImage`, `pi-gui_${VERSION}_amd64.deb`];
  }
  return [primaryUpdateAsset(platform)];
}

async function createFixture(root, platform, override = {}) {
  const source = path.join(root, `${platform}-source`);
  await mkdir(source, { recursive: true });
  const manifestName = updateManifestName(platform);

  for (const name of expectedFiles(platform, VERSION)) {
    if (name !== manifestName) {
      await writeFile(path.join(source, name), `${platform}:${name}\n`, "utf8");
    }
  }

  const files = [];
  for (const name of updateAssets(platform)) {
    const digest = await hashFile(path.join(source, name));
    const entry = { url: name, sha512: digest.sha512, size: digest.size };
    const blockmapName = `${name}.blockmap`;
    if (expectedFiles(platform, VERSION).includes(blockmapName)) {
      entry.blockMapSize = (await hashFile(path.join(source, blockmapName))).size;
    } else if (name.endsWith(".AppImage")) {
      entry.blockMapSize = Math.min(8, digest.size);
    }
    files.push(entry);
  }
  const primary = override.primary ?? primaryUpdateAsset(platform);
  const primaryDigest = await hashFile(path.join(source, primary));
  const updateManifest = {
    version: VERSION,
    files,
    path: primary,
    sha512: primaryDigest.sha512,
    releaseDate: "2026-07-27T00:00:00.000Z",
    ...override.manifest,
  };
  await writeFile(path.join(source, manifestName), stringify(updateManifest), "utf8");
  return source;
}

async function stageFixture(root, platform, override) {
  const inputDir = await createFixture(root, platform, override);
  const outputDir = path.join(root, `${platform}-staged`);
  await stageArtifacts({ platform, version: VERSION, commit: COMMIT, inputDir, outputDir });
  return outputDir;
}

test("stages immutable platform manifests and verifies the combined candidate", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-gui-release-artifacts-"));
  const combined = path.join(root, "combined");
  await mkdir(combined);

  for (const platform of ["macos", "linux", "windows"]) {
    const staged = await stageFixture(root, platform);
    await cp(staged, combined, { recursive: true });
  }

  const manifests = await verifyArtifacts({
    platform: "all",
    version: VERSION,
    commit: COMMIT,
    inputDir: combined,
  });
  assert.deepEqual(
    manifests.map(({ platform }) => platform),
    ["macos", "linux", "windows"],
  );
});

test("rejects bytes changed after the platform manifest was written", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-gui-release-tamper-"));
  const staged = await stageFixture(root, "windows");
  await writeFile(
    path.join(staged, `pi-gui-${VERSION}-x64-setup.exe`),
    "changed after staging\n",
    "utf8",
  );

  await assert.rejects(
    verifyArtifacts({
      platform: "windows",
      version: VERSION,
      commit: COMMIT,
      inputDir: staged,
    }),
    /digest mismatch/,
  );
});

test("requires the Debian package when staging Linux artifacts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-gui-release-linux-missing-deb-"));
  const source = await createFixture(root, "linux");
  await unlink(path.join(source, `pi-gui_${VERSION}_amd64.deb`));

  await assert.rejects(
    stageArtifacts({
      platform: "linux",
      version: VERSION,
      commit: COMMIT,
      inputDir: source,
      outputDir: path.join(root, "staged"),
    }),
    /Missing release artifact: .*\.deb/,
  );
});

test("requires latest-linux.yml to checksum the Debian package", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-gui-release-linux-manifest-"));
  const source = await createFixture(root, "linux");
  const manifestPath = path.join(source, "latest-linux.yml");
  const manifest = parse(await readFile(manifestPath, "utf8"));
  manifest.files = manifest.files.filter(({ url }) => !url.endsWith(".deb"));
  await writeFile(manifestPath, stringify(manifest), "utf8");

  await assert.rejects(
    stageArtifacts({
      platform: "linux",
      version: VERSION,
      commit: COMMIT,
      inputDir: source,
      outputDir: path.join(root, "staged"),
    }),
    /does not reference required payload .*\.deb/,
  );
});

test("rejects Debian package bytes changed after Linux staging", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-gui-release-linux-tamper-"));
  const staged = await stageFixture(root, "linux");
  await writeFile(
    path.join(staged, `pi-gui_${VERSION}_amd64.deb`),
    "changed after staging\n",
    "utf8",
  );

  await assert.rejects(
    verifyArtifacts({
      platform: "linux",
      version: VERSION,
      commit: COMMIT,
      inputDir: staged,
    }),
    /digest mismatch for .*\.deb/,
  );
});

test("rejects latest.yml when it selects the portable executable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-gui-release-portable-"));
  const portable = `pi-gui-${VERSION}-x64-portable.exe`;
  const source = await createFixture(root, "windows");
  const manifestPath = path.join(source, "latest.yml");
  const parsed = parse(await readFile(manifestPath, "utf8"));
  const portableDigest = await hashFile(path.join(source, portable));
  parsed.files = [{ url: portable, sha512: portableDigest.sha512, size: portableDigest.size }];
  parsed.path = portable;
  parsed.sha512 = portableDigest.sha512;
  await writeFile(manifestPath, stringify(parsed), "utf8");

  await assert.rejects(
    stageArtifacts({
      platform: "windows",
      version: VERSION,
      commit: COMMIT,
      inputDir: source,
      outputDir: path.join(root, "staged"),
    }),
    /unexpected payload|primary path/,
  );
});

test("rejects undeclared files in the combined release candidate", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-gui-release-extra-"));
  const combined = path.join(root, "combined");
  await mkdir(combined);
  for (const platform of ["macos", "linux", "windows"]) {
    await cp(await stageFixture(root, platform), combined, { recursive: true });
  }
  await writeFile(path.join(combined, "stale-installer.exe"), "stale\n", "utf8");

  await assert.rejects(
    verifyArtifacts({
      platform: "all",
      version: VERSION,
      commit: COMMIT,
      inputDir: combined,
    }),
    /file set mismatch/,
  );
});

test("refreshes macOS metadata and blockmap from final DMG bytes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-gui-release-final-dmg-"));
  const source = await createFixture(root, "macos");
  const manifestPath = path.join(source, "latest-mac.yml");
  const manifest = parse(await readFile(manifestPath, "utf8"));
  const dmgEntry = manifest.files.find(({ url }) => url.endsWith(".dmg"));
  dmgEntry.size = 1;
  dmgEntry.sha512 = "stale-before-stapling";
  dmgEntry.blockMapSize = 1;
  await writeFile(manifestPath, stringify(manifest), "utf8");

  const refreshed = await refreshMacUpdateMetadata({ releaseDir: source, version: VERSION });
  const finalManifest = parse(await readFile(manifestPath, "utf8"));
  const finalDmg = finalManifest.files.find(({ url }) => url === refreshed.dmg);
  assert.equal(finalDmg.size, refreshed.size);
  assert.equal(finalDmg.sha512, refreshed.sha512);
  assert.equal(finalDmg.blockMapSize, refreshed.blockMapSize);

  await stageArtifacts({
    platform: "macos",
    version: VERSION,
    commit: COMMIT,
    inputDir: source,
    outputDir: path.join(root, "staged"),
  });
});
