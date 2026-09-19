import type { SessionRef } from "./types.js";

export function sessionKey(sessionRef: SessionRef): string {
  return `${sessionRef.workspaceId}:${sessionRef.sessionId}`;
}
