import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const VERSION_PATTERN = /^(\s*version\s+")([^"]+)(")$/m;
const SHA256_PATTERN = /^(\s*sha256\s+")([^"]+)(")$/m;
const URL_PATTERN = /^(\s*url\s+")([^"]+)(")$/m;
const CASK_PATTERN = /^cask "([^"]+)" do$/m;

export function resolveCaskPath(tapDir, caskToken = "pi-gui") {
  return path.join(path.resolve(tapDir), "Casks", `${caskToken}.rb`);
}

export function renderCask({ assetUrl, caskToken = "pi-gui", sha256, version }) {
  return `# typed: false
# frozen_string_literal: true

cask "${caskToken}" do
  version "${version}"
  sha256 "${sha256}"

  url "${assetUrl}"
  name "pi-gui"
  desc "Codex-style desktop shell for pi"
  homepage "https://github.com/minghinmatthewlam/pi-gui"

  depends_on arch: :arm64

  app "pi-gui.app"
end
`;
}

export function updateCaskContent(existingContent, { assetUrl, caskToken = "pi-gui", sha256, version }) {
  const tokenMatch = existingContent.match(CASK_PATTERN);
  if (!tokenMatch) {
    throw new Error("Unable to find cask token declaration in Homebrew cask.");
  }
  if (tokenMatch[1] !== caskToken) {
    throw new Error(`Expected cask token "${caskToken}" but found "${tokenMatch[1]}".`);
  }

  const nextContent = existingContent
    .replace(VERSION_PATTERN, `$1${version}$3`)
    .replace(SHA256_PATTERN, `$1${sha256}$3`)
    .replace(URL_PATTERN, `$1${assetUrl}$3`);

  if (nextContent === existingContent) {
    return {
      changed: false,
      content: existingContent,
    };
  }

  for (const [name, pattern, expected] of [
    ["version", VERSION_PATTERN, version],
    ["sha256", SHA256_PATTERN, sha256],
    ["url", URL_PATTERN, assetUrl],
  ]) {
    const match = nextContent.match(pattern);
    if (!match || match[2] !== expected) {
      throw new Error(`Failed to rewrite ${name} in Homebrew cask.`);
    }
  }

  return {
    changed: true,
    content: nextContent,
  };
}

export async function applyHomebrewTapUpdate({
  assetUrl,
  caskToken = "pi-gui",
  dryRun = false,
  sha256,
  tapDir,
  version,
}) {
  const caskPath = resolveCaskPath(tapDir, caskToken);
  const existingContent = await readFile(caskPath, "utf8");
  const result = updateCaskContent(existingContent, {
    assetUrl,
    caskToken,
    sha256,
    version,
  });

  if (!dryRun && result.changed) {
    await writeFile(caskPath, result.content, "utf8");
  }

  return {
    ...result,
    caskPath,
  };
}

export async function computeFileSha256(filePath) {
  const buffer = await readFile(filePath);
  return createHash("sha256").update(buffer).digest("hex");
}

export async function fetchReleaseAssetUrl({ assetName, repo, tag, token }) {
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, {
    headers: {
      Accept: "application/vnd.github+json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });

  if (!response.ok) {
    throw new Error(`Unable to load release ${tag} from ${repo}: ${response.status} ${response.statusText}`);
  }

  const release = await response.json();
  const asset = release.assets?.find((candidate) => candidate.name === assetName);
  if (!asset?.browser_download_url) {
    throw new Error(`Release ${tag} in ${repo} does not contain asset ${assetName}.`);
  }

  return asset.browser_download_url;
}
