import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument, stringify } from "yaml";
import { hashFile } from "./release-artifacts.mjs";

const require = createRequire(import.meta.url);
const { appBuilderPath } = require("app-builder-bin");

function parseManifest(contents, manifestPath) {
  const document = parseDocument(contents, { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error(
      `Invalid update manifest ${manifestPath}: ${document.errors.map((error) => error.message).join("; ")}`,
    );
  }
  return document.toJS();
}

function rebuildBlockmap(dmgPath, blockmapPath) {
  const temporaryPath = `${blockmapPath}.final-${process.pid}`;
  const result = spawnSync(
    appBuilderPath,
    ["blockmap", "--input", dmgPath, "--output", temporaryPath],
    { encoding: "utf8" },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `Failed to regenerate ${path.basename(blockmapPath)}: ${result.stderr.trim() || `exit ${String(result.status)}`}`,
    );
  }

  let metadata;
  try {
    metadata = JSON.parse(result.stdout);
  } catch {
    throw new Error(`app-builder returned invalid blockmap metadata for ${dmgPath}`);
  }
  return { metadata, temporaryPath };
}

export async function refreshMacUpdateMetadata({ releaseDir, version }) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid release version: ${version}`);
  }
  const base = `pi-gui-${version}-universal`;
  const dmgName = `${base}.dmg`;
  const zipName = `${base}.zip`;
  const dmgPath = path.join(releaseDir, dmgName);
  const blockmapPath = `${dmgPath}.blockmap`;
  const manifestPath = path.join(releaseDir, "latest-mac.yml");

  const { metadata, temporaryPath } = rebuildBlockmap(dmgPath, blockmapPath);
  const [dmgDigest, zipDigest, blockmapStat] = await Promise.all([
    hashFile(dmgPath),
    hashFile(path.join(releaseDir, zipName)),
    stat(temporaryPath),
  ]);
  if (metadata.size !== dmgDigest.size || metadata.sha512 !== dmgDigest.sha512) {
    throw new Error("Regenerated DMG blockmap metadata does not match the final DMG bytes");
  }

  const manifest = parseManifest(await readFile(manifestPath, "utf8"), manifestPath);
  if (manifest?.version !== version || !Array.isArray(manifest.files)) {
    throw new Error(`latest-mac.yml does not describe macOS ${version}`);
  }
  const dmgEntries = manifest.files.filter((entry) => entry?.url === dmgName);
  const zipEntries = manifest.files.filter((entry) => entry?.url === zipName);
  if (dmgEntries.length !== 1 || zipEntries.length !== 1) {
    throw new Error("latest-mac.yml must contain exactly one DMG and one ZIP entry");
  }
  if (
    zipEntries[0].size !== zipDigest.size ||
    zipEntries[0].sha512 !== zipDigest.sha512 ||
    manifest.path !== zipName ||
    manifest.sha512 !== zipDigest.sha512
  ) {
    throw new Error("latest-mac.yml ZIP metadata changed before final DMG refresh");
  }

  dmgEntries[0].size = dmgDigest.size;
  dmgEntries[0].sha512 = dmgDigest.sha512;
  if (dmgEntries[0].blockMapSize !== undefined) {
    dmgEntries[0].blockMapSize = blockmapStat.size;
  }

  const temporaryManifest = `${manifestPath}.final-${process.pid}`;
  await writeFile(temporaryManifest, stringify(manifest), "utf8");
  await rename(temporaryPath, blockmapPath);
  await rename(temporaryManifest, manifestPath);

  return {
    dmg: dmgName,
    size: dmgDigest.size,
    sha512: dmgDigest.sha512,
    blockMapSize: blockmapStat.size,
  };
}

async function main() {
  const [releaseDir, version] = process.argv.slice(2);
  if (!releaseDir || !version) {
    throw new Error("Usage: refresh-macos-update-metadata.mjs <release-dir> <version>");
  }
  const result = await refreshMacUpdateMetadata({
    releaseDir: path.resolve(releaseDir),
    version,
  });
  console.log(
    `Refreshed ${result.dmg} metadata from final bytes (${result.size} bytes, blockmap ${result.blockMapSize} bytes)`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
