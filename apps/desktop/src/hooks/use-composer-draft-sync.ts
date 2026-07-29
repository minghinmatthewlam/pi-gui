import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import type { DesktopAppState } from "../desktop-state";
import type { PiDesktopApi } from "../ipc";

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

    console.log(`[DraftSync] Snapshot updated. Nonce: ${snapshot.composerDraftSyncNonce}, Source: ${snapshot.composerDraftSyncSource}, Local Draft: '${composerDraftRef.current}', Snapshot Draft: '${snapshot.composerDraft}'`);
    
    if (hydratedComposerSessionKeyRef.current !== selectedSessionKey) {
      console.log(`[DraftSync] Session key changed to ${selectedSessionKey}, applying snapshot draft.`);
      hydratedComposerSessionKeyRef.current = selectedSessionKey;
      handledComposerSyncNonceRef.current = snapshot.composerDraftSyncNonce;
      acknowledgedLocalEditGenerationRef.current = localEditGenerationRef.current;
      pendingComposerDraftRef.current = null;
      composerDraftRef.current = snapshot.composerDraft;
      setComposerDraftState(snapshot.composerDraft);
      return;
    }

    if (snapshot.composerDraftSyncNonce === handledComposerSyncNonceRef.current) {
      console.log(`[DraftSync] Nonce unchanged (${handledComposerSyncNonceRef.current}), skipping.`);
      return;
    }

    console.log(`[DraftSync] Nonce changed from ${handledComposerSyncNonceRef.current} to ${snapshot.composerDraftSyncNonce}.`);
    handledComposerSyncNonceRef.current = snapshot.composerDraftSyncNonce;
    
    // Perlindungan utama: Jangan biarkan 'command' mengosongkan teks lokal jika kita punya teks.
    // Ini memperbaiki bug di mana ganti model / thinking level akan menghapus prompt.
    if (
      snapshot.composerDraftSyncSource === "command" &&
      snapshot.composerDraft === "" &&
      composerDraftRef.current !== ""
    ) {
      console.log(`[DraftSync] Ignoring empty snapshot draft from 'command' to preserve local text.`);
      return;
    }

    if (
      localEditGenerationRef.current > acknowledgedLocalEditGenerationRef.current &&
      (snapshot.composerDraftSyncSource === "persist" || snapshot.composerDraftSyncSource === "state")
    ) {
      console.log(`[DraftSync] Local edit exists and source is ${snapshot.composerDraftSyncSource}, ignoring snapshot draft.`);
      return;
    }

    console.log(`[DraftSync] Overwriting local draft with snapshot draft.`);
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

  const persistComposerDraft = async (write: PendingComposerDraftWrite) => {
    if (!api) {
      return;
    }
    inFlightComposerDraftWritesRef.current.add(write);
    try {
      const state = await api.updateComposerDraft(write.draft);
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
    } catch {
      inFlightComposerDraftWritesRef.current.delete(write);
    }
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
    if (
      composerDraft === persistedComposerDraft &&
      inFlightWritesForSession.length === 0
    ) {
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

  const flushComposerDraft = async () => {
    if (composerDraftWriteTimerRef.current !== null) {
      window.clearTimeout(composerDraftWriteTimerRef.current);
      composerDraftWriteTimerRef.current = null;
    }
    const pending = pendingComposerDraftRef.current;
    pendingComposerDraftRef.current = null;
    if (pending !== null) {
      await persistComposerDraft(pending);
    }
  };
  flushComposerDraftRef.current = () => {
    void flushComposerDraft();
  };

  return { composerDraft, setComposerDraft, composerDraftRef, flushComposerDraft };
}
