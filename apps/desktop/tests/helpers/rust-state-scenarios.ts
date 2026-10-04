import type {
  SessionCatalogEntry,
  WorkspaceCatalogEntry,
  WorktreeCatalogEntry,
} from "@pi-gui/catalogs";
import type {
  SessionDriverEvent,
  SessionRef,
  SessionSnapshot,
  SessionTranscriptItem,
} from "@pi-gui/session-driver";
import type { RuntimeExtensionRecord, RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import {
  createEmptyDesktopAppState,
  type ComposerAttachment,
  type DesktopAppState,
  type SessionRecord,
} from "../../contracts/desktop-state";

/**
 * Session event streams and inputs that the Rust state twins (`crates/pi-gui-core/src/state`)
 * replay. `rust-state-fixtures.spec.ts` runs them through the TypeScript functions and saves
 * what they produce as the Rust golden fixtures. Ids here are never UUID-shaped, so the
 * fixture writer can number the generated ones.
 */

export type ScenarioStep =
  | { readonly op: "event"; readonly now: string; readonly event: SessionDriverEvent }
  | {
      readonly op: "userMessage";
      readonly now: string;
      readonly sessionRef: SessionRef;
      readonly text: string;
      readonly attachments?: readonly ComposerAttachment[];
    }
  | {
      readonly op: "loadTranscript";
      readonly now: string;
      readonly sessionRef: SessionRef;
      readonly items: readonly SessionTranscriptItem[];
    };

export interface Scenario {
  readonly name: string;
  readonly initialState: DesktopAppState;
  readonly runtimeByWorkspace: Readonly<Record<string, RuntimeSnapshot>>;
  readonly lastViewedAtBySession: Readonly<Record<string, string>>;
  readonly steps: readonly ScenarioStep[];
}

export const ws = "ws-main";
export const wsTree = "ws-tree";
export const main: SessionRef = { workspaceId: ws, sessionId: "s-main" };
export const other: SessionRef = { workspaceId: ws, sessionId: "s-other" };
export const fresh: SessionRef = { workspaceId: wsTree, sessionId: "s-fresh" };

/** `2026-10-01T19:MM:SS.000Z`, so every step reads in order. */
export function at(minute: number, second = 0): string {
  return `2026-10-01T19:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}.000Z`;
}

function session(id: string, title: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id,
    title,
    updatedAt: at(0),
    preview: title,
    status: "idle",
    hasUnseenUpdate: false,
    ...overrides,
  };
}

function initialState(): DesktopAppState {
  return {
    ...createEmptyDesktopAppState(),
    workspaces: [
      {
        id: ws,
        name: "pi-gui",
        path: "/repo/pi-gui",
        lastOpenedAt: at(0),
        kind: "primary",
        sessions: [
          session("s-main", "Fix the timeline", { pinnedAt: at(0), lastInteractedAt: at(0) }),
          session("s-other", "New thread", { archivedAt: at(0) }),
        ],
      },
      {
        id: wsTree,
        name: "pi-gui feature",
        path: "/repo/pi-gui-feature",
        lastOpenedAt: at(0),
        kind: "worktree",
        rootWorkspaceId: ws,
        branchName: "feature",
        sessions: [session("s-fresh", "New thread")],
      },
    ],
    selectedWorkspaceId: ws,
    selectedSessionId: "s-main",
    revision: 7,
  };
}

export function extension(
  source: string,
  tools: RuntimeExtensionRecord["tools"],
  overrides: Partial<RuntimeExtensionRecord> = {},
): RuntimeExtensionRecord {
  return {
    path: `/ext/${source}.ts`,
    displayName: source,
    enabled: true,
    sourceInfo: { path: `/ext/${source}.ts`, source, scope: "project", origin: "top-level" },
    commands: [],
    tools,
    flags: [],
    flagDetails: [],
    shortcuts: [],
    diagnostics: [],
    ...overrides,
  };
}

export function runtime(
  workspaceId: string,
  extensions: RuntimeExtensionRecord[],
): RuntimeSnapshot {
  return {
    workspace: { workspaceId, path: `/repo/${workspaceId}`, displayName: workspaceId },
    providers: [
      {
        id: "anthropic",
        name: "Anthropic",
        hasAuth: true,
        authType: "oauth",
        authSource: "oauth",
        oauthSupported: true,
        apiKeySetupSupported: true,
      },
    ],
    models: [
      {
        providerId: "anthropic",
        providerName: "Anthropic",
        modelId: "claude-sonnet",
        label: "Claude Sonnet",
        available: true,
        authType: "oauth",
        reasoning: true,
        supportsImages: true,
      },
    ],
    skills: [
      {
        name: "review",
        description: "Review a diff",
        filePath: "/skills/review/SKILL.md",
        baseDir: "/skills/review",
        source: "user",
        scope: "user",
        enabled: true,
        disableModelInvocation: false,
        slashCommand: "/skill:review",
      },
    ],
    extensions,
    settings: {
      defaultProvider: "anthropic",
      defaultModelId: "claude-sonnet",
      defaultThinkingLevel: "medium",
      enableSkillCommands: true,
      enabledModelPatterns: ["claude-*"],
    },
  };
}

const tool = (name: string, label: string, replacesPiTool = false) => ({
  name,
  label,
  replacesPiTool,
});

const labelledRuntime = runtime(ws, [
  extension("github", [
    tool("github_read", "Read GitHub issue or PR"),
    tool("blank", "  "),
    tool("bash", "bash (sandboxed)", true),
    tool("shared_name", "From github"),
  ]),
  extension("other", [tool("shared_name", "From other")]),
  extension("builtin", [tool("create_child_thread", "Child thread")]),
  extension("tickets", [tool("ticket_lookup", "Look up ticket")], {
    flagDetails: [{ name: "verbose", type: "boolean", default: false }],
    diagnostics: [{ type: "warning", message: "Slow to load", path: "/ext/tickets.ts" }],
    commands: ["ticket"],
    flags: ["verbose"],
  }),
  extension("disabled", [tool("ticket_lookup", "Off")], { enabled: false }),
]);

function snapshot(ref: SessionRef, overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    ref,
    workspace: { workspaceId: ref.workspaceId, path: "/repo/pi-gui", displayName: "pi-gui" },
    title: "Fix the timeline",
    status: "idle",
    updatedAt: at(0),
    ...overrides,
  };
}

function event(
  minute: number,
  ref: SessionRef,
  body: Record<string, unknown>,
  second = 0,
): ScenarioStep {
  return {
    op: "event",
    now: at(minute, second + 1),
    event: { sessionRef: ref, timestamp: at(minute, second), ...body } as SessionDriverEvent,
  };
}

const running = (minute: number, ref = main, runId = "run-1") =>
  event(minute, ref, {
    type: "sessionUpdated",
    runId,
    snapshot: snapshot(ref, { status: "running", runningRunId: runId, updatedAt: at(minute) }),
  });

const delta = (minute: number, text: string, ref = main, second = 0) =>
  event(minute, ref, { type: "assistantDelta", text }, second);

export const scenarios: readonly Scenario[] = [
  {
    name: "streaming-run",
    initialState: initialState(),
    runtimeByWorkspace: {},
    lastViewedAtBySession: { "ws-main:s-main": at(0) },
    steps: [
      { op: "userMessage", now: at(1), sessionRef: main, text: "Explain the timeline code" },
      running(1),
      // Same run again: no second "Working…" row.
      running(1),
      delta(2, "Let me "),
      delta(2, "look.", main, 5),
      event(2, main, { type: "assistantMessageEnded" }, 10),
      event(2, main, { type: "assistantMessagePersisted", sourceMessageId: "entry-a1" }, 11),
      event(3, main, {
        type: "toolStarted",
        toolName: "read",
        callId: "call-read",
        input: { path: "apps/desktop/electron/conversation/app-store-timeline.ts" },
      }),
      event(3, main, { type: "toolUpdated", callId: "call-read", progress: 0.456 }, 5),
      event(3, main, { type: "toolUpdated", callId: "call-read", progress: 3 }, 6),
      event(3, main, { type: "toolUpdated", callId: "call-read", text: "reading…" }, 7),
      event(
        3,
        main,
        {
          type: "toolFinished",
          callId: "call-read",
          success: true,
          output: {
            content: [
              { type: "text", text: "  export function applyTimelineEvent(\n\n  transcript" },
              { type: "text", text: "line two" },
            ],
          },
        },
        30,
      ),
      event(4, main, {
        type: "toolStarted",
        toolName: "web_search",
        callId: "call-search",
        input: "site:pi.dev timeline query",
      }),
      event(4, main, {
        type: "toolFinished",
        callId: "call-search",
        success: true,
        output: "Found 3 results\twith spaces",
      }),
      event(5, main, {
        type: "toolStarted",
        toolName: "grep",
        callId: "call-grep",
        input: { pattern: "applyTimelineEvent", glob: "**/*.ts" },
      }),
      event(5, main, {
        type: "toolFinished",
        callId: "call-grep",
        success: true,
        output: { matches: 3, files: ["a.ts", "b.ts"], ratio: 0.5, big: 1e21 },
      }),
      event(5, main, {
        type: "toolStarted",
        toolName: "bash",
        callId: "call-null",
        input: null,
      }),
      event(5, main, { type: "toolFinished", callId: "call-null", success: true, output: null }),
      delta(6, "The timeline folds events "),
      delta(6, "into rows."),
      event(6, main, { type: "assistantMessageEnded" }, 30),
      event(6, main, { type: "assistantMessagePersisted", sourceMessageId: "entry-a2" }, 31),
      // A repeated persisted event finds nothing pending.
      event(6, main, { type: "assistantMessagePersisted", sourceMessageId: "entry-dup" }, 32),
      event(7, main, {
        type: "runCompleted",
        runId: "run-1",
        snapshot: snapshot(main, {
          updatedAt: at(7),
          preview: "The timeline folds events into rows.",
          config: { provider: "anthropic", modelId: "claude-sonnet", thinkingLevel: "high" },
          usage: {
            context: { tokens: 12_345, contextWindow: 200_000, compactAtTokens: 180_000 },
            lastTurn: { input: 1000, output: 200, cacheRead: 800, cacheWrite: 0 },
            cache: { lifetimeSeconds: 300, expiresAt: at(12) },
            totals: { input: 5000, output: 900, cacheRead: 4000, cacheWrite: 1000, cost: 0.0425 },
            subscription: false,
            planLimits: {
              provider: "anthropic",
              limits: [{ windowMinutes: 300, usedPercent: 12.5, resetsAt: at(30) }],
              reportedAt: at(7),
            },
          },
        }),
      }),
      event(8, main, {
        type: "sessionUpdated",
        snapshot: snapshot(main, { updatedAt: at(8), status: "idle" }),
      }),
    ],
  },
  {
    name: "extension-tools",
    initialState: initialState(),
    runtimeByWorkspace: { [ws]: labelledRuntime },
    lastViewedAtBySession: {},
    steps: [
      running(1),
      event(2, main, {
        type: "toolStarted",
        toolName: "github_read",
        callId: "call-gh",
        input: { kind: "pr", number: 223, draft: false, nested: { a: 1 }, "2": "first" },
      }),
      event(2, main, {
        type: "toolFinished",
        callId: "call-gh",
        success: true,
        output: {
          content: [{ type: "image", data: "UE5H", mimeType: "image/png" }, { type: "image" }],
        },
      }),
      // bash replaces pi's own tool, so it keeps pi-gui's wording and counts as a file tool.
      event(3, main, {
        type: "toolStarted",
        toolName: "bash",
        callId: "call-bash",
        input: { command: "ls -la /tmp" },
      }),
      event(3, main, {
        type: "toolStarted",
        toolName: "shared_name",
        callId: "call-shared",
        input: {},
      }),
      event(3, main, {
        type: "toolStarted",
        toolName: "ticket_lookup",
        callId: "call-ticket",
        input: { url: "https://tickets.example/42" },
      }),
      event(4, main, {
        type: "toolStarted",
        toolName: "create_child_thread",
        callId: "call-child",
        input: { title: "Write the Rust twin" },
      }),
      event(4, main, { type: "toolStarted", toolName: "list_threads", callId: "call-list" }),
      event(4, main, {
        type: "toolStarted",
        toolName: "read_thread",
        callId: "call-read-thread",
        input: { threadId: "t-1" },
      }),
      event(4, main, {
        type: "toolStarted",
        toolName: "send_message_to_thread",
        callId: "call-send",
        input: { text: "Please add tests" },
      }),
      event(4, main, {
        type: "toolStarted",
        toolName: "Glob",
        callId: "call-glob",
        input: "src/**",
      }),
      event(4, main, {
        type: "toolStarted",
        toolName: "fetch",
        callId: "call-fetch",
        input: "notes.md",
      }),
      event(
        5,
        main,
        {
          type: "toolFinished",
          callId: "call-bash",
          success: false,
          output: { stderr: "ls: cannot open directory '/tmp/secret': Permission denied" },
        },
        10,
      ),
      event(6, main, {
        type: "runFailed",
        runId: "run-1",
        error: { message: "terminated", code: "ABORTED" },
      }),
    ],
  },
  {
    name: "failed-cancelled-and-plain-completion",
    initialState: initialState(),
    runtimeByWorkspace: {},
    lastViewedAtBySession: { "ws-main:s-main": at(0), "ws-main:s-other": at(30) },
    steps: [
      running(1),
      delta(1, "Working on it", main, 30),
      event(3, main, {
        type: "runFailed",
        error: { message: "Model overloaded", details: { retryAfter: 30 } },
      }),
      running(10, main, "run-2"),
      event(10, main, {
        type: "toolStarted",
        toolName: "edit",
        callId: "call-edit",
        input: { filePath: "src/a.ts" },
      }),
      event(10, main, {
        type: "toolFinished",
        callId: "call-edit",
        success: false,
        output: { content: [{ type: "text", text: "   " }], isError: true },
      }),
      event(11, main, { type: "sessionClosed", reason: "manual" }),
      event(12, main, {
        type: "runCompleted",
        snapshot: snapshot(main, { updatedAt: at(12) }),
      }),
      event(13, other, {
        type: "runCompleted",
        snapshot: snapshot(other, { title: "Renamed elsewhere", updatedAt: at(13) }),
      }),
      event(14, other, { type: "runFailed", error: { message: "Run failed" } }),
      event(14, other, {
        type: "extensionCompatibilityIssue",
        issue: {
          capability: "ui.custom",
          classification: "terminal-only",
          message: "Needs a terminal",
          extensionPath: "/ext/tui.ts",
        },
      }),
    ],
  },
  {
    name: "custom-messages-cards-and-pins",
    initialState: initialState(),
    runtimeByWorkspace: {},
    lastViewedAtBySession: {},
    steps: [
      delta(1, "First reply"),
      event(1, main, {
        type: "transcriptItemAppended",
        item: {
          kind: "custom",
          id: "entry-custom",
          createdAt: at(1),
          customType: "ci-status",
          text: "**Build** passed",
        },
      }),
      event(1, main, {
        type: "transcriptItemAppended",
        item: {
          kind: "custom",
          id: "entry-custom",
          createdAt: at(1),
          customType: "ci-status",
          text: "duplicate is ignored",
        },
      }),
      delta(2, "Checking CI."),
      event(2, main, {
        type: "transcriptItemAppended",
        item: {
          kind: "card",
          id: "card:ci",
          createdAt: at(2),
          card: {
            key: "ci",
            title: "CI running",
            subtitle: "3 jobs",
            tone: "neutral",
            rows: [{ label: "lint", value: "passed" }],
            actions: [
              { type: "openFile", label: "Open log", path: "ci.log", line: 12 },
              { type: "composer", label: "Ask", text: "Why did it fail?" },
              { type: "url", label: "Run", url: "https://ci.example/run/1" },
              { type: "command", label: "Rerun", command: "/ci rerun" },
              { type: "openThread", label: "Thread", sessionId: "s-other" },
            ],
          },
        },
      }),
      event(2, main, {
        type: "transcriptItemAppended",
        item: {
          kind: "custom",
          id: "entry-broken",
          createdAt: at(2),
          customType: "pi-gui.card",
          text: "This card was not shown: it needs a non-empty string `title`.",
        },
      }),
      delta(2, " Done.", main, 30),
      event(3, main, {
        type: "transcriptItemAppended",
        item: {
          kind: "card",
          id: "card:ci",
          createdAt: at(3),
          card: { key: "ci", title: "CI passed", tone: "success", rows: [], actions: [] },
        },
      }),
      event(3, main, {
        type: "transcriptItemAppended",
        item: {
          kind: "pin",
          id: "pin:todo",
          createdAt: at(3),
          card: { key: "todo", title: "Plan: 0 done", tone: "neutral", rows: [], actions: [] },
        },
      }),
      delta(4, "Step one."),
      event(4, main, {
        type: "transcriptItemAppended",
        item: {
          kind: "pin",
          id: "pin:ci",
          createdAt: at(4),
          card: { key: "ci", title: "CI", tone: "warning", rows: [], actions: [] },
        },
      }),
      event(4, main, {
        type: "transcriptItemAppended",
        item: {
          kind: "pin",
          id: "pin:todo",
          createdAt: at(4),
          card: { key: "todo", title: "Plan: 1 done", tone: "neutral", rows: [], actions: [] },
        },
      }),
      event(5, main, {
        type: "transcriptItemAppended",
        item: { kind: "pin", id: "pin:todo", createdAt: at(5), card: null },
      }),
      event(5, main, {
        type: "transcriptItemAppended",
        item: { kind: "pin", id: "pin:todo", createdAt: at(5), card: null },
      }),
      event(6, main, {
        type: "transcriptItemAppended",
        item: {
          kind: "pin",
          id: "pin:todo",
          createdAt: at(6),
          card: { key: "todo", title: "New plan", tone: "neutral", rows: [], actions: [] },
        },
      }),
      delta(6, "Working."),
      event(6, main, {
        type: "transcriptItemAppended",
        item: {
          kind: "custom",
          id: "pin-error:todo",
          createdAt: at(6),
          customType: "pi-gui.pin",
          text: "first",
        },
      }),
      event(6, main, {
        type: "transcriptItemAppended",
        item: {
          kind: "custom",
          id: "pin-error:todo",
          createdAt: at(6),
          customType: "pi-gui.pin",
          text: "second",
        },
      }),
    ],
  },
  {
    name: "reload-compaction-and-host-ui",
    initialState: initialState(),
    runtimeByWorkspace: { [ws]: labelledRuntime },
    lastViewedAtBySession: { "ws-main:s-main": at(5) },
    steps: [
      {
        op: "loadTranscript",
        now: at(1),
        sessionRef: main,
        items: [
          {
            kind: "message",
            role: "compactionSummary",
            text: "Earlier turns were compacted.",
            createdAt: at(0),
            id: "entry-compaction",
          },
          {
            kind: "message",
            role: "user",
            text: "Show me the screenshot",
            attachments: [
              { kind: "image", mimeType: "image/png", data: "UE5H", name: "shot.png" },
              {
                kind: "file",
                name: "notes.md",
                mimeType: "text/markdown",
                fsPath: "/n.md",
                sizeBytes: 42,
              },
            ],
            createdAt: at(0, 10),
            id: "entry-user",
          },
          {
            kind: "tool",
            id: "entry-tool",
            callId: "call-saved",
            toolName: "github_read",
            status: "success",
            input: { kind: "issue", number: 7 },
            output: { message: "Issue 7: crash on start" },
            createdAt: at(0, 20),
          },
          {
            kind: "tool",
            id: "entry-tool-2",
            callId: "call-saved-2",
            toolName: "read",
            status: "error",
            input: null,
            output: null,
            createdAt: at(0, 30),
          },
          {
            kind: "tool",
            id: "entry-tool-3",
            callId: "call-saved-3",
            toolName: "ls",
            status: "error",
            createdAt: at(0, 40),
          },
          {
            kind: "message",
            role: "branchSummary",
            text: "Branch summary",
            createdAt: at(0, 50),
            id: "entry-branch",
          },
          {
            kind: "message",
            role: "assistant",
            text: "Here it is.",
            createdAt: at(0, 55),
            id: "entry-assistant",
            sourceMessageId: "entry-assistant",
          },
          {
            kind: "pin",
            id: "pin:plan",
            createdAt: at(0, 56),
            card: { key: "plan", title: "Plan", tone: "neutral", rows: [], actions: [] },
          },
        ],
      },
      event(2, main, { type: "sessionOpened", snapshot: snapshot(main, { updatedAt: at(2) }) }),
      event(3, main, {
        type: "hostUiRequest",
        request: { kind: "notify", requestId: "n-1", message: "Saved", level: "info" },
      }),
      event(3, main, {
        type: "hostUiRequest",
        request: { kind: "notify", requestId: "n-2", message: "Lint crashed", level: "error" },
      }),
      event(3, main, {
        type: "hostUiRequest",
        request: { kind: "status", requestId: "st-1", key: "ci", text: "CI: running" },
      }),
      event(3, main, {
        type: "hostUiRequest",
        request: {
          kind: "widget",
          requestId: "w-1",
          key: "todo",
          lines: ["- [ ] one", "- [x] two"],
        },
      }),
      event(3, main, {
        type: "hostUiRequest",
        request: { kind: "title", requestId: "t-1", title: "Plan mode" },
      }),
      event(4, main, {
        type: "hostUiRequest",
        request: { kind: "editorText", requestId: "e-1", text: "/plan next" },
      }),
      event(4, main, {
        type: "hostUiRequest",
        request: { kind: "status", requestId: "st-2", key: "ci" },
      }),
      event(4, main, {
        type: "hostUiRequest",
        request: {
          kind: "widget",
          requestId: "w-2",
          key: "below",
          lines: ["below"],
          placement: "belowComposer",
        },
      }),
      event(4, main, {
        type: "hostUiRequest",
        request: {
          kind: "confirm",
          requestId: "c-1",
          title: "Delete?",
          message: "Really delete?",
          timeoutMs: 5000,
        },
      }),
      event(5, main, {
        type: "hostUiRequest",
        request: { kind: "widget", requestId: "w-3", key: "todo", lines: [] },
      }),
    ],
  },
  {
    name: "renames-queues-and-other-sessions",
    initialState: initialState(),
    runtimeByWorkspace: {},
    lastViewedAtBySession: { "ws-tree:s-fresh": at(0) },
    steps: [
      event(1, fresh, {
        type: "sessionUpdated",
        snapshot: snapshot(fresh, { title: "Port the state to Rust", updatedAt: at(1) }),
      }),
      // An older queued event still carries the placeholder title.
      event(1, fresh, {
        type: "sessionUpdated",
        snapshot: snapshot(fresh, { title: "New thread", updatedAt: at(1, 30) }),
      }),
      {
        op: "userMessage",
        now: at(2),
        sessionRef: fresh,
        text: "With an image",
        attachments: [
          { id: "att-1", kind: "image", name: "a.png", mimeType: "image/png", data: "UE5H" },
          {
            id: "att-2",
            kind: "file",
            name: "b.txt",
            mimeType: "text/plain",
            fsPath: "/b.txt",
            sizeBytes: 7,
          },
        ],
      },
      running(2, fresh, "run-9"),
      event(3, fresh, {
        type: "sessionUpdated",
        runId: "run-9",
        snapshot: snapshot(fresh, {
          status: "running",
          runningRunId: "run-9",
          updatedAt: at(3),
          queuedMessages: [
            {
              id: "queued-1",
              mode: "followUp",
              text: "And then the tests",
              createdAt: at(3),
              updatedAt: at(3),
            },
          ],
        }),
      }),
      event(4, fresh, {
        type: "queuedMessageStarted",
        message: {
          id: "queued-1",
          mode: "followUp",
          text: "And then the tests",
          attachments: [{ kind: "image", mimeType: "image/png", data: "UE5H" }],
          createdAt: at(3),
          updatedAt: at(3),
        },
      }),
      event(4, fresh, {
        type: "queuedMessageStarted",
        message: {
          id: "queued-1",
          mode: "steer",
          text: "And then the tests, edited",
          attachments: [],
          createdAt: at(3),
          updatedAt: at(4),
        },
      }),
      delta(5, "On it.", fresh),
      event(6, fresh, {
        type: "runCompleted",
        snapshot: snapshot(fresh, {
          title: "Port the state to Rust",
          updatedAt: at(6),
          archivedAt: at(6),
        }),
      }),
      event(7, other, {
        type: "sessionUpdated",
        snapshot: snapshot(other, { title: "Second thread", updatedAt: at(7), preview: "From pi" }),
      }),
      // An event for a session the state does not list changes nothing but the revision.
      event(
        8,
        { workspaceId: ws, sessionId: "s-unknown" },
        {
          type: "sessionUpdated",
          snapshot: snapshot({ workspaceId: ws, sessionId: "s-unknown" }, { updatedAt: at(8) }),
        },
      ),
    ],
  },
];

// ---- Inputs for single-function cases ----

export const catalogWorkspaces: WorkspaceCatalogEntry[] = [
  {
    workspaceId: ws,
    path: "/repo/pi-gui",
    displayName: "pi-gui",
    lastOpenedAt: at(0),
    sortOrder: 0,
  },
  {
    workspaceId: wsTree,
    path: "/repo/pi-gui-feature",
    displayName: "pi-gui feature",
    lastOpenedAt: at(1),
    sortOrder: 1,
    pinned: true,
  },
  {
    workspaceId: "ws-dup",
    path: "/repo/pi-gui-feature",
    displayName: "duplicate path",
    lastOpenedAt: at(2),
    sortOrder: 2,
  },
  {
    workspaceId: "ws-solo",
    path: "/repo/solo",
    displayName: "solo",
    lastOpenedAt: at(3),
    sortOrder: 3,
  },
];

export const catalogWorktrees: WorktreeCatalogEntry[] = [
  {
    worktreeId: "wt-primary",
    workspaceId: ws,
    path: "/repo/pi-gui",
    displayName: "pi-gui",
    kind: "primary",
    status: "ready",
    createdAt: at(0),
    updatedAt: at(0),
  },
  {
    worktreeId: "wt-feature",
    workspaceId: ws,
    path: "/repo/pi-gui-feature",
    displayName: "feature",
    kind: "linked",
    status: "ready",
    branchName: "feature",
    headSha: "abc123",
    createdAt: at(1),
    updatedAt: at(5),
  },
  {
    worktreeId: "wt-older-owner",
    workspaceId: "ws-solo",
    path: "/repo/pi-gui-feature",
    displayName: "feature again",
    kind: "linked",
    status: "missing",
    createdAt: at(1),
    updatedAt: at(9),
  },
  {
    worktreeId: "wt-b",
    workspaceId: ws,
    path: "/repo/wt-b",
    displayName: "Beta",
    kind: "linked",
    status: "error",
    createdAt: at(1),
    updatedAt: at(5),
  },
  {
    worktreeId: "wt-a",
    workspaceId: ws,
    path: "/repo/wt-a",
    displayName: "alpha",
    kind: "linked",
    status: "ready",
    createdAt: at(1),
    updatedAt: at(5),
  },
  {
    worktreeId: "wt-new",
    workspaceId: ws,
    path: "/repo/wt-new",
    displayName: "newest",
    kind: "linked",
    status: "ready",
    createdAt: at(1),
    updatedAt: at(8),
  },
];

export const catalogSessions: SessionCatalogEntry[] = [
  {
    sessionRef: main,
    workspaceId: ws,
    title: "Fix the timeline",
    updatedAt: at(2),
    status: "running",
    previewSnippet: "snippet",
  },
  {
    sessionRef: other,
    workspaceId: ws,
    title: "Other",
    updatedAt: at(2),
    archivedAt: at(3),
    status: "idle",
    sessionFilePath: "/sessions/other.jsonl",
  },
  { sessionRef: fresh, workspaceId: wsTree, title: "Fresh", updatedAt: at(1), status: "failed" },
  {
    sessionRef: { workspaceId: "ws-solo", sessionId: "s-solo" },
    workspaceId: "ws-solo",
    title: "Solo",
    updatedAt: at(1),
    status: "idle",
    previewSnippet: "solo snippet",
  },
];
