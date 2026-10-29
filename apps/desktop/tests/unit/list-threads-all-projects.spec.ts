import { expect, test } from "@playwright/test";
import type { SessionRecord, WorkspaceRecord } from "../../contracts/desktop-state";
import {
  MAX_ALL_PROJECT_THREADS,
  createOrchestrationOwner,
} from "../../electron/orchestration/app-store-orchestration";

function session(id: string, minute: number): SessionRecord {
  const at = new Date(Date.UTC(2026, 9, 27, 0, minute)).toISOString();
  return { id, title: id, status: "idle", updatedAt: at, preview: "" } as unknown as SessionRecord;
}

function workspace(id: string, sessions: readonly SessionRecord[]): WorkspaceRecord {
  return {
    id,
    name: id,
    path: `/projects/${id}`,
    lastOpenedAt: "2026-10-27T00:00:00.000Z",
    kind: "primary",
    sessions,
  } as unknown as WorkspaceRecord;
}

// The caller's own project, plus another project with more threads than the cap allows.
const callerRef = { workspaceId: "home", sessionId: "caller" };
const others = Array.from({ length: MAX_ALL_PROJECT_THREADS + 50 }, (_, index) =>
  session(`other-${index}`, index),
);
const workspaces = [workspace("home", [session("caller", 0)]), workspace("big", others)];

function owner() {
  const host = {
    orchestrationChildren: () => [],
    orchestrationState: () => ({ workspaces, orchestrationChildren: [] }),
    replaceOrchestrationChildren: () => undefined,
    sessionFromState: () => undefined,
    transcriptFor: () => [],
    transcriptForKey: () => [],
    isTranscriptLoaded: () => false,
  };
  return createOrchestrationOwner(
    host as unknown as Parameters<typeof createOrchestrationOwner>[0],
  );
}

test("listing every project keeps the caller's project and the most recent threads, and says it cut off", () => {
  const result = owner().listThreadsToolResult(callerRef, "*");
  const threads = result.details.threads ?? [];
  expect(threads).toHaveLength(MAX_ALL_PROJECT_THREADS);
  expect(threads[0]).toMatchObject({ threadId: "caller", relationship: "current" });
  // Newest first after the caller's own project; the oldest 51 others fall past the cap.
  expect(threads[1]?.threadId).toBe(`big:other-${others.length - 1}`);
  expect(threads.some((thread) => thread.threadId === "big:other-0")).toBe(false);
  expect(result.details.omittedThreadCount).toBe(51);
  const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  expect(text).toContain(`Showing ${MAX_ALL_PROJECT_THREADS} of ${others.length + 1} threads`);
  expect(text).toContain("pass workspace with a project name");
});

test("naming one project is not capped", () => {
  const result = owner().listThreadsToolResult(callerRef, "big");
  expect(result.details.threads).toHaveLength(others.length);
  expect(result.details.omittedThreadCount).toBeUndefined();
});
