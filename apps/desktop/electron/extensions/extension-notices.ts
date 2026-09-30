import type { HostUiRequest } from "@pi-gui/session-driver";
import type { SessionExtensionNoticeRecord } from "../../contracts/desktop-state";

/** Most toasts shown at once; the oldest drops when an extension notifies past this. */
export const EXTENSION_NOTICE_LIMIT = 5;
/** How long a toast stays up. Main removes it; the renderer has no timer of its own. */
export const EXTENSION_NOTICE_TIMEOUT_MS = 6_000;

type NotifyRequest = Extract<HostUiRequest, { readonly kind: "notify" }>;

export function extensionNoticeFromRequest(
  request: NotifyRequest,
  createdAt: string,
): SessionExtensionNoticeRecord {
  return {
    id: request.requestId,
    level: request.level ?? "info",
    message: request.message,
    createdAt,
  };
}

/** Keeps notice timers apart from dialog timers that share the same map. */
export function extensionNoticeTimerId(noticeId: string): string {
  return `notice:${noticeId}`;
}

/** Appends a notice, keeping the newest `EXTENSION_NOTICE_LIMIT`. Returns the notices that fell off. */
export function appendExtensionNotice(
  state: { notices: SessionExtensionNoticeRecord[] },
  notice: SessionExtensionNoticeRecord,
): readonly SessionExtensionNoticeRecord[] {
  const next = [...state.notices.filter((entry) => entry.id !== notice.id), notice];
  const overflow = Math.max(0, next.length - EXTENSION_NOTICE_LIMIT);
  state.notices = next.slice(overflow);
  return next.slice(0, overflow);
}

export function removeExtensionNotice(
  state: { notices: SessionExtensionNoticeRecord[] },
  noticeId: string,
): boolean {
  const next = state.notices.filter((entry) => entry.id !== noticeId);
  if (next.length === state.notices.length) {
    return false;
  }
  state.notices = next;
  return true;
}
