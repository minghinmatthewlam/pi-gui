import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { DesktopAppState, SelectedTranscriptRecord } from "../../contracts/desktop-state";
import type { PiDesktopApi } from "../../contracts/ipc";

export type HydrationOperation = "state" | "selected-transcript";

export type StateHydrationFailure =
  { readonly code: "bridge-unavailable" } | { readonly code: "state-request-failed" };

export type TranscriptHydrationFailure = {
  readonly code: "selected-transcript-request-failed";
};

export type DesktopHydrationFailure = StateHydrationFailure | TranscriptHydrationFailure;

export type TranscriptHydrationView =
  | { readonly kind: "loading" }
  | {
      readonly kind: "failed";
      readonly failure: TranscriptHydrationFailure;
      readonly retrying: boolean;
    }
  | {
      readonly kind: "ready";
      readonly record: SelectedTranscriptRecord | null;
    };

export type DesktopAppView =
  | { readonly kind: "loading" }
  | {
      readonly kind: "failed";
      readonly failure: StateHydrationFailure;
      readonly retrying: boolean;
    }
  | {
      readonly kind: "ready";
      readonly snapshot: DesktopAppState;
      readonly transcript: TranscriptHydrationView;
    };

export type HydrationTarget = "state" | "selected-transcript";

export interface DesktopHydrationModel {
  readonly nextAttemptId: number;
  readonly bridgeMissing: boolean;
  readonly liveSnapshot: DesktopAppState | null;
  readonly stateInFlightId: number | null;
  readonly stateFailed: boolean;
  readonly transcriptInFlightId: number | null;
  readonly transcriptFailed: boolean;
  readonly transcriptSettled: boolean;
  readonly transcriptRecord: SelectedTranscriptRecord | null;
  readonly receivedPushedTranscript: boolean;
}

export type DesktopHydrationEvent =
  | { readonly type: "bridge-missing" }
  | { readonly type: "bridge-present" }
  | { readonly type: "state-pull-started"; readonly attemptId: number }
  | {
      readonly type: "state-pull-succeeded";
      readonly attemptId: number;
      readonly state: DesktopAppState;
    }
  | { readonly type: "state-pull-failed"; readonly attemptId: number }
  | { readonly type: "state-pushed"; readonly state: DesktopAppState }
  | { readonly type: "state-patched"; readonly snapshot: DesktopAppState | null }
  | { readonly type: "transcript-pull-started"; readonly attemptId: number }
  | {
      readonly type: "transcript-pull-succeeded";
      readonly attemptId: number;
      readonly record: SelectedTranscriptRecord | null;
    }
  | { readonly type: "transcript-pull-failed"; readonly attemptId: number }
  | { readonly type: "transcript-pushed"; readonly record: SelectedTranscriptRecord | null };

export interface DesktopAppSession {
  readonly view: DesktopAppView;
  readonly snapshot: DesktopAppState | null;
  readonly selectedTranscript: SelectedTranscriptRecord | null;
  readonly setSnapshot: Dispatch<SetStateAction<DesktopAppState | null>>;
  readonly retry: () => void;
  readonly relaunch: () => void;
  readonly canRelaunch: boolean;
}

/**
 * Classify by failed capability only. The cause is accepted so callers can log it,
 * but it is never copied into the returned value.
 */
export function classifyHydrationFailure(
  operation: "state",
  cause: unknown,
): Extract<DesktopHydrationFailure, { readonly code: "state-request-failed" }>;
export function classifyHydrationFailure(
  operation: "selected-transcript",
  cause: unknown,
): TranscriptHydrationFailure;
export function classifyHydrationFailure(
  operation: HydrationOperation,
  cause: unknown,
): DesktopHydrationFailure {
  void cause;
  if (operation === "state") {
    return { code: "state-request-failed" };
  }
  return { code: "selected-transcript-request-failed" };
}

export function initialDesktopHydrationModel(): DesktopHydrationModel {
  return {
    nextAttemptId: 1,
    bridgeMissing: false,
    liveSnapshot: null,
    stateInFlightId: null,
    stateFailed: false,
    transcriptInFlightId: null,
    transcriptFailed: false,
    transcriptSettled: false,
    transcriptRecord: null,
    receivedPushedTranscript: false,
  };
}

function mergeLiveSnapshot(
  current: DesktopAppState | null,
  incoming: DesktopAppState,
): DesktopAppState {
  return current && incoming.revision < current.revision ? current : incoming;
}

export function reduceDesktopHydration(
  current: DesktopHydrationModel,
  event: DesktopHydrationEvent,
): DesktopHydrationModel {
  switch (event.type) {
    case "bridge-missing":
      return { ...current, bridgeMissing: true };
    case "bridge-present":
      return { ...current, bridgeMissing: false };
    case "state-pull-started":
      return {
        ...current,
        nextAttemptId: current.nextAttemptId + 1,
        stateInFlightId: event.attemptId,
      };
    case "state-pull-succeeded":
      if (current.stateInFlightId !== event.attemptId) {
        return current;
      }
      return {
        ...current,
        stateInFlightId: null,
        stateFailed: false,
        liveSnapshot: mergeLiveSnapshot(current.liveSnapshot, event.state),
      };
    case "state-pull-failed":
      if (current.stateInFlightId !== event.attemptId) {
        return current;
      }
      return {
        ...current,
        stateInFlightId: null,
        stateFailed: current.liveSnapshot === null,
      };
    case "state-pushed":
      return {
        ...current,
        liveSnapshot: mergeLiveSnapshot(current.liveSnapshot, event.state),
        stateFailed: false,
      };
    case "state-patched":
      return { ...current, liveSnapshot: event.snapshot };
    case "transcript-pull-started":
      return {
        ...current,
        nextAttemptId: current.nextAttemptId + 1,
        transcriptInFlightId: event.attemptId,
      };
    case "transcript-pull-succeeded":
      if (current.transcriptInFlightId !== event.attemptId) {
        return current;
      }
      if (current.receivedPushedTranscript) {
        return {
          ...current,
          transcriptInFlightId: null,
          transcriptFailed: false,
          transcriptSettled: true,
        };
      }
      return {
        ...current,
        transcriptInFlightId: null,
        transcriptFailed: false,
        transcriptSettled: true,
        transcriptRecord: event.record,
      };
    case "transcript-pull-failed":
      if (current.transcriptInFlightId !== event.attemptId) {
        return current;
      }
      return {
        ...current,
        transcriptInFlightId: null,
        transcriptFailed: true,
        transcriptSettled: true,
      };
    case "transcript-pushed":
      return {
        ...current,
        receivedPushedTranscript: true,
        transcriptFailed: false,
        transcriptSettled: true,
        transcriptRecord: event.record,
      };
  }
}

function deriveTranscriptView(model: DesktopHydrationModel): TranscriptHydrationView {
  if (model.transcriptFailed) {
    return {
      kind: "failed",
      failure: { code: "selected-transcript-request-failed" },
      retrying: model.transcriptInFlightId !== null,
    };
  }
  if (model.transcriptSettled || model.receivedPushedTranscript) {
    return { kind: "ready", record: model.transcriptRecord };
  }
  return { kind: "loading" };
}

export function deriveDesktopAppView(model: DesktopHydrationModel): DesktopAppView {
  if (model.bridgeMissing && model.liveSnapshot === null) {
    return {
      kind: "failed",
      failure: { code: "bridge-unavailable" },
      retrying: false,
    };
  }
  if (model.liveSnapshot) {
    return {
      kind: "ready",
      snapshot: model.liveSnapshot,
      transcript: deriveTranscriptView(model),
    };
  }
  if (model.stateFailed) {
    return {
      kind: "failed",
      failure: { code: "state-request-failed" },
      retrying: model.stateInFlightId !== null,
    };
  }
  return { kind: "loading" };
}

export function retryableHydrationTargets(
  model: DesktopHydrationModel,
): readonly HydrationTarget[] {
  if (model.bridgeMissing) {
    return [];
  }
  const targets: HydrationTarget[] = [];
  if (model.liveSnapshot === null && model.stateInFlightId === null) {
    targets.push("state");
  }
  if (model.transcriptInFlightId === null && (model.transcriptFailed || !model.transcriptSettled)) {
    targets.push("selected-transcript");
  }
  return targets;
}

function createInitialHydrationModel(): DesktopHydrationModel {
  const initial = initialDesktopHydrationModel();
  if (typeof window === "undefined" || window.piApp) {
    return initial;
  }
  return reduceDesktopHydration(initial, { type: "bridge-missing" });
}

export function useDesktopAppState(): DesktopAppSession {
  const [model, setModel] = useState<DesktopHydrationModel>(createInitialHydrationModel);
  const modelRef = useRef(model);

  const apply = useCallback((event: DesktopHydrationEvent) => {
    const next = reduceDesktopHydration(modelRef.current, event);
    modelRef.current = next;
    setModel(next);
  }, []);

  const pullState = useCallback(
    (api: PiDesktopApi) => {
      const attemptId = modelRef.current.nextAttemptId;
      apply({ type: "state-pull-started", attemptId });
      void api.getState().then(
        (state) => {
          apply({ type: "state-pull-succeeded", attemptId, state });
        },
        (error: unknown) => {
          console.error(
            "[renderer] getState failed",
            classifyHydrationFailure("state", error),
            error,
          );
          apply({ type: "state-pull-failed", attemptId });
        },
      );
    },
    [apply],
  );

  const pullTranscript = useCallback(
    (api: PiDesktopApi) => {
      const attemptId = modelRef.current.nextAttemptId;
      apply({ type: "transcript-pull-started", attemptId });
      void api.getSelectedTranscript().then(
        (record) => {
          apply({ type: "transcript-pull-succeeded", attemptId, record });
        },
        (error: unknown) => {
          console.error(
            "[renderer] getSelectedTranscript failed",
            classifyHydrationFailure("selected-transcript", error),
            error,
          );
          apply({ type: "transcript-pull-failed", attemptId });
        },
      );
    },
    [apply],
  );

  useEffect(() => {
    let active = true;
    const api = window.piApp;
    if (!api) {
      apply({ type: "bridge-missing" });
      return undefined;
    }

    apply({ type: "bridge-present" });

    const unsubscribeState = api.onStateChanged((state) => {
      if (active) {
        apply({ type: "state-pushed", state });
      }
    });
    const unsubscribeTranscript = api.onSelectedTranscriptChanged((record) => {
      if (active) {
        apply({ type: "transcript-pushed", record });
      }
    });

    pullState(api);
    pullTranscript(api);

    return () => {
      active = false;
      unsubscribeState();
      unsubscribeTranscript();
    };
  }, [apply, pullState, pullTranscript]);

  const setSnapshot = useCallback<Dispatch<SetStateAction<DesktopAppState | null>>>((update) => {
    const from = modelRef.current.liveSnapshot;
    const next = typeof update === "function" ? update(from) : update;
    if (next === from) {
      return;
    }
    const reduced = reduceDesktopHydration(modelRef.current, {
      type: "state-patched",
      snapshot: next,
    });
    modelRef.current = reduced;
    setModel(reduced);
  }, []);

  const retry = useCallback(() => {
    const api = window.piApp;
    if (!api) {
      apply({ type: "bridge-missing" });
      return;
    }
    apply({ type: "bridge-present" });
    const targets = retryableHydrationTargets(modelRef.current);
    if (targets.includes("state")) {
      pullState(api);
    }
    if (targets.includes("selected-transcript")) {
      pullTranscript(api);
    }
  }, [apply, pullState, pullTranscript]);

  const relaunch = useCallback(() => {
    const api = window.piApp;
    if (!api) {
      return;
    }
    void api.relaunchApplication();
  }, []);

  return {
    view: deriveDesktopAppView(model),
    snapshot: model.liveSnapshot,
    selectedTranscript: model.transcriptRecord,
    setSnapshot,
    retry,
    relaunch,
    canRelaunch: Boolean(typeof window !== "undefined" && window.piApp) && !model.bridgeMissing,
  };
}

/**
 * Never let a state snapshot with a lower revision overwrite a newer one. IPC
 * responses race the pushed state-changed events: a response is built when the
 * handler returns, but concurrent session events can bump the state (and get
 * pushed) before the response crosses the IPC boundary. Applying the stale
 * response unguarded would silently roll the UI back — e.g. a /name rename
 * right after an aborted run lost its title this way.
 */
export function applySnapshotIfNewer(
  setSnapshot: Dispatch<SetStateAction<DesktopAppState | null>>,
  incoming: DesktopAppState,
): void {
  setSnapshot((current) => (current && incoming.revision < current.revision ? current : incoming));
}

export function updateSnapshot(
  setSnapshot: Dispatch<SetStateAction<DesktopAppState | null>>,
  action: () => Promise<DesktopAppState>,
) {
  return action()
    .then((state) => {
      applySnapshotIfNewer(setSnapshot, state);
      return state;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      setSnapshot((current) => (current ? { ...current, lastError: message } : current));
      // Keep the rejection so callers do not run success-only actions such as clearing drafts.
      throw error;
    });
}
