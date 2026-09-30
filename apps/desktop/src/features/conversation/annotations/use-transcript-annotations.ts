import { useCallback, useMemo, useState } from "react";
import type { TranscriptAnnotation } from "./annotation-prompt";

export interface TranscriptAnnotations {
  /** The selected thread's annotations, in the order they were added (marker numbers). */
  readonly list: readonly TranscriptAnnotation[];
  readonly add: (input: Omit<TranscriptAnnotation, "id" | "note">) => string;
  readonly setNote: (id: string, note: string) => void;
  readonly remove: (id: string) => void;
  /** Clears the thread's annotations for a send; the returned undo puts them back. */
  readonly take: () => {
    readonly taken: readonly TranscriptAnnotation[];
    readonly undo: () => void;
  };
}

const NONE: readonly TranscriptAnnotation[] = [];
let nextAnnotationId = 0;
function newAnnotationId(): string {
  nextAnnotationId += 1;
  return `annotation-${nextAnnotationId}`;
}

/**
 * Annotations belong to a thread's composer, like its draft, so switching threads keeps
 * each thread's own. They live in renderer memory only and are gone after a restart.
 */
export function useTranscriptAnnotations(sessionKey: string): TranscriptAnnotations {
  const [bySession, setBySession] = useState<
    Readonly<Record<string, readonly TranscriptAnnotation[]>>
  >({});
  const list = bySession[sessionKey] ?? NONE;

  const update = useCallback(
    (
      key: string,
      change: (current: readonly TranscriptAnnotation[]) => readonly TranscriptAnnotation[],
    ) =>
      setBySession((current) => {
        const next = change(current[key] ?? NONE);
        if (next === current[key]) return current;
        const copy = { ...current };
        if (next.length > 0) copy[key] = next;
        else delete copy[key];
        return copy;
      }),
    [],
  );

  const add = useCallback(
    (input: Omit<TranscriptAnnotation, "id" | "note">) => {
      const id = newAnnotationId();
      update(sessionKey, (current) => [...current, { ...input, id, note: "" }]);
      return id;
    },
    [sessionKey, update],
  );
  const setNote = useCallback(
    (id: string, note: string) =>
      update(sessionKey, (current) =>
        current.map((annotation) => (annotation.id === id ? { ...annotation, note } : annotation)),
      ),
    [sessionKey, update],
  );
  const remove = useCallback(
    (id: string) =>
      update(sessionKey, (current) => current.filter((annotation) => annotation.id !== id)),
    [sessionKey, update],
  );
  const take = useCallback(() => {
    const taken = list;
    update(sessionKey, () => NONE);
    return {
      taken,
      undo: () => update(sessionKey, (current) => [...taken, ...current]),
    };
  }, [list, sessionKey, update]);

  return useMemo(() => ({ list, add, setNote, remove, take }), [list, add, setNote, remove, take]);
}
