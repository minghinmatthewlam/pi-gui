import { expect, test } from "@playwright/test";
import type { Dispatch, SetStateAction } from "react";
import {
  classifyHydrationFailure,
  deriveDesktopAppView,
  initialDesktopHydrationModel,
  reduceDesktopHydration,
  retryableHydrationTargets,
  updateSnapshot,
  type DesktopHydrationModel,
} from "../../src/app/desktop-app-state";
import {
  createEmptyDesktopAppState,
  type DesktopAppState,
  type SelectedTranscriptRecord,
} from "../../contracts/desktop-state";

const SENTINEL = "secret-token=/private/path";

function stateHarness(initial: DesktopAppState) {
  let state: DesktopAppState | null = initial;
  const setState: Dispatch<SetStateAction<DesktopAppState | null>> = (update) => {
    state = typeof update === "function" ? update(state) : update;
  };
  return { setState, read: () => state };
}

function snapshot(revision: number, extra: Partial<DesktopAppState> = {}): DesktopAppState {
  return { ...createEmptyDesktopAppState(), revision, ...extra };
}

function reduceAll(
  events: Parameters<typeof reduceDesktopHydration>[1][],
  start: DesktopHydrationModel = initialDesktopHydrationModel(),
): DesktopHydrationModel {
  return events.reduce((current, event) => reduceDesktopHydration(current, event), start);
}

test("failed snapshot actions preserve the draft and reject before success handlers run", async () => {
  const initial = { ...createEmptyDesktopAppState(), revision: 7, composerDraft: "unsent draft" };
  const state = stateHarness(initial);
  const failure = new Error("Session unavailable");
  let ranSuccessHandler = false;
  const action = updateSnapshot(state.setState, () => Promise.reject(failure)).then(() => {
    ranSuccessHandler = true;
  });

  await expect(action).rejects.toBe(failure);
  expect(ranSuccessHandler).toBe(false);
  expect(state.read()).toEqual({ ...initial, lastError: "Session unavailable" });
});

test("successful actions apply fresh snapshots without replacing newer pushed state", async () => {
  const initial = { ...createEmptyDesktopAppState(), revision: 7, composerDraft: "initial" };
  const state = stateHarness(initial);
  const fresh = { ...initial, revision: 8, composerDraft: "saved" };
  await expect(updateSnapshot(state.setState, () => Promise.resolve(fresh))).resolves.toBe(fresh);
  expect(state.read()).toBe(fresh);

  const pushed = { ...fresh, revision: 10, composerDraft: "newer pushed draft" };
  state.setState(pushed);
  const stale = { ...fresh, revision: 9, composerDraft: "stale response" };
  await updateSnapshot(state.setState, () => Promise.resolve(stale));
  expect(state.read()).toBe(pushed);
});

test("classifyHydrationFailure keeps only the capability code", () => {
  const stateFailure = classifyHydrationFailure("state", new Error(SENTINEL));
  const transcriptFailure = classifyHydrationFailure("selected-transcript", new Error(SENTINEL));

  expect(stateFailure).toEqual({ code: "state-request-failed" });
  expect(transcriptFailure).toEqual({ code: "selected-transcript-request-failed" });
  expect(JSON.stringify(stateFailure)).not.toContain("secret");
  expect(JSON.stringify(transcriptFailure)).not.toContain("secret");
  expect(JSON.stringify(stateFailure)).not.toContain("/private/path");
});

test("a successful state pull is ready even when the transcript pull fails", () => {
  const diagnostics = [{ scope: "workspace" as const, message: "workspace missing" }];
  const state = snapshot(4, { startupDiagnostics: diagnostics });
  const model = reduceAll([
    { type: "state-pull-started", attemptId: 1 },
    { type: "transcript-pull-started", attemptId: 2 },
    { type: "transcript-pull-failed", attemptId: 2 },
    { type: "state-pull-succeeded", attemptId: 1, state },
  ]);
  const view = deriveDesktopAppView(model);

  expect(view).toEqual({
    kind: "ready",
    snapshot: state,
    transcript: {
      kind: "failed",
      failure: { code: "selected-transcript-request-failed" },
      retrying: false,
    },
  });
  expect(view.kind === "ready" ? view.snapshot.startupDiagnostics : null).toBe(diagnostics);
});

test("a failed state pull does not block a later ready shell after the transcript already settled", () => {
  const record: SelectedTranscriptRecord = {
    workspaceId: "ws",
    sessionId: "s",
    transcript: [],
  };
  const recovered = snapshot(2);
  let model = reduceAll([
    { type: "state-pull-started", attemptId: 1 },
    { type: "transcript-pull-started", attemptId: 2 },
    { type: "state-pull-failed", attemptId: 1 },
    { type: "transcript-pull-succeeded", attemptId: 2, record },
  ]);

  expect(deriveDesktopAppView(model)).toEqual({
    kind: "failed",
    failure: { code: "state-request-failed" },
    retrying: false,
  });
  expect(model.transcriptRecord).toBe(record);

  model = reduceAll(
    [
      { type: "state-pull-started", attemptId: 3 },
      { type: "state-pull-succeeded", attemptId: 3, state: recovered },
    ],
    model,
  );
  const view = deriveDesktopAppView(model);
  expect(view.kind).toBe("ready");
  if (view.kind === "ready") {
    expect(view.snapshot).toBe(recovered);
    expect(view.transcript).toEqual({ kind: "ready", record });
  }
});

test("retryableHydrationTargets skip in-flight lanes and a missing bridge", () => {
  const inFlight = reduceAll([
    { type: "state-pull-started", attemptId: 1 },
    { type: "transcript-pull-started", attemptId: 2 },
  ]);
  expect(retryableHydrationTargets(inFlight)).toEqual([]);

  const failedState = reduceDesktopHydration(inFlight, {
    type: "state-pull-failed",
    attemptId: 1,
  });
  expect(retryableHydrationTargets(failedState)).toEqual(["state"]);

  const bothFailed = reduceDesktopHydration(failedState, {
    type: "transcript-pull-failed",
    attemptId: 2,
  });
  expect(retryableHydrationTargets(bothFailed).slice().sort()).toEqual([
    "selected-transcript",
    "state",
  ]);

  const bridgeless = reduceDesktopHydration(bothFailed, { type: "bridge-missing" });
  expect(retryableHydrationTargets(bridgeless)).toEqual([]);
  expect(deriveDesktopAppView(bridgeless)).toEqual({
    kind: "failed",
    failure: { code: "bridge-unavailable" },
    retrying: false,
  });
});

test("stale pull attempts and older revisions do not replace live state", () => {
  const first = snapshot(3);
  const pushed = snapshot(5, { composerDraft: "from push" });
  const stale = snapshot(4, { composerDraft: "stale pull" });
  const model = reduceAll([
    { type: "state-pull-started", attemptId: 1 },
    { type: "state-pull-started", attemptId: 2 },
    { type: "state-pull-succeeded", attemptId: 1, state: first },
    { type: "state-pushed", state: pushed },
    { type: "state-pull-succeeded", attemptId: 2, state: stale },
  ]);

  expect(model.stateInFlightId).toBeNull();
  expect(model.liveSnapshot).toBe(pushed);
  expect(deriveDesktopAppView(model).kind).toBe("ready");
});

test("a transcript push after pull start wins over the later pull result", () => {
  const pushed: SelectedTranscriptRecord = {
    workspaceId: "ws",
    sessionId: "live",
    transcript: [],
  };
  const pulled: SelectedTranscriptRecord = {
    workspaceId: "ws",
    sessionId: "stale",
    transcript: [],
  };
  const model = reduceAll([
    { type: "transcript-pull-started", attemptId: 1 },
    { type: "transcript-pushed", record: pushed },
    { type: "transcript-pull-succeeded", attemptId: 1, record: pulled },
  ]);

  expect(model.transcriptRecord).toBe(pushed);
  expect(deriveDesktopAppView(model)).toMatchObject({
    kind: "loading",
  });
  const ready = reduceDesktopHydration(model, {
    type: "state-pushed",
    state: snapshot(1),
  });
  expect(deriveDesktopAppView(ready)).toEqual({
    kind: "ready",
    snapshot: snapshot(1),
    transcript: { kind: "ready", record: pushed },
  });
});

test("a failed state pull does not clear a snapshot that a push already provided", () => {
  const live = snapshot(8, { composerDraft: "keep me" });
  const model = reduceAll([
    { type: "state-pushed", state: live },
    { type: "state-pull-started", attemptId: 1 },
    { type: "state-pull-failed", attemptId: 1 },
  ]);

  expect(model.stateFailed).toBe(false);
  expect(deriveDesktopAppView(model)).toEqual({
    kind: "ready",
    snapshot: live,
    transcript: { kind: "loading" },
  });
  expect(retryableHydrationTargets(model)).toEqual(["selected-transcript"]);
});
