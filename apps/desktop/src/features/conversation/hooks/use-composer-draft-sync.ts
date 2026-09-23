import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import type { SessionRef } from "@pi-gui/session-driver/types";
import type { ComposerDraftSyncSource, DesktopAppState } from "../../../../contracts/desktop-state";
import type { PiDesktopApi } from "../../../../contracts/ipc";

/** Persist/state/command restore saved or submitted text. They must not overwrite a newer local edit. */
export function shouldAdoptComposerSnapshot(
  source: ComposerDraftSyncSource | undefined,
  localEditPending: boolean,
): boolean {
  if (!localEditPending) {
    return true;
  }
  return source !== "persist" && source !== "state" && source !== "command";
}

interface UseComposerDraftSyncParams {
  readonly api: PiDesktopApi | undefined;
  readonly snapshot: DesktopAppState | null;
  /** The task whose draft the composer shows. */
  readonly selectedSession: SessionRef | null;
}

interface PendingComposerDraftWrite {
  readonly draft: string;
  readonly generation: number;
  readonly sessionKey: string;
  readonly target: SessionRef;
}

/**
 * Owns the session composer draft: local state mirrored into a ref, hydration from the
 * persisted snapshot (respecting the sync nonce/source), a debounced write-back, and a
 * flush so a pending write lands before the active session changes.
 */
export function useComposerDraftSync(params: UseComposerDraftSyncParams) {
  const { api, snapshot, selectedSession } = params;
  const selectedSessionKey = selectedSession
    ? `${selectedSession.workspaceId}:${selectedSession.sessionId}`
    : "";
  const [composerDraft, setComposerDraftState] = useState("");
  const composerDraftRef = useRef("");
  const hydratedComposerSessionKeyRef = useRef("");
  const handledComposerSyncNonceRef = useRef(0);
  const localEditGenerationRef = useRef(0);
  const acknowledgedLocalEditGenerationRef = useRef(0);
  const inFlightComposerDraftWritesRef = useRef(
    new Map<PendingComposerDraftWrite, Promise<void>>(),
  );
  const pendingComposerDraftRef = useRef<PendingComposerDraftWrite | null>(null);
  const composerDraftWriteTimerRef = useRef<number | null>(null);
  const flushComposerDraftRef = useRef<() => void>(() => {});
  const currentSessionKeyRef = useRef(selectedSessionKey);
  currentSessionKeyRef.current = selectedSessionKey;

  composerDraftRef.current = composerDraft;
  const persistedComposerDraft = snapshot?.composerDraft ?? "";
  const setComposerDraft = useCallback((nextDraft: SetStateAction<string>) => {
    const currentDraft = composerDraftRef.current;
    const resolvedDraft = typeof nextDraft === "function" ? nextDraft(currentDraft) : nextDraft;
    if (resolvedDraft === currentDraft) {
      return;
    }
    composerDraftRef.current = resolvedDraft;
    localEditGenerationRef.current += 1;
    setComposerDraftState(resolvedDraft);
  }, []);

  useEffect(() => {
    if (!snapshot) {
      return;
    }

    if (hydratedComposerSessionKeyRef.current !== selectedSessionKey) {
      hydratedComposerSessionKeyRef.current = selectedSessionKey;
      handledComposerSyncNonceRef.current = snapshot.composerDraftSyncNonce;
      acknowledgedLocalEditGenerationRef.current = localEditGenerationRef.current;
      pendingComposerDraftRef.current = null;
      composerDraftRef.current = snapshot.composerDraft;
      setComposerDraftState(snapshot.composerDraft);
      return;
    }

    if (snapshot.composerDraftSyncNonce === handledComposerSyncNonceRef.current) {
      return;
    }

    handledComposerSyncNonceRef.current = snapshot.composerDraftSyncNonce;
    const localEditPending =
      localEditGenerationRef.current > acknowledgedLocalEditGenerationRef.current;
    if (!shouldAdoptComposerSnapshot(snapshot.composerDraftSyncSource, localEditPending)) {
      return;
    }

    acknowledgedLocalEditGenerationRef.current = localEditGenerationRef.current;
    pendingComposerDraftRef.current = null;
    composerDraftRef.current = snapshot.composerDraft;
    setComposerDraftState(snapshot.composerDraft);
  }, [
    selectedSessionKey,
    snapshot?.composerDraft,
    snapshot?.composerDraftSyncNonce,
    snapshot?.composerDraftSyncSource,
  ]);

  const persistComposerDraft = (write: PendingComposerDraftWrite) => {
    if (!api) {
      return;
    }
    const completion = api.updateComposerDraft(write.draft, write.target).then(
      (state) => {
        inFlightComposerDraftWritesRef.current.delete(write);
        const hasOtherWriteForSession = [...inFlightComposerDraftWritesRef.current.keys()].some(
          (candidate) => candidate.sessionKey === write.sessionKey,
        );
        if (
          write.sessionKey === currentSessionKeyRef.current &&
          write.generation === localEditGenerationRef.current &&
          state.composerDraft === write.draft &&
          !hasOtherWriteForSession
        ) {
          acknowledgedLocalEditGenerationRef.current = write.generation;
        }
      },
      () => {
        inFlightComposerDraftWritesRef.current.delete(write);
      },
    );
    inFlightComposerDraftWritesRef.current.set(write, completion);
  };

  useEffect(() => {
    const generation = localEditGenerationRef.current;
    if (generation <= acknowledgedLocalEditGenerationRef.current) {
      pendingComposerDraftRef.current = null;
      return undefined;
    }
    if (!api || !selectedSession) {
      return undefined;
    }

    const inFlightWritesForSession = [...inFlightComposerDraftWritesRef.current.keys()].filter(
      (write) => write.sessionKey === selectedSessionKey,
    );
    if (composerDraft === persistedComposerDraft && inFlightWritesForSession.length === 0) {
      acknowledgedLocalEditGenerationRef.current = generation;
      pendingComposerDraftRef.current = null;
      return undefined;
    }
    if (
      inFlightWritesForSession.some(
        (write) => write.generation === generation && write.draft === composerDraft,
      )
    ) {
      pendingComposerDraftRef.current = null;
      return undefined;
    }

    const pendingWrite = {
      draft: composerDraft,
      generation,
      sessionKey: selectedSessionKey,
      target: selectedSession,
    } satisfies PendingComposerDraftWrite;
    pendingComposerDraftRef.current = pendingWrite;
    const timeout = window.setTimeout(() => {
      composerDraftWriteTimerRef.current = null;
      if (pendingComposerDraftRef.current === pendingWrite) {
        pendingComposerDraftRef.current = null;
      }
      persistComposerDraft(pendingWrite);
    }, 350);
    composerDraftWriteTimerRef.current = timeout;

    // Only the timer is cancelled here (each keystroke reschedules it); the pending value stays in
    // pendingComposerDraftRef so a session switch can flush it before the active session changes.
    return () => {
      window.clearTimeout(timeout);
      composerDraftWriteTimerRef.current = null;
    };
  }, [api, composerDraft, persistedComposerDraft, selectedSession, selectedSessionKey]);

  useEffect(() => () => flushComposerDraftRef.current(), []);

  const flushComposerDraft = () => {
    if (composerDraftWriteTimerRef.current !== null) {
      window.clearTimeout(composerDraftWriteTimerRef.current);
      composerDraftWriteTimerRef.current = null;
    }
    const pending = pendingComposerDraftRef.current;
    pendingComposerDraftRef.current = null;
    if (pending !== null) {
      persistComposerDraft(pending);
    }
  };
  flushComposerDraftRef.current = flushComposerDraft;

  const flushComposerDraftAsync = useCallback(
    async (target: SessionRef): Promise<void> => {
      if (!api) throw new Error("The desktop connection is unavailable.");
      const sessionKey = `${target.workspaceId}:${target.sessionId}`;
      const requireCurrentSession = () => {
        if (
          currentSessionKeyRef.current !== sessionKey ||
          hydratedComposerSessionKeyRef.current !== sessionKey
        )
          throw new Error("The task changed before its draft could be saved.");
      };
      const cancelPendingWrite = () => {
        if (composerDraftWriteTimerRef.current !== null) {
          window.clearTimeout(composerDraftWriteTimerRef.current);
          composerDraftWriteTimerRef.current = null;
        }
        pendingComposerDraftRef.current = null;
      };
      // A task-creating host action must not overtake an older debounced write or lose an
      // edit made while saving. Every explicit write stays bound to the original task.
      for (;;) {
        requireCurrentSession();
        cancelPendingWrite();
        // Keep the latest edit flushable if ordinary task navigation happens while an
        // older write is still completing. Its existing pre-navigation flush owns that case.
        pendingComposerDraftRef.current = {
          draft: composerDraftRef.current,
          generation: localEditGenerationRef.current,
          sessionKey,
          target,
        };
        const earlierWrites = [...inFlightComposerDraftWritesRef.current.entries()]
          .filter(([write]) => write.sessionKey === sessionKey)
          .map(([, completion]) => completion);
        await Promise.allSettled(earlierWrites);
        requireCurrentSession();
        cancelPendingWrite();
        const generation = localEditGenerationRef.current;
        const draft = composerDraftRef.current;
        const pendingWrite = { draft, generation, sessionKey, target };
        pendingComposerDraftRef.current = pendingWrite;
        const completion = api.persistComposerDraft({ target, draft });
        inFlightComposerDraftWritesRef.current.set(pendingWrite, completion);
        try {
          await completion;
        } finally {
          inFlightComposerDraftWritesRef.current.delete(pendingWrite);
        }
        requireCurrentSession();
        if (
          generation === localEditGenerationRef.current &&
          draft === composerDraftRef.current &&
          ![...inFlightComposerDraftWritesRef.current.keys()].some(
            (write) => write.sessionKey === sessionKey,
          )
        ) {
          cancelPendingWrite();
          acknowledgedLocalEditGenerationRef.current = generation;
          return;
        }
      }
    },
    [api],
  );

  return {
    composerDraft,
    setComposerDraft,
    composerDraftRef,
    flushComposerDraft,
    flushComposerDraftAsync,
  };
}
