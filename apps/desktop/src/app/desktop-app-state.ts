import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { DesktopAppState, SelectedTranscriptRecord } from "../../contracts/desktop-state";

export function useDesktopAppState() {
  const [snapshot, setSnapshot] = useState<DesktopAppState | null>(null);
  const [selectedTranscript, setSelectedTranscript] = useState<SelectedTranscriptRecord | null>(
    null,
  );

  useEffect(() => {
    let active = true;
    let receivedPushedTranscript = false;
    const api = window.piApp;
    if (!api) {
      return undefined;
    }

    // The initial getState() can resolve after an early pushed state-changed event; never let a
    // snapshot with a lower revision overwrite a newer one already applied to state.
    const applyState = (incoming: DesktopAppState) => {
      applySnapshotIfNewer(setSnapshot, incoming);
    };

    void Promise.all([api.getState(), api.getSelectedTranscript()])
      .then(([state, transcript]) => {
        if (!active) {
          return;
        }
        applyState(state);
        // SelectedTranscriptRecord carries no revision marker, so the stale initial transcript is
        // only applied when no pushed transcript has arrived yet.
        if (!receivedPushedTranscript) {
          setSelectedTranscript(transcript);
        }
      })
      .catch((error: unknown) => {
        console.error("[renderer] getState failed", error);
      });

    const unsubscribeState = api.onStateChanged((state) => {
      if (active) {
        applyState(state);
      }
    });
    const unsubscribeTranscript = api.onSelectedTranscriptChanged((payload) => {
      if (active) {
        receivedPushedTranscript = true;
        setSelectedTranscript(payload);
      }
    });

    return () => {
      active = false;
      unsubscribeState();
      unsubscribeTranscript();
    };
  }, []);

  return [snapshot, setSnapshot, selectedTranscript] as const;
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
