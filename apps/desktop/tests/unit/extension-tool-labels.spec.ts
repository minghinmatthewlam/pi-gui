import { expect, test } from "@playwright/test";
import { sessionKey } from "@pi-gui/session-driver";
import type { RuntimeExtensionRecord, RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import type { TranscriptMessage } from "../../contracts/timeline-types";
import { extensionToolLabels, extensionToolRowLabel } from "../../contracts/tool-labels";
import {
  applyTimelineEvent,
  timelineFromDriverTranscript,
} from "../../electron/conversation/app-store-timeline";

const sessionRef = { workspaceId: "workspace", sessionId: "session" };
const key = sessionKey(sessionRef);
const timestamp = "2026-10-01T19:00:00.000Z";

function extension(source: string, tools: RuntimeExtensionRecord["tools"]): RuntimeExtensionRecord {
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
  };
}

function runtime(extensions: RuntimeExtensionRecord[]): RuntimeSnapshot {
  return { extensions } as unknown as RuntimeSnapshot;
}

test("a folder's extension tools are labelled, pi-gui's own and unlabelled tools are not", () => {
  const tool = (name: string, label: string, replacesPiTool = false) => ({
    name,
    label,
    replacesPiTool,
  });
  const labels = extensionToolLabels(
    runtime([
      extension("local", [
        tool("github_read", "Read GitHub issue or PR"),
        tool("blank", "  "),
        tool("bash", "bash (sandboxed)", true),
        tool("shared_name", "From local"),
      ]),
      extension("other", [tool("shared_name", "From other")]),
      extension("builtin", [tool("create_child_thread", "Child thread")]),
      extension("shadow", [tool("create_child_thread", "Shadowed")]),
    ]),
  );
  // Replacing pi's bash keeps pi-gui's handling; a name two extensions register is ambiguous.
  expect([...labels]).toEqual([["github_read", "Read GitHub issue or PR"]]);
  expect(extensionToolLabels(undefined).size).toBe(0);
});

test("an extension row shows its label and the call's main argument or plain values", () => {
  expect(extensionToolRowLabel("Fetch page", { url: "https://pi.dev" })).toBe(
    "Fetch page: https://pi.dev",
  );
  expect(extensionToolRowLabel("Read GitHub issue or PR", { kind: "pr", number: 223 })).toBe(
    "Read GitHub issue or PR: pr 223",
  );
  expect(extensionToolRowLabel("List todos", {})).toBe("List todos");
  expect(extensionToolRowLabel("List todos", { filter: { done: true } })).toBe("List todos");
});

test("a live extension tool call uses its label and counts as a tool, not a file", () => {
  const transcript = new Map<string, readonly TranscriptMessage[]>();
  const labels = new Map([["github_read", "Read GitHub issue or PR"]]);
  const state: Parameters<typeof applyTimelineEvent>[2] = {
    activeAssistantMessageBySession: new Map(),
    pendingAssistantMessageBySession: new Map(),
    activeWorkingActivityBySession: new Map(),
    extensionToolLabels: () => labels,
    runningSinceBySession: new Map(),
    runMetricsBySession: new Map(),
  };
  applyTimelineEvent(
    transcript,
    {
      type: "toolStarted",
      sessionRef,
      timestamp,
      toolName: "github_read",
      callId: "call-1",
      input: { kind: "issue", number: 7 },
    },
    state,
  );
  applyTimelineEvent(
    transcript,
    {
      type: "toolStarted",
      sessionRef,
      timestamp,
      toolName: "read",
      callId: "call-2",
      input: { path: "src/app.ts" },
    },
    state,
  );
  const rows = transcript.get(key)!.filter((item) => item.kind === "tool");
  expect(rows.map((row) => row.label)).toEqual([
    "Read GitHub issue or PR: issue 7",
    "Read src/app.ts",
  ]);
  expect(state.runMetricsBySession.get(key)).toMatchObject({
    toolCount: 2,
    fileCount: 1,
    searchCount: 0,
  });
});

test("a saved extension tool call reloads with its label", () => {
  const [row] = timelineFromDriverTranscript(
    [
      {
        kind: "tool",
        id: "call-1",
        callId: "call-1",
        toolName: "github_read",
        status: "success",
        input: { kind: "pr", number: 223 },
        createdAt: timestamp,
      },
    ],
    new Map([["github_read", "Read GitHub issue or PR"]]),
  );
  expect(row).toMatchObject({ kind: "tool", label: "Read GitHub issue or PR: pr 223" });
});
