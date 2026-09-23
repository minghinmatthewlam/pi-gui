import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

async function main() {
  const [readme, siteMetadata, websitePage] = await Promise.all([
    readFile(path.join(repoRoot, "README.md"), "utf8"),
    readFile(path.join(repoRoot, "apps", "website", "app", "site.ts"), "utf8"),
    readFile(path.join(repoRoot, "apps", "website", "app", "page.tsx"), "utf8"),
  ]);

  assert.match(
    readme,
    /Download the latest `\.dmg` \(macOS\), `\.AppImage` or `\.deb` \(Linux\), or `\.exe` \(Windows\) from the\s+\[Releases page\]/,
  );
  assert.match(readme, /brew install --cask pi-gui/);
  assert.match(readme, /brew upgrade --cask pi-gui/);
  assert.doesNotMatch(readme, /Homebrew installation will be published/);

  assert.match(
    siteMetadata,
    /Install it from GitHub Releases on macOS, Linux and Windows, or Homebrew on macOS/,
  );
  assert.match(siteMetadata, /brew install --cask minghinmatthewlam\/tap\/pi-gui/);
  assert.doesNotMatch(siteMetadata, /source-install today/);

  assert.match(websitePage, /BREW_INSTALL/);
  assert.match(websitePage, /brew upgrade --cask pi-gui/);
  assert.match(websitePage, /Building from source is for contributors/);
  assert.doesNotMatch(websitePage, /Run the beta from source/);

  process.stdout.write("Install copy is aligned across README and website.\n");
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
