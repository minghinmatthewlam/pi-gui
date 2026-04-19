import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyHomebrewTapUpdate, renderCask, resolveCaskPath } from "./homebrew-tap-utils.mjs";

async function main() {
  const tapDir = await mkdtemp(path.join(os.tmpdir(), "pi-gui-homebrew-tap-"));
  await mkdir(path.join(tapDir, "Casks"), { recursive: true });

  const caskPath = resolveCaskPath(tapDir);
  await writeFile(
    caskPath,
    renderCask({
      assetUrl: "https://example.com/pi-gui-0.1.0-beta.1-arm64.dmg",
      sha256: "a".repeat(64),
      version: "0.1.0-beta.1",
    }),
    "utf8",
  );

  const dryRunResult = await applyHomebrewTapUpdate({
    assetUrl: "https://example.com/pi-gui-0.1.0-beta.2-arm64.dmg",
    dryRun: true,
    sha256: "b".repeat(64),
    tapDir,
    version: "0.1.0-beta.2",
  });
  assert.equal(dryRunResult.changed, true);
  const unchangedContent = await readFile(caskPath, "utf8");
  assert.match(unchangedContent, /0\.1\.0-beta\.1/);

  const writeResult = await applyHomebrewTapUpdate({
    assetUrl: "https://example.com/pi-gui-0.1.0-beta.2-arm64.dmg",
    sha256: "b".repeat(64),
    tapDir,
    version: "0.1.0-beta.2",
  });
  assert.equal(writeResult.changed, true);

  const updatedContent = await readFile(caskPath, "utf8");
  assert.match(updatedContent, /version "0\.1\.0-beta\.2"/);
  assert.match(updatedContent, /sha256 "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"/);
  assert.match(updatedContent, /url "https:\/\/example\.com\/pi-gui-0\.1\.0-beta\.2-arm64\.dmg"/);

  process.stdout.write("Homebrew tap rewrite fixture passed.\n");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
