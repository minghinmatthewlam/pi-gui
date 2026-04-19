import { app, net, Notification, shell } from "electron";

const RELEASES_URL =
  "https://api.github.com/repos/minghinmatthewlam/pi-gui/releases?per_page=1";
const RELEASES_PAGE =
  "https://github.com/minghinmatthewlam/pi-gui/releases/latest";

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const INITIAL_DELAY_MS = 15_000; // 15 seconds after launch

export type UpdateCheckResult =
  | { status: "up-to-date"; currentVersion: string; latestVersion: string }
  | { status: "update-available"; currentVersion: string; latestVersion: string }
  | { status: "error"; message: string };

function showUpdateNotification(currentVersion: string, latestVersion: string): void {
  const notification = new Notification({
    title: "pi-gui Release Available",
    body: `Version ${latestVersion} is available (you have ${currentVersion}). Click to view the release.`,
  });
  notification.on("click", () => {
    shell.openExternal(RELEASES_PAGE);
  });
  notification.show();
}

export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const res = await net.fetch(RELEASES_URL, {
    headers: { Accept: "application/vnd.github.v3+json" },
  });
  if (!res.ok) {
    return {
      status: "error",
      message: `GitHub Releases returned ${res.status}.`,
    };
  }

  const releases = (await res.json()) as Array<{ tag_name: string }>;
  const release = releases[0];
  if (!release?.tag_name) {
    return {
      status: "error",
      message: "GitHub Releases did not return any published versions.",
    };
  }

  const latest = release.tag_name.replace(/^v/, "");
  const current = app.getVersion();

  if (latest !== current) {
    showUpdateNotification(current, latest);
    return {
      status: "update-available",
      currentVersion: current,
      latestVersion: latest,
    };
  }

  return {
    status: "up-to-date",
    currentVersion: current,
    latestVersion: latest,
  };
}

export function initUpdateChecker(): () => void {
  const noop = (e: Error) =>
    console.warn("Update check failed:", e.message);

  const timeout = setTimeout(() => {
    void checkForUpdate().catch(noop);
  }, INITIAL_DELAY_MS);
  const interval = setInterval(() => {
    void checkForUpdate().catch(noop);
  }, CHECK_INTERVAL_MS);

  return () => {
    clearTimeout(timeout);
    clearInterval(interval);
  };
}
