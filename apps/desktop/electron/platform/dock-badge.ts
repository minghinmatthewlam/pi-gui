import type { Dock } from "electron";
import type { DesktopAppState } from "../../contracts/desktop-state";

export function createDockBadgeUpdater(dock: Pick<Dock, "setBadge"> | undefined) {
  let previousBadge: string | undefined;

  return (state: Pick<DesktopAppState, "workspaces">): void => {
    if (!dock) {
      return;
    }

    // Count the sidebar's unread dots; the store already owns read state.
    const count = state.workspaces.reduce(
      (total, workspace) =>
        total +
        workspace.sessions.filter(
          (session) => session.status === "idle" && session.hasUnseenUpdate && !session.archivedAt,
        ).length,
      0,
    );
    const badge = count > 0 ? String(count) : "";
    if (badge !== previousBadge) {
      dock.setBadge(badge);
      previousBadge = badge;
    }
  };
}
