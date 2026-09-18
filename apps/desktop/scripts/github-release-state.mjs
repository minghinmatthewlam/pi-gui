import path from "node:path";
import { fileURLToPath } from "node:url";

const GITHUB_API = "https://api.github.com";

async function responseMessage(response) {
  try {
    const body = await response.json();
    return typeof body?.message === "string" ? `: ${body.message}` : "";
  } catch {
    return "";
  }
}

async function requestGithub(fetchImpl, url, token) {
  try {
    return await fetchImpl(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  } catch (error) {
    throw new Error(
      `GitHub release lookup failed before an authoritative response: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    throw new Error("GitHub release lookup returned unreadable JSON");
  }
}

function validateDraft(release, tag) {
  if (release?.tag_name !== tag) {
    throw new Error("GitHub release lookup returned the wrong tag");
  }
  if (release.draft !== true) {
    if (release.draft === false) {
      throw new Error(`Release ${tag} is already published; refusing to replace its assets`);
    }
    throw new Error("GitHub release lookup did not return a boolean draft state");
  }
  if (!Number.isSafeInteger(release.id) || release.id <= 0) {
    throw new Error("GitHub release lookup did not return a valid release id");
  }
  return { state: "draft", id: release.id };
}

export async function checkGithubReleaseState({
  repository,
  tag,
  token,
  requireDraft = false,
  fetchImpl = fetch,
}) {
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new Error(`Invalid GitHub repository: ${repository}`);
  }
  if (!tag) {
    throw new Error("GitHub release tag is required");
  }
  if (!token) {
    throw new Error("GH_TOKEN is required for an authoritative release lookup");
  }

  const releaseUrl = `${GITHUB_API}/repos/${repository}/releases`;
  const publishedResponse = await requestGithub(
    fetchImpl,
    `${releaseUrl}/tags/${encodeURIComponent(tag)}`,
    token,
  );
  if (publishedResponse.status !== 404) {
    if (!publishedResponse.ok) {
      throw new Error(
        `GitHub published-release lookup returned HTTP ${publishedResponse.status}${await responseMessage(publishedResponse)}`,
      );
    }
    const published = await readJson(publishedResponse);
    if (published?.tag_name !== tag || published?.draft !== false) {
      throw new Error("GitHub published-release lookup returned malformed state");
    }
    throw new Error(`Release ${tag} is already published; refusing to replace its assets`);
  }

  for (let page = 1; page <= 100; page += 1) {
    const response = await requestGithub(
      fetchImpl,
      `${releaseUrl}?per_page=100&page=${page}`,
      token,
    );
    if (!response.ok) {
      throw new Error(
        `GitHub draft-release lookup returned HTTP ${response.status}${await responseMessage(response)}`,
      );
    }
    const releases = await readJson(response);
    if (!Array.isArray(releases)) {
      throw new Error("GitHub draft-release lookup did not return a release list");
    }
    const matches = releases.filter((release) => release?.tag_name === tag);
    if (matches.length > 1) {
      throw new Error(`GitHub returned multiple releases for tag ${tag}`);
    }
    if (matches.length === 1) {
      const draft = validateDraft(matches[0], tag);
      if (!requireDraft) {
        throw new Error(`Draft release ${tag} already exists; refusing to replace its assets`);
      }
      return draft;
    }
    if (releases.length < 100) {
      if (requireDraft) {
        throw new Error(`Required draft release ${tag} does not exist`);
      }
      return { state: "absent" };
    }
  }

  throw new Error(`GitHub release lookup exceeded 100 pages without proving the state of ${tag}`);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const unknown = [...args].filter((arg) => arg !== "--require-draft");
  if (unknown.length > 0) {
    throw new Error(`Unknown argument: ${unknown[0]}`);
  }
  const result = await checkGithubReleaseState({
    repository: process.env.GITHUB_REPOSITORY ?? "",
    tag: process.env.GITHUB_REF_NAME ?? "",
    token: process.env.GH_TOKEN ?? "",
    requireDraft: args.has("--require-draft"),
  });
  console.log(
    result.state === "draft"
      ? `Release ${process.env.GITHUB_REF_NAME} exists as draft ${String(result.id)}`
      : `Release ${process.env.GITHUB_REF_NAME} does not exist`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
