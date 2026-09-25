import { app, net, Notification, shell } from "electron";

// /releases/latest skips drafts and prereleases, so stable installs are only
// told about stable releases.
const RELEASES_URL = "https://api.github.com/repos/minghinmatthewlam/pi-gui/releases/latest";
const RELEASES_PAGE = "https://github.com/minghinmatthewlam/pi-gui/releases";

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const INITIAL_DELAY_MS = 15_000; // 15 seconds after launch
const FETCH_TIMEOUT_MS = 10_000; // give up on a hung request

export type UpdateCheckResult =
  | { status: "up-to-date"; currentVersion: string; latestVersion: string }
  | {
      status: "update-available";
      currentVersion: string;
      latestVersion: string;
      releaseUrl: string;
    }
  | { status: "error"; message: string };

export type GitHubRelease = {
  tag_name?: string;
  html_url?: string;
};

export function openReleasesPage(releaseUrl = RELEASES_PAGE): Promise<void> {
  return shell.openExternal(releaseUrl);
}

export function showUpdateNotification(
  currentVersion: string,
  latestVersion: string,
  releaseUrl: string,
): void {
  if (!Notification.isSupported()) {
    return;
  }
  const notification = new Notification({
    title: "pi-gui Release Available",
    body: `Version ${latestVersion} is available (you have ${currentVersion}). Click to view the release.`,
  });
  notification.on("click", () => {
    void openReleasesPage(releaseUrl).catch((error: unknown) => {
      console.error("[update-checker] openReleasesPage failed", error);
    });
  });
  notification.show();
}

/**
 * Pure update check — performs the network request and version comparison but
 * never shows UI. Callers decide how to surface the result (auto path shows a
 * deduped notification, the manual menu path shows a dialog).
 */
export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await net.fetch(RELEASES_URL, {
      headers: { Accept: "application/vnd.github.v3+json" },
      signal: controller.signal,
    });
  } catch (error) {
    const message =
      error instanceof Error && error.name === "AbortError"
        ? "The update check timed out."
        : error instanceof Error
          ? error.message
          : "The update check could not reach GitHub.";
    return { status: "error", message };
  } finally {
    clearTimeout(timeout);
  }

  if (res.status === 404) {
    return { status: "error", message: "No stable pi-gui release has been published yet." };
  }
  if (!res.ok) {
    return {
      status: "error",
      message: `GitHub Releases returned ${res.status}.`,
    };
  }

  let release: GitHubRelease;
  try {
    release = (await res.json()) as GitHubRelease;
  } catch {
    return { status: "error", message: "GitHub Releases returned an unreadable response." };
  }

  if (!release?.tag_name) {
    return {
      status: "error",
      message: "GitHub Releases did not return any published versions.",
    };
  }

  const latest = release.tag_name.replace(/^v/, "");
  const current = app.getVersion();

  // Only an actually newer published version counts as an update — a proper
  // semver compare avoids misfiring on prereleases or newer-local dev builds.
  if (compareSemver(latest, current) > 0) {
    return {
      status: "update-available",
      currentVersion: current,
      latestVersion: latest,
      releaseUrl: releaseUrlFor(release),
    };
  }

  return {
    status: "up-to-date",
    currentVersion: current,
    latestVersion: latest,
  };
}

export function initUpdateChecker(): () => void {
  // Dedupe notifications per version so a still-unactioned update doesn't
  // re-notify on every 4-hour poll.
  let lastNotifiedVersion: string | undefined;
  const runAutoCheck = async () => {
    const result = await checkForUpdate();
    if (result.status === "error") {
      console.warn("Update check failed:", result.message);
      return;
    }
    if (result.status === "update-available" && result.latestVersion !== lastNotifiedVersion) {
      lastNotifiedVersion = result.latestVersion;
      showUpdateNotification(result.currentVersion, result.latestVersion, result.releaseUrl);
    }
  };

  const timeout = setTimeout(
    () =>
      void runAutoCheck().catch((error: unknown) => {
        console.error("[update-checker] runAutoCheck failed", error);
      }),
    INITIAL_DELAY_MS,
  );
  const interval = setInterval(
    () =>
      void runAutoCheck().catch((error: unknown) => {
        console.error("[update-checker] runAutoCheck failed", error);
      }),
    CHECK_INTERVAL_MS,
  );

  return () => {
    clearTimeout(timeout);
    clearInterval(interval);
  };
}

export function releaseUrlFor(release: GitHubRelease): string {
  const tag = release.tag_name;
  if (!tag) {
    return RELEASES_PAGE;
  }

  const canonicalUrl = `${RELEASES_PAGE}/tag/${encodeURIComponent(tag)}`;
  if (!release.html_url) {
    return canonicalUrl;
  }

  try {
    const candidate = new URL(release.html_url);
    const canonical = new URL(canonicalUrl);
    if (
      candidate.protocol === canonical.protocol &&
      candidate.host === canonical.host &&
      candidate.pathname === canonical.pathname &&
      candidate.username === "" &&
      candidate.password === "" &&
      candidate.search === "" &&
      candidate.hash === ""
    ) {
      return candidate.toString();
    }
  } catch {
    // Fall through to the repository's canonical URL for this exact tag.
  }
  return canonicalUrl;
}

/**
 * Compare two semver strings. Returns a negative number when `a < b`, zero when
 * equal, positive when `a > b`. Handles prerelease precedence per semver
 * (a release outranks its own prereleases); unparseable inputs compare equal so
 * we never claim an update we can't verify.
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) {
    return 0;
  }
  if (pa.nums[0] !== pb.nums[0]) {
    return pa.nums[0] < pb.nums[0] ? -1 : 1;
  }
  if (pa.nums[1] !== pb.nums[1]) {
    return pa.nums[1] < pb.nums[1] ? -1 : 1;
  }
  if (pa.nums[2] !== pb.nums[2]) {
    return pa.nums[2] < pb.nums[2] ? -1 : 1;
  }
  return comparePrerelease(pa.pre, pb.pre);
}

function parseSemver(
  version: string,
): { nums: [number, number, number]; pre: string[] } | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(version.trim());
  if (!match) {
    return undefined;
  }
  return {
    nums: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split(".") : [],
  };
}

function comparePrerelease(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) {
    return 0;
  }
  // A version without a prerelease tag has higher precedence than one with it.
  if (a.length === 0) {
    return 1;
  }
  if (b.length === 0) {
    return -1;
  }
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a[index] ?? "";
    const right = b[index] ?? "";
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) {
      const delta = Number(left) - Number(right);
      if (delta !== 0) {
        return delta < 0 ? -1 : 1;
      }
    } else if (leftNumeric) {
      return -1; // numeric identifiers rank lower than alphanumeric
    } else if (rightNumeric) {
      return 1;
    } else if (left !== right) {
      return left < right ? -1 : 1;
    }
  }
  if (a.length === b.length) {
    return 0;
  }
  return a.length < b.length ? -1 : 1;
}
