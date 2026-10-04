import { readFile, writeFile } from "node:fs/promises";
import Module from "node:module";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { sessionKey, type SessionTranscriptItem } from "@pi-gui/session-driver";
import type { RuntimeCommandRecord, RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import { format } from "prettier";
import {
  createEmptyDesktopAppState,
  type DesktopAppState,
  type ExtensionCommandCompatibilityRecord,
  type SelectedTranscriptRecord,
  type TranscriptMessage,
} from "../../contracts/desktop-state";
import type { ScheduledTaskSchedule } from "../../contracts/scheduled-tasks";
import {
  extensionToolLabels,
  extensionToolRowLabel,
  toolInputSummary,
  truncate,
} from "../../contracts/tool-labels";
import {
  buildWorkspaceRecords,
  buildWorktreeRecords,
  cloneComposerAttachments,
  formatElapsedDuration,
  hasUnseenSessionUpdate,
  mergeQueuedComposerMessages,
  previewFromTranscript,
  toSessionQueuedMessages,
  toTranscriptAttachments,
} from "../../electron/application/app-store-utils";
import {
  applySessionEventState,
  updateSessionRecord,
} from "../../electron/conversation/app-store-session-state";
import {
  appendAssistantDelta,
  appendUserMessage,
  applyTimelineEvent,
  timelineFromDriverTranscript,
  type RunMetrics,
} from "../../electron/conversation/app-store-timeline";
import {
  getLearnedCommandCompatibility,
  pruneCompatibilityForRuntimeSnapshot,
  recordLearnedCommandCompatibility,
  restoreCompatibilityByWorkspace,
  serializeCompatibilityByWorkspace,
} from "../../electron/conversation/extension-command-compatibility";
import type { MutableSessionExtensionUiState } from "../../electron/conversation/session-state-map";
import {
  earliestScheduledWakeAt,
  nextRunAt,
} from "../../electron/scheduled-tasks/scheduled-task-schedule";
import * as extensionUiState from "../../../../packages/pi-sdk-driver/src/extension-ui-state";
import {
  at,
  catalogSessions,
  catalogWorkspaces,
  catalogWorktrees,
  extension,
  fresh,
  main,
  other,
  runtime,
  scenarios,
  ws,
  type Scenario,
} from "../helpers/rust-state-scenarios";

/**
 * Golden fixtures for the Rust twins of the app-state functions (`crates/pi-gui-core/src/state`).
 * This runs the TypeScript functions on the inputs in `rust-state-scenarios.ts` and checks the
 * saved fixtures still hold what they produce; `crates/pi-gui-core/tests/state_fixtures.rs`
 * replays the same inputs in Rust and must produce the same JSON.
 *
 * After changing one of the TypeScript functions or the inputs, rewrite the fixtures with
 * `pnpm --filter @pi-gui/desktop run fixtures:rust-state`, then make the Rust tests pass.
 *
 * The clock stands still at each step's `now` and times of day print in en-US, UTC. Generated
 * UUIDs are numbered in order of appearance (`uuid-1`, ...) on both sides; keys are sorted.
 */

// session-state-map.ts takes its extension UI helpers from pi-sdk-driver's index, which also
// loads pi itself (ESM only, so not loadable in a unit spec). Stand the helpers' own module in
// for the index before loading it.
const driverIndex = join(__dirname, "../../../../packages/pi-sdk-driver/src/index.ts");
const driverModule = new Module(driverIndex);
driverModule.filename = driverIndex;
driverModule.loaded = true;
driverModule.exports = extensionUiState;
require.cache[driverIndex] = driverModule;
const { SessionStateMap, createEmptyExtensionUiState, serializeExtensionUiState } =
  require("../../electron/conversation/session-state-map") as typeof import("../../electron/conversation/session-state-map");
const { applyHostUiRequestToExtensionUiState } = extensionUiState;

const fixtureDir = join(__dirname, "../../../../crates/pi-gui-core/tests/fixtures/state");
const update = process.env.PI_GUI_UPDATE_RUST_FIXTURES === "1";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

const RealDate = Date;

/** Runs `body` with `new Date()` fixed at `now` and `toLocaleTimeString` in en-US, UTC. */
function withClock<T>(now: string, body: () => T): T {
  const fixed = RealDate.parse(now);
  class FixedDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(fixed);
      else super(...(args as [string]));
    }
    static override now() {
      return fixed;
    }
    override toLocaleTimeString(_locales?: unknown, options?: Intl.DateTimeFormatOptions) {
      return super.toLocaleTimeString("en-US", { ...options, timeZone: "UTC" });
    }
  }
  globalThis.Date = FixedDate as DateConstructor;
  try {
    return body();
  } finally {
    globalThis.Date = RealDate;
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .filter((key) => record[key] !== undefined)
        .map((key) => [key, canonical(record[key])]),
    );
  }
  return value;
}

/** Sorted keys, and generated UUIDs numbered by first appearance, as the Rust test does. */
function normalize(value: unknown): unknown {
  const ids = new Map<string, string>();
  const text = JSON.stringify(canonical(value)).replace(UUID, (id) => {
    let name = ids.get(id);
    if (!name) {
      name = `uuid-${ids.size + 1}`;
      ids.set(id, name);
    }
    return name;
  });
  return JSON.parse(text);
}

function record<V>(map: ReadonlyMap<string, V>): Record<string, V> {
  return Object.fromEntries(map);
}

function runScenario(scenario: Scenario) {
  const transcriptCache = new Map<string, readonly TranscriptMessage[]>();
  const timeline = {
    runMetricsBySession: new Map<string, RunMetrics>(),
    runningSinceBySession: new Map<string, string>(),
    activeAssistantMessageBySession: new Map<string, string>(),
    pendingAssistantMessageBySession: new Map<string, string>(),
    activeWorkingActivityBySession: new Map<string, string>(),
    extensionToolLabels: (ref: { workspaceId: string }) =>
      extensionToolLabels(scenario.runtimeByWorkspace[ref.workspaceId]),
  };
  const lastViewedAtBySession = new Map(Object.entries(scenario.lastViewedAtBySession));
  const extensionUi = new Map<string, MutableSessionExtensionUiState>();
  let state: DesktopAppState = structuredClone(scenario.initialState);
  const steps = scenario.steps.map((step) =>
    withClock(step.now, () => {
      const ref = step.op === "event" ? step.event.sessionRef : step.sessionRef;
      const key = sessionKey(ref);
      let returned: unknown;
      if (step.op === "userMessage") {
        // As the composer sends it: the optimistic row first.
        returned = appendUserMessage(
          transcriptCache,
          ref,
          step.text,
          toTranscriptAttachments(step.attachments ?? []),
        );
      } else if (step.op === "loadTranscript") {
        transcriptCache.set(
          key,
          timelineFromDriverTranscript(step.items, timeline.extensionToolLabels(ref)),
        );
      } else {
        // The pure part of the store's `handleSessionEvent`, in its order.
        const event = step.event;
        if (event.type === "assistantDelta") {
          appendAssistantDelta(
            transcriptCache,
            timeline.activeAssistantMessageBySession,
            ref,
            event.text,
          );
        }
        if (event.type === "hostUiRequest") {
          const ui = extensionUi.get(key) ?? createEmptyExtensionUiState();
          extensionUi.set(key, ui);
          applyHostUiRequestToExtensionUiState(ui, event.request);
        }
        applyTimelineEvent(transcriptCache, event, timeline);
        state = applySessionEventState(
          state,
          event,
          transcriptCache,
          timeline.runningSinceBySession,
          lastViewedAtBySession,
        );
      }
      const ui = extensionUi.get(key);
      // A copy: run metrics are changed in place by later steps.
      return structuredClone({
        returned,
        transcript: transcriptCache.get(key) ?? null,
        transcriptKeys: [...transcriptCache.keys()],
        timeline: {
          runMetricsBySession: record(timeline.runMetricsBySession),
          runningSinceBySession: record(timeline.runningSinceBySession),
          activeAssistantMessageBySession: record(timeline.activeAssistantMessageBySession),
          pendingAssistantMessageBySession: record(timeline.pendingAssistantMessageBySession),
          activeWorkingActivityBySession: record(timeline.activeWorkingActivityBySession),
        },
        extensionUi: ui ? serializeExtensionUiState(ui) : null,
        session:
          state.workspaces
            .find((workspace) => workspace.id === ref.workspaceId)
            ?.sessions.find((session) => session.id === ref.sessionId) ?? null,
        revision: state.revision,
      });
    }),
  );
  return {
    input: scenario,
    expected: normalize({ steps, workspaces: state.workspaces }),
    finalState: state,
  };
}

interface FunctionCase {
  readonly fn: string;
  readonly now?: string;
  readonly args: Record<string, unknown>;
}

function attempt(body: () => unknown): unknown {
  try {
    return { value: body() ?? null };
  } catch (error) {
    const { name, message } = error as Error;
    return { error: { name, message } };
  }
}

function runCase(input: FunctionCase): unknown {
  const args = input.args as Record<string, never>;
  return withClock(input.now ?? at(0), () => {
    switch (input.fn) {
      case "extensionToolLabels":
        return [...extensionToolLabels(args.runtime ?? undefined)];
      case "extensionToolRowLabel":
        return extensionToolRowLabel(args.label, args.input);
      case "toolInputSummary":
        return toolInputSummary(args.input) ?? null;
      case "truncate":
        return truncate(args.value, args.limit);
      case "timelineFromDriverTranscript":
        return timelineFromDriverTranscript(args.items, new Map(args.labels));
      case "buildWorkspaceRecords": {
        const map = <V>(name: string) =>
          new Map(Object.entries((args[name] ?? {}) as Record<string, V>));
        return buildWorkspaceRecords(
          args.workspaces,
          args.worktrees,
          args.sessions,
          map("transcriptCache"),
          map("runningSinceBySession"),
          map("sessionConfigBySession"),
          map("lastViewedAtBySession"),
          map("lastInteractedAtBySession"),
          map("pinnedAtBySession"),
        );
      }
      case "buildWorktreeRecords":
        return buildWorktreeRecords(args.workspaces, args.worktrees);
      case "hasUnseenSessionUpdate":
        return hasUnseenSessionUpdate(
          args.status,
          args.updatedAt,
          args.lastViewedAt,
          args.transcript,
        );
      case "previewFromTranscript":
        return previewFromTranscript(args.transcript) ?? null;
      case "formatElapsedDuration":
        return formatElapsedDuration(args.startedAt, args.endedAt);
      case "cloneComposerAttachments":
        return cloneComposerAttachments(args.attachments);
      case "toSessionQueuedMessages":
        return toSessionQueuedMessages(args.messages);
      case "mergeQueuedComposerMessages":
        return mergeQueuedComposerMessages(args.previous, args.next);
      case "updateSessionRecord":
        return updateSessionRecord(args.session, {
          snapshot: args.snapshot,
          status: args.status,
          transcript: args.transcript,
          preview: args.preview,
          runningSince: args.runningSince,
          lastViewedAt: args.lastViewedAt,
        });
      case "extensionCommandCompatibility": {
        const restored = restoreCompatibilityByWorkspace(args.payload);
        const afterRestore = serializeCompatibilityByWorkspace(restored);
        const recorded = args.record as {
          workspaceId: string;
          record: ExtensionCommandCompatibilityRecord;
        };
        recordLearnedCommandCompatibility(restored, recorded.workspaceId, recorded.record);
        const afterRecord = serializeCompatibilityByWorkspace(restored);
        const lookup = args.lookup as { workspaceId: string; command: RuntimeCommandRecord };
        const learned =
          getLearnedCommandCompatibility(restored, lookup.workspaceId, lookup.command) ?? null;
        pruneCompatibilityForRuntimeSnapshot(restored, args.runtime);
        return {
          afterRestore,
          afterRecord,
          learned,
          afterPrune: serializeCompatibilityByWorkspace(restored),
        };
      }
      case "SessionStateMap.prune": {
        const map = new SessionStateMap();
        const log: string[] = [];
        const keys = args.keys as Record<string, string[]>;
        for (const key of keys.transcriptCache ?? []) map.transcriptCache.set(key, []);
        for (const key of keys.composerDraftsBySession ?? [])
          map.composerDraftsBySession.set(key, "draft");
        for (const key of keys.lastViewedAtBySession ?? [])
          map.lastViewedAtBySession.set(key, at(0));
        for (const key of keys.pinnedAtBySession ?? []) map.pinnedAtBySession.set(key, at(0));
        for (const key of keys.extensionFlagsBySession ?? [])
          map.extensionFlagsBySession.set(key, {});
        for (const key of keys.runningSinceBySession ?? [])
          map.runningSinceBySession.set(key, at(0));
        for (const key of keys.sessionErrorsBySession ?? [])
          map.sessionErrorsBySession.set(key, "error");
        for (const key of keys.sessionSubscriptions ?? [])
          map.sessionSubscriptions.set(key, () => log.push(`unsubscribe:${key}`));
        for (const key of keys.pendingAutoTitleBySession ?? [])
          map.pendingAutoTitleBySession.set(key, {
            requestToken: "token",
            cancel: () => log.push(`cancel:${key}`),
          });
        for (const key of keys.loadedTranscriptKeys ?? []) map.loadedTranscriptKeys.add(key);
        map.pinnedSessionOrder = [...(keys.pinnedSessionOrder ?? [])];
        const changed = map.prune(new Set(args.activeKeys as string[]));
        return {
          changed,
          log,
          remaining: {
            transcriptCache: [...map.transcriptCache.keys()],
            composerDraftsBySession: [...map.composerDraftsBySession.keys()],
            lastViewedAtBySession: [...map.lastViewedAtBySession.keys()],
            pinnedAtBySession: [...map.pinnedAtBySession.keys()],
            extensionFlagsBySession: [...map.extensionFlagsBySession.keys()],
            runningSinceBySession: [...map.runningSinceBySession.keys()],
            sessionErrorsBySession: [...map.sessionErrorsBySession.keys()],
            sessionSubscriptions: [...map.sessionSubscriptions.keys()],
            pendingAutoTitleBySession: [...map.pendingAutoTitleBySession.keys()],
            loadedTranscriptKeys: [...map.loadedTranscriptKeys],
            pinnedSessionOrder: map.pinnedSessionOrder,
          },
        };
      }
      case "nextRunAt":
        return attempt(() =>
          nextRunAt(args.schedule as ScheduledTaskSchedule, new Date(args.from as string)),
        );
      case "earliestScheduledWakeAt":
        return earliestScheduledWakeAt(args.tasks, new Date(args.now as string)) ?? null;
      default:
        throw new Error(`No case runner for ${input.fn}`);
    }
  });
}

const labelledRuntime = scenarios.find((scenario) => scenario.name === "extension-tools")!
  .runtimeByWorkspace[ws] as RuntimeSnapshot;

const savedTranscript = scenarios.find(
  (scenario) => scenario.name === "reload-compaction-and-host-ui",
)!.steps[0] as { items: SessionTranscriptItem[] };

const transcriptRows: TranscriptMessage[] = [
  { kind: "message", id: "m-1", role: "user", text: "Hi", createdAt: at(1) },
  {
    kind: "tool",
    id: "c-1",
    callId: "c-1",
    toolName: "read",
    status: "success",
    label: "Read a",
    createdAt: at(3),
  },
  { kind: "activity", id: "a-1", label: "Working…", createdAt: at(2) },
];

const command: RuntimeCommandRecord = {
  name: "ticket",
  source: "extension",
  sourceInfo: { path: "/ext/tickets.ts", source: "tickets", scope: "project", origin: "top-level" },
};

function compat(
  extensionPath: string,
  commandName: string,
  status: ExtensionCommandCompatibilityRecord["status"] = "terminal-only",
): ExtensionCommandCompatibilityRecord {
  return {
    commandName,
    extensionPath,
    status,
    message: `${commandName} needs a terminal`,
    capability: "ui.custom",
    updatedAt: at(1),
  };
}

const functionCases: FunctionCase[] = [
  { fn: "extensionToolLabels", args: { runtime: labelledRuntime } },
  { fn: "extensionToolLabels", args: { runtime: null } },
  { fn: "extensionToolRowLabel", args: { label: "Fetch page", input: { url: "https://pi.dev" } } },
  {
    fn: "extensionToolRowLabel",
    args: { label: "Read issue", input: { kind: "pr", "10": 1.5, "2": true, empty: "  " } },
  },
  { fn: "extensionToolRowLabel", args: { label: "List todos", input: {} } },
  { fn: "extensionToolRowLabel", args: { label: "List todos", input: "   " } },
  { fn: "extensionToolRowLabel", args: { label: "List todos" } },
  {
    fn: "extensionToolRowLabel",
    args: { label: "Nested", input: { filter: { done: true }, list: [1] } },
  },
  { fn: "toolInputSummary", args: { input: { prompt: "  a\n\nlong   prompt  ", title: "t" } } },
  { fn: "toolInputSummary", args: { input: ["path"] } },
  { fn: "toolInputSummary", args: { input: 42 } },
  { fn: "truncate", args: { value: "x".repeat(200) } },
  { fn: "truncate", args: { value: "﻿  é ".repeat(30), limit: 20 } },
  { fn: "truncate", args: { value: "short", limit: 1 } },
  {
    fn: "timelineFromDriverTranscript",
    args: { items: savedTranscript.items, labels: [...extensionToolLabels(labelledRuntime)] },
  },
  { fn: "timelineFromDriverTranscript", args: { items: savedTranscript.items, labels: [] } },
  {
    fn: "buildWorkspaceRecords",
    args: {
      workspaces: catalogWorkspaces,
      worktrees: catalogWorktrees,
      sessions: catalogSessions,
      transcriptCache: { "ws-main:s-main": transcriptRows, "ws-tree:s-fresh": [] },
      runningSinceBySession: { "ws-main:s-main": at(1) },
      sessionConfigBySession: {
        "ws-main:s-main": { provider: "anthropic", modelId: "claude-sonnet" },
      },
      lastViewedAtBySession: {
        "ws-main:s-main": at(0),
        "ws-main:s-other": at(1),
        "ws-tree:s-fresh": at(0),
      },
      lastInteractedAtBySession: { "ws-main:s-other": at(2) },
      pinnedAtBySession: { "ws-tree:s-fresh": at(4) },
    },
  },
  {
    fn: "buildWorkspaceRecords",
    args: { workspaces: catalogWorkspaces, worktrees: [], sessions: [] },
  },
  {
    fn: "buildWorktreeRecords",
    args: { workspaces: catalogWorkspaces, worktrees: catalogWorktrees },
  },
  {
    fn: "hasUnseenSessionUpdate",
    args: { status: "idle", updatedAt: at(1), lastViewedAt: at(2), transcript: transcriptRows },
  },
  {
    fn: "hasUnseenSessionUpdate",
    args: { status: "idle", updatedAt: at(1), lastViewedAt: at(5), transcript: transcriptRows },
  },
  {
    fn: "hasUnseenSessionUpdate",
    args: { status: "running", updatedAt: at(9), lastViewedAt: at(1), transcript: [] },
  },
  { fn: "hasUnseenSessionUpdate", args: { status: "failed", updatedAt: at(9), transcript: [] } },
  { fn: "previewFromTranscript", args: { transcript: transcriptRows } },
  { fn: "previewFromTranscript", args: { transcript: [transcriptRows[2], transcriptRows[1]] } },
  { fn: "previewFromTranscript", args: { transcript: [] } },
  ...(
    [
      [at(0), at(0)],
      [at(0), at(0, 1)],
      [at(0), at(0, 59)],
      [at(0), at(1)],
      [at(0), at(3, 5)],
      [at(5), at(0)],
      ["2026-10-01T19:00:00.000Z", "2026-10-01T19:00:59.500Z"],
      ["2026-10-01T19:00:00.000Z", "2026-10-01T19:00:01.499Z"],
      ["not a date", at(1)],
      ["2026-10-01T19:00:00+02:00", "2026-10-01T18:00:00Z"],
    ] as const
  ).map(([startedAt, endedAt]) => ({ fn: "formatElapsedDuration", args: { startedAt, endedAt } })),
  {
    fn: "cloneComposerAttachments",
    args: {
      attachments: [
        { id: "i-1", kind: "image", name: "a.png", mimeType: "image/png", data: "UE5H" },
        { id: "i-legacy", name: "old.png", mimeType: "image/png", data: "UE5H" },
        {
          id: "f-1",
          kind: "file",
          name: "b.txt",
          mimeType: "text/plain",
          fsPath: "/b.txt",
          sizeBytes: 9,
        },
        {
          id: "f-2",
          kind: "file",
          name: "c.txt",
          mimeType: "text/plain",
          fsPath: "/c.txt",
          sizeBytes: "9",
        },
        { id: "bad", kind: "file", name: "d.txt", mimeType: "text/plain" },
        { id: "null-kind", kind: null, name: "e.png", mimeType: "image/png", data: "x" },
      ],
    },
  },
  {
    fn: "toSessionQueuedMessages",
    args: {
      messages: [
        {
          id: "q-1",
          mode: "steer",
          text: "now",
          attachments: [
            { id: "i-1", kind: "image", name: "a.png", mimeType: "image/png", data: "UE5H" },
            { id: "f-1", kind: "file", name: "b.txt", mimeType: "text/plain", fsPath: "/b.txt" },
          ],
          createdAt: at(1),
          updatedAt: at(2),
        },
        {
          id: "q-2",
          mode: "followUp",
          text: "later",
          attachments: [],
          createdAt: at(1),
          updatedAt: at(1),
        },
      ],
    },
  },
  {
    fn: "mergeQueuedComposerMessages",
    args: {
      previous: [
        {
          id: "q-1",
          mode: "steer",
          text: "now",
          attachments: [
            { id: "keep-image", kind: "image", name: "a.png", mimeType: "image/png", data: "UE5H" },
            {
              id: "keep-file",
              kind: "file",
              name: "b.txt",
              mimeType: "text/plain",
              fsPath: "/b.txt",
              sizeBytes: 3,
            },
          ],
          createdAt: at(1),
          updatedAt: at(1),
        },
      ],
      next: [
        {
          id: "q-1",
          mode: "followUp",
          text: "now, edited",
          attachments: [
            { kind: "image", name: "a.png", mimeType: "image/png", data: "UE5H" },
            { kind: "file", name: "b.txt", mimeType: "text/plain", fsPath: "/b.txt", sizeBytes: 4 },
            { kind: "image", mimeType: "image/jpeg", data: "SlBH" },
          ],
          createdAt: at(1),
          updatedAt: at(2),
        },
        { id: "q-2", mode: "steer", text: "plain", createdAt: at(2), updatedAt: at(2) },
      ],
    },
  },
  { fn: "mergeQueuedComposerMessages", args: { next: [] } },
  {
    fn: "updateSessionRecord",
    args: {
      session: {
        id: "s-1",
        title: "Resolved title",
        updatedAt: at(1),
        pinnedAt: at(0),
        lastInteractedAt: at(0),
        archivedAt: at(0),
        preview: "old preview",
        status: "running",
        runningSince: at(1),
        hasUnseenUpdate: false,
        config: { provider: "anthropic" },
      },
      snapshot: { title: "New thread", updatedAt: at(3), status: "idle" },
      transcript: transcriptRows,
      lastViewedAt: at(2),
    },
  },
  {
    fn: "updateSessionRecord",
    args: {
      session: {
        id: "s-1",
        title: "New thread",
        updatedAt: at(1),
        preview: "p",
        status: "idle",
        hasUnseenUpdate: true,
      },
      snapshot: { title: "Named", archivedAt: at(4), preview: "from pi", config: { modelId: "m" } },
      status: "failed",
      transcript: [],
      preview: "from transcript",
      runningSince: at(2),
    },
  },
  {
    fn: "extensionCommandCompatibility",
    args: {
      payload: {
        [ws]: [
          compat("/ext/tickets.ts", "ticket:list"),
          compat("/ext/a.ts", "zeta"),
          compat("/ext/a.ts", "Alpha"),
          compat("", "nameless"),
        ],
        "ws-gone": [compat("/ext/gone.ts", "gone")],
        "ws-empty": [compat("/ext/x.ts", "")],
      },
      record: { workspaceId: ws, record: compat("/ext/tickets.ts", "ticket", "supported") },
      lookup: { workspaceId: ws, command },
      runtime: runtime(ws, [extension("tickets", [], { commands: ["ticket"] })]),
    },
  },
  {
    fn: "SessionStateMap.prune",
    args: {
      keys: {
        transcriptCache: ["ws:a", "ws:b"],
        composerDraftsBySession: ["ws:c", "ws:a"],
        lastViewedAtBySession: ["ws:a", "ws:d"],
        pinnedAtBySession: ["ws:a"],
        extensionFlagsBySession: ["ws:e"],
        runningSinceBySession: ["ws:b"],
        sessionErrorsBySession: ["ws:f"],
        sessionSubscriptions: ["ws:b", "ws:a"],
        pendingAutoTitleBySession: ["ws:b", "ws:g"],
        loadedTranscriptKeys: ["ws:h", "ws:a"],
        pinnedSessionOrder: ["ws:i", "ws:a"],
      },
      activeKeys: ["ws:a"],
    },
  },
  {
    fn: "SessionStateMap.prune",
    args: {
      keys: { transcriptCache: ["ws:gone"], sessionSubscriptions: ["ws:gone"] },
      activeKeys: [],
    },
  },
  ...scheduleCases(),
  {
    fn: "earliestScheduledWakeAt",
    args: {
      now: at(5),
      tasks: [
        { status: "paused", nextRunAt: at(1) },
        { status: "active", nextRunAt: "not a date" },
        { status: "active", nextRunAt: at(9) },
        { status: "active", nextRunAt: at(7) },
        { status: "active" },
      ],
    },
  },
  {
    fn: "earliestScheduledWakeAt",
    args: { now: at(5), tasks: [{ status: "active", nextRunAt: at(2) }] },
  },
  { fn: "earliestScheduledWakeAt", args: { now: at(5), tasks: [] } },
];

function scheduleCases(): FunctionCase[] {
  const cases: Array<[ScheduledTaskSchedule, string]> = [
    [{ kind: "once", at: "2026-10-02T09:00:00.000Z" }, at(0)],
    [{ kind: "once", at: at(0) }, at(0)],
    [{ kind: "once", at: "soon" }, at(0)],
    [{ kind: "interval", everyMs: 3_600_000 }, at(0)],
    [{ kind: "daily", hour: 9, minute: 30, timeZone: "America/New_York" }, at(0)],
    [{ kind: "daily", hour: 15, minute: 30, timeZone: "America/New_York" }, at(0)],
    [
      { kind: "daily", hour: 2, minute: 30, timeZone: "America/New_York" },
      "2026-03-07T12:00:00.000Z",
    ],
    [
      { kind: "daily", hour: 1, minute: 30, timeZone: "America/New_York" },
      "2026-10-31T12:00:00.000Z",
    ],
    [{ kind: "daily", hour: 0, minute: 0, timeZone: "Asia/Kolkata" }, "2026-12-31T18:29:00.000Z"],
    [{ kind: "daily", hour: 23, minute: 59, timeZone: "UTC" }, "2026-12-31T23:59:00.000Z"],
    [{ kind: "weekly", days: [1, 3], hour: 8, minute: 0, timeZone: "Europe/London" }, at(0)],
    [{ kind: "weekly", days: [4], hour: 20, minute: 0, timeZone: "Europe/London" }, at(0)],
    [{ kind: "weekly", days: [], hour: 8, minute: 0, timeZone: "Australia/Sydney" }, at(0)],
    [
      { kind: "weekly", days: [0], hour: 2, minute: 30, timeZone: "Europe/Berlin" },
      "2026-03-25T12:00:00.000Z",
    ],
    [{ kind: "daily", hour: 9, minute: 0, timeZone: "Mars/Olympus" }, at(0)],
  ];
  return cases.map(([schedule, from]) => ({ fn: "nextRunAt", args: { schedule, from } }));
}

function contractStates(finalState: DesktopAppState): DesktopAppState[] {
  const rich: DesktopAppState = {
    ...finalState,
    worktreesByWorkspace: buildWorktreeRecords(catalogWorkspaces, catalogWorktrees),
    composerDraft: "Draft text",
    composerDraftSyncSource: "remote-persist",
    composerDraftSyncNonce: 3,
    composerAttachments: [
      { id: "i-1", kind: "image", name: "a.png", mimeType: "image/png", data: "UE5H" },
      {
        id: "f-1",
        kind: "file",
        name: "b.txt",
        mimeType: "text/plain",
        fsPath: "/b.txt",
        sizeBytes: 9,
      },
    ],
    queuedComposerMessages: [
      {
        id: "q-1",
        mode: "followUp",
        text: "next",
        attachments: [],
        createdAt: at(1),
        updatedAt: at(1),
      },
    ],
    editingQueuedMessageId: "q-1",
    runtimeByWorkspace: { [ws]: labelledRuntime },
    sessionCommandsBySession: {
      "ws-main:s-main": [
        command,
        { ...command, name: "review", source: "prompt", description: "Review" },
      ],
    },
    sessionUsageBySession: {
      "ws-main:s-main": {
        context: { tokens: null, contextWindow: 200_000 },
        cache: {},
        totals: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5 },
        subscription: true,
      },
    },
    sessionExtensionUiBySession: {
      "ws-main:s-main": {
        instanceId: "ui-1",
        statuses: [{ key: "ci", text: "CI: running" }],
        widgets: [{ key: "todo", lines: ["one"], placement: "belowComposer" }],
        pendingDialogs: [
          {
            kind: "select",
            requestId: "r-1",
            title: "Pick",
            options: ["a", "b"],
            allowMultiple: true,
          },
          { kind: "input", requestId: "r-2", title: "Name", placeholder: "name" },
          { kind: "editor", requestId: "r-3", title: "Edit", initialValue: "text" },
          {
            kind: "confirm",
            requestId: "r-4",
            title: "Sure?",
            message: "Really?",
            defaultValue: true,
          },
        ],
        notices: [{ id: "n-1", level: "warning", message: "Careful", createdAt: at(1) }],
        title: "Plan mode",
        editorText: "/plan",
      },
    },
    extensionCommandCompatibilityByWorkspace: { [ws]: [compat("/ext/a.ts", "a")] },
    extensionFlagsByWorkspace: { [ws]: { verbose: true, name: "x", off: false } },
    extensionFlagsBySession: { "ws-main:s-main": { verbose: true } },
    orchestrationChildren: [
      {
        id: "child-1",
        sourceToolCallId: "call-child",
        parentWorkspaceId: ws,
        parentSessionId: "s-main",
        childWorkspaceId: "ws-tree",
        childSessionId: "s-fresh",
        title: "Child",
        goal: "Do it",
        status: "waiting",
        latestTranscript: "done?",
        transcript: [{ id: "t-1", role: "parent", text: "go", createdAt: at(1) }],
        evidence: [
          {
            id: "e-1",
            childThreadId: "child-1",
            kind: "review_finding",
            source: "orchestrator-observed",
            status: "passed",
            title: "Tests pass",
            severity: "P2",
            git: { workspaceId: ws, branchName: "feature", headSha: "abc" },
            createdAt: at(2),
          },
        ],
        supervisionLoop: {
          id: "loop-1",
          status: "monitoring",
          gate: "continue",
          intervalMs: 60_000,
          iterationCount: 2,
          lastCheckedAt: at(3),
          nextRunAt: at(4),
          reason: "Waiting for tests",
          lastChildStatus: "running",
        },
        createdAt: at(1),
        updatedAt: at(3),
      },
    ],
    scheduledTasks: [
      {
        id: "task-1",
        title: "Daily digest",
        instruction: "Summarize",
        status: "active",
        schedule: { kind: "weekly", days: [1, 5], hour: 9, minute: 0, timeZone: "UTC" },
        target: { kind: "existing-thread", workspaceId: ws, sessionId: "s-main" },
        createdAt: at(0),
        updatedAt: at(0),
        nextRunAt: at(9),
        runs: [
          {
            id: "run-1",
            sessionId: "s-main",
            workspaceId: ws,
            firedAt: at(1),
            instruction: "Summarize",
            outcome: "failed",
            error: "offline",
          },
        ],
      },
      {
        id: "task-2",
        title: "Once",
        instruction: "Ping",
        status: "completed",
        schedule: { kind: "interval", everyMs: 60_000 },
        target: { kind: "new-thread", workspaceId: ws },
        createdAt: at(0),
        updatedAt: at(0),
        completedAt: at(2),
        originSessionId: "s-main",
        runs: [],
      },
    ],
    notificationPreferences: {
      backgroundCompletion: false,
      backgroundFailure: true,
      attentionNeeded: false,
    },
    integratedTerminalShell: "/bin/zsh",
    lastViewedAtBySession: { "ws-main:s-main": at(1) },
    lastInteractedAtBySession: { "ws-main:s-main": at(2) },
    pinnedAtBySession: { "ws-main:s-main": at(3) },
    pinnedSessionOrder: ["ws-main:s-main"],
    workspaceOrder: [ws, "ws-tree"],
    modelSettingsScopeMode: "per-repo",
    globalModelSettings: {
      defaultProvider: "anthropic",
      defaultThinkingLevel: "xhigh",
      enabledModelPatterns: ["*"],
    },
    themeMode: "dark",
    themePresetId: "tokyo-night",
    sidebarCollapsed: true,
    threadGrouping: "workspace",
    collapsedWorkspaceIds: ["ws-tree"],
    enableTransparency: true,
    startupDiagnostics: [
      { scope: "workspace", message: "Folder is missing", workspacePath: "/repo/gone" },
      { scope: "application", message: "Settings were reset" },
    ],
    activeView: "new-thread",
    lastError: "Something failed",
  };
  return [createEmptyDesktopAppState(), rich];
}

test("Rust state fixtures hold what the TypeScript functions produce", async () => {
  const streams = scenarios.map(runScenario);
  const finalState = streams[0]!.finalState;
  const selectedTranscripts: SelectedTranscriptRecord[] = [
    {
      workspaceId: ws,
      sessionId: "s-main",
      transcript: withClock(at(0), () =>
        timelineFromDriverTranscript(savedTranscript.items, extensionToolLabels(labelledRuntime)),
      ),
      schemaInfo: { fileSchemaVersion: 3, runtimeSchemaVersion: 3, writtenByNewerRuntime: false },
    },
    {
      workspaceId: fresh.workspaceId,
      sessionId: fresh.sessionId,
      transcript: [],
      schemaInfo: {
        fileSchemaVersion: undefined,
        runtimeSchemaVersion: 3,
        writtenByNewerRuntime: false,
      },
    },
    { workspaceId: other.workspaceId, sessionId: other.sessionId, transcript: [] },
  ];
  const fixtures: Record<string, unknown> = {
    "event-streams.json": streams.map(({ input, expected }) => ({ input, expected })),
    "functions.json": functionCases.map((input) => ({
      ...input,
      expected: normalize(runCase(input)),
    })),
    "contracts.json": {
      desktopStates: contractStates(finalState),
      selectedTranscripts,
    },
  };

  const stale: string[] = [];
  for (const [file, value] of Object.entries(fixtures)) {
    const path = join(fixtureDir, file);
    const text = await format(JSON.stringify(value), { parser: "json", filepath: path });
    if (update) {
      await writeFile(path, text);
      continue;
    }
    const saved = await readFile(path, "utf8").catch(() => "");
    if (saved !== text) stale.push(file);
  }
  expect(
    stale,
    "Rust state fixtures are stale; run `pnpm --filter @pi-gui/desktop run fixtures:rust-state`",
  ).toEqual([]);
});
