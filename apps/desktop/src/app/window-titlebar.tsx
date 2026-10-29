import type { ReactNode } from "react";
import type { PiDesktopApi } from "../../contracts/ipc";
import { useTranslation } from "../i18n";
import { CloseIcon } from "../ui/icons";

/**
 * Wraps every screen (threads, settings, startup, crash) when main makes the
 * window frameless (Linux): a draggable title bar with minimize, maximize and
 * close at the top right, and the app below it.
 */
export function WindowFrame({
  api,
  children,
}: {
  readonly api: PiDesktopApi | undefined;
  readonly children: ReactNode;
}) {
  const { t } = useTranslation();
  if (!api?.drawsWindowControls) {
    return children;
  }
  return (
    <div className="window-frame">
      <div className="window-titlebar" data-testid="window-titlebar">
        <div
          className="window-titlebar__controls"
          role="group"
          aria-label={t("windowControls.label")}
        >
          <button
            type="button"
            aria-label={t("windowControls.minimize")}
            className="window-titlebar__control"
            onClick={() => api.minimizeWindow()}
          >
            <svg aria-hidden="true" viewBox="0 0 20 20" width="16" height="16" fill="none">
              <path d="M5 10h10" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" />
            </svg>
          </button>
          <button
            type="button"
            aria-label={t("windowControls.maximize")}
            className="window-titlebar__control"
            onClick={() => {
              void api.toggleWindowMaximize().catch((error: unknown) => {
                console.error("[renderer] toggleWindowMaximize failed", error);
              });
            }}
          >
            <svg aria-hidden="true" viewBox="0 0 20 20" width="16" height="16" fill="none">
              <rect
                x="5"
                y="5"
                width="10"
                height="10"
                rx="1"
                stroke="currentColor"
                strokeWidth="1.4"
              />
            </svg>
          </button>
          <button
            type="button"
            aria-label={t("windowControls.close")}
            className="window-titlebar__control window-titlebar__control--close"
            onClick={() => api.closeWindow()}
          >
            <CloseIcon />
          </button>
        </div>
      </div>
      <div className="window-frame__content">{children}</div>
    </div>
  );
}
