import type { SessionExtensionNoticeRecord } from "../../../contracts/desktop-state";

// Same words terminal pi prints before a warning or error notify; info has none.
const LEVEL_PREFIX: Record<SessionExtensionNoticeRecord["level"], string | undefined> = {
  info: undefined,
  warning: "Warning:",
  error: "Error:",
};

/** Draws `ctx.ui.notify` toasts above the composer. Main adds and expires them. */
export function ExtensionNotices({
  notices,
}: {
  readonly notices?: readonly SessionExtensionNoticeRecord[];
}) {
  // The live region stays mounted so screen readers announce notices as they arrive.
  return (
    <div className="extension-notices" data-testid="extension-notices" role="status">
      {notices?.map((notice) => {
        const prefix = LEVEL_PREFIX[notice.level];
        return (
          <div
            className="extension-notice"
            data-level={notice.level}
            data-testid="extension-notice"
            key={notice.id}
          >
            {prefix ? <span className="extension-notice__level">{prefix}</span> : null}
            <span className="extension-notice__message">{notice.message}</span>
          </div>
        );
      })}
    </div>
  );
}
