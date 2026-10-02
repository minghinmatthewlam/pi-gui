import { expect, test } from "@playwright/test";
import { sessionKey, type SessionDriverEvent } from "@pi-gui/session-driver";
import type { SessionExtensionNoticeRecord } from "../../contracts/desktop-state";
import type { TranscriptMessage } from "../../contracts/timeline-types";
import { applyTimelineEvent } from "../../electron/conversation/app-store-timeline";
import {
  EXTENSION_NOTICE_LIMIT,
  appendExtensionNotice,
  extensionNoticeFromRequest,
  removeExtensionNotice,
} from "../../electron/extensions/extension-notices";

const sessionRef = { workspaceId: "workspace", sessionId: "session" };
const timestamp = "2026-09-30T01:00:00.000Z";

function notice(id: string): SessionExtensionNoticeRecord {
  return { id, level: "info", message: `Notice ${id}`, createdAt: timestamp };
}

function notifyEvent(level?: "info" | "warning" | "error"): SessionDriverEvent {
  return {
    type: "hostUiRequest",
    sessionRef,
    timestamp,
    request: { kind: "notify", requestId: `n-${level}`, message: `${level} notice`, level },
  };
}

test("notify without a level becomes an info notice keyed by its request id", () => {
  expect(
    extensionNoticeFromRequest({ kind: "notify", requestId: "r1", message: "Saved" }, timestamp),
  ).toEqual({ id: "r1", level: "info", message: "Saved", createdAt: timestamp });
});

test("notices keep the newest five and report the ones that fell off", () => {
  const state = { notices: [] as SessionExtensionNoticeRecord[] };
  for (let index = 1; index <= EXTENSION_NOTICE_LIMIT; index += 1) {
    expect(appendExtensionNotice(state, notice(String(index)))).toEqual([]);
  }

  const dropped = appendExtensionNotice(state, notice("6"));

  expect(dropped.map((entry) => entry.id)).toEqual(["1"]);
  expect(state.notices.map((entry) => entry.id)).toEqual(["2", "3", "4", "5", "6"]);
});

test("removing a notice reports whether it was still shown", () => {
  const state = { notices: [notice("a"), notice("b")] };

  expect(removeExtensionNotice(state, "a")).toBe(true);
  expect(removeExtensionNotice(state, "a")).toBe(false);
  expect(state.notices.map((entry) => entry.id)).toEqual(["b"]);
});

test("only error notices add a transcript row", () => {
  const transcript = new Map<string, readonly TranscriptMessage[]>();
  const state: Parameters<typeof applyTimelineEvent>[2] = {
    activeAssistantMessageBySession: new Map(),
    pendingAssistantMessageBySession: new Map(),
    extensionToolLabels: () => new Map(),
    runningSinceBySession: new Map(),
    runMetricsBySession: new Map(),
  };

  for (const level of [undefined, "info", "warning", "error"] as const) {
    applyTimelineEvent(transcript, notifyEvent(level), state);
  }

  const rows = transcript.get(sessionKey(sessionRef)) ?? [];
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ kind: "activity", label: "error notice", tone: "error" });
});
