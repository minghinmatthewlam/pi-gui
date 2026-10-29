import type { SessionRecord } from "../../../contracts/desktop-state";
import { useTranslation } from "../../i18n";
import { formatRelativeTime } from "../../lib/string-utils";
import { ThreadActionsMenu } from "./thread-actions";
import type { ThreadAction } from "./thread-actions";
import type { ThreadMenuState } from "./hooks/use-thread-actions";

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
  const { t } = useTranslation();

  return (
    <>
      <div className="chat-header__status">
        {session.status === "running" ? runningLabel : formatRelativeTime(session.updatedAt, t)}
      </div>
      <div
        className="chat-header__menu-wrap"
        ref={threadMenu.openMenu?.surface === "header" ? threadMenu.menuWrapRef : undefined}
      >
        <button
          aria-haspopup="menu"
          aria-expanded={threadMenu.openMenu?.surface === "header"}
          aria-label={t("app.threadActions")}
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
