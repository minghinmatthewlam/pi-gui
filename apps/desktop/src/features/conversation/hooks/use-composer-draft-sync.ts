import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
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
  readonly selectedSessionKey: string;
}

interface PendingComposerDraftWrite {
  readonly draft: string;
  readonly generation: number;
  readonly sessionKey: string;
}

/**
 * Owns the session composer draft: local state mirrored into a ref, hydration from the
 * persisted snapshot (respecting the sync nonce/source), a debounced write-back, and a
 * flush so a pending write lands before the active session changes.
 */
export function useComposerDraftSync(params: UseComposerDraftSyncParams) {
  const { api, snapshot, selectedSessionKey } = params;
  const [composerDraft, setComposerDraftState] = useState("");
  const composerDraftRef = useRef("");
  const hydratedComposerSessionKeyRef = useRef("");
  const handledComposerSyncNonceRef = useRef(0);
  const localEditGenerationRef = useRef(0);
  const acknowledgedLocalEditGenerationRef = useRef(0);
  const inFlightComposerDraftWritesRef = useRef(new Set<PendingComposerDraftWrite>());
  const pendingComposerDraftRef = useRef<PendingComposerDraftWrite | null>(null);
  const composerDraftWriteTimerRef = useRef<number | null>(null);
  const flushComposerDraftRef = useRef<() => void>(() => {});

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
    inFlightComposerDraftWritesRef.current.add(write);
    void api.updateComposerDraft(write.draft).then(
      (state) => {
        inFlightComposerDraftWritesRef.current.delete(write);
        const hasOtherWriteForSession = [...inFlightComposerDraftWritesRef.current.values()].some(
          (candidate) => candidate.sessionKey === write.sessionKey,
        );
        if (
          write.sessionKey === selectedSessionKey &&
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
  };

  useEffect(() => {
    const generation = localEditGenerationRef.current;
    if (generation <= acknowledgedLocalEditGenerationRef.current) {
      pendingComposerDraftRef.current = null;
      return undefined;
    }
    if (!api) {
      return undefined;
    }

    const inFlightWritesForSession = [...inFlightComposerDraftWritesRef.current.values()].filter(
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
  }, [api, composerDraft, persistedComposerDraft, selectedSessionKey]);

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

  return { composerDraft, setComposerDraft, composerDraftRef, flushComposerDraft };
}
