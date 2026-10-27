import type { SessionRecord } from "../../../contracts/desktop-state";
import { ThreadActionsMenu } from "./thread-actions";
import type { ThreadAction } from "./thread-actions";
import type { ThreadMenuState } from "./hooks/use-thread-actions";
import { formatRelativeTime } from "../../lib/string-utils";

interface ChatHeaderActionsProps {
  readonly session: SessionRecord;
  readonly runningLabel: string;
  readonly threadMenu: ThreadMenuState;
  readonly actions: readonly ThreadAction[] | undefined;
}

/**
 * The status text and actions button the topbar shows for an open thread. The
 * menu list itself comes from the shared thread actions, so every surface
 * offers the same set.
 */
export function ChatHeaderActions({
  session,
  runningLabel,
  threadMenu,
  actions,
}: ChatHeaderActionsProps) {
  return (
    <>
      <div className="chat-header__status">
        {session.status === "running" ? runningLabel : formatRelativeTime(session.updatedAt)}
      </div>
      <div
        className="chat-header__menu-wrap"
        ref={threadMenu.openMenu?.surface === "header" ? threadMenu.menuWrapRef : undefined}
      >
        <button
          aria-haspopup="menu"
          aria-expanded={threadMenu.openMenu?.surface === "header"}
          aria-label="Thread actions"
          className="icon-button"
          data-testid="thread-header-menu"
          type="button"
          onClick={threadMenu.toggleHeaderMenu}
        >
          …
        </button>
        {threadMenu.openMenu?.surface === "header" && actions ? (
          <ThreadActionsMenu actions={actions} className="chat-header__menu" />
        ) : null}
      </div>
    </>
  );
}
