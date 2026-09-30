import { useCallback, useEffect, useRef, useState } from "react";
import { CloseIcon } from "../../../ui/icons";
import { ANNOTATION_ROOT_ATTRIBUTE, type OpenAnnotation } from "./annotation-markers";
import { rangeToOffsets } from "./text-offsets";
import type { TranscriptAnnotations } from "./use-transcript-annotations";

interface TranscriptSelection {
  readonly messageIds: readonly string[];
  readonly start: number;
  readonly end: number;
  readonly anchorText: string;
  readonly quote: string;
  readonly rect: DOMRect;
}

function isSameSelection(a: TranscriptSelection | null, b: TranscriptSelection | null): boolean {
  return (
    a === b ||
    (a !== null &&
      b !== null &&
      a.messageIds[0] === b.messageIds[0] &&
      a.start === b.start &&
      a.end === b.end &&
      a.rect.top === b.rect.top &&
      a.rect.left === b.rect.left)
  );
}

interface OpenEditor {
  readonly id: string;
  readonly anchor: DOMRect;
}

export function addToChatShortcutKeys(platform: NodeJS.Platform): readonly string[] {
  return platform === "darwin" ? ["⌘", "L"] : ["Ctrl", "L"];
}

function isAddToChatShortcut(event: KeyboardEvent, platform: NodeJS.Platform): boolean {
  const modifier = platform === "darwin" ? event.metaKey && !event.ctrlKey : event.ctrlKey;
  return (
    modifier &&
    !event.altKey &&
    !event.shiftKey &&
    (event.key.toLowerCase() === "l" || event.code === "KeyL")
  );
}

function elementOf(node: Node): Element | null {
  return node instanceof Element ? node : node.parentElement;
}

/** A non-empty selection that starts in one message's text in this timeline pane. */
function readTranscriptSelection(pane: HTMLElement): TranscriptSelection | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  let range = selection.getRangeAt(0);
  const root = elementOf(range.startContainer)?.closest(`[${ANNOTATION_ROOT_ATTRIBUTE}]`);
  const row = root?.closest<HTMLElement>("[data-message-id]");
  const messageId = row?.dataset.messageId;
  if (!root || !messageId || !pane.contains(root)) return null;
  // A triple-click on a message's last paragraph ends just past its text, selecting nothing
  // more; keep the part inside. A drag on into another row is not one selection.
  const clamped = !root.contains(range.endContainer);
  if (clamped) {
    const beyond = range.cloneRange();
    beyond.setStart(root, root.childNodes.length);
    if (beyond.toString().trim()) return null;
    range = range.cloneRange();
    range.setEnd(root, root.childNodes.length);
  }
  const quote = (clamped ? range.toString() : selection.toString()).trim();
  if (!quote) return null;
  const { start, end } = rangeToOffsets(root, range);
  const sourceMessageId = row.dataset.sourceMessageId;
  return {
    messageIds:
      sourceMessageId && sourceMessageId !== messageId ? [messageId, sourceMessageId] : [messageId],
    start,
    end,
    anchorText: range.toString(),
    quote,
    rect: range.getBoundingClientRect(),
  };
}

function isTextEntry(element: Element | null): boolean {
  return (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    (element instanceof HTMLElement && element.isContentEditable)
  );
}

const POPOVER_GAP = 8;

function popoverTop(anchor: DOMRect, height: number): number {
  const above = anchor.top - height - POPOVER_GAP;
  return above >= POPOVER_GAP ? above : anchor.bottom + POPOVER_GAP;
}

/**
 * The "Add to Chat" button over a transcript selection, and the comment box that opens
 * when an annotation is added or its marker is clicked.
 */
export function useAnnotationSelection({
  paneRef,
  annotations,
  platform,
}: {
  readonly paneRef: { readonly current: HTMLElement | null };
  readonly annotations: TranscriptAnnotations | undefined;
  readonly platform: NodeJS.Platform;
}) {
  const [selection, setSelection] = useState<TranscriptSelection | null>(null);
  const [editor, setEditor] = useState<OpenEditor | null>(null);
  const pointerDownRef = useRef(false);

  const snapEditorToMarker = useCallback(
    () =>
      setEditor((current) => {
        const marker = current
          ? paneRef.current?.querySelector(`[data-annotation-id="${current.id}"]`)
          : null;
        if (!current || !marker) return current;
        const anchor = marker.getBoundingClientRect();
        return anchor.top === current.anchor.top && anchor.left === current.anchor.left
          ? current
          : { ...current, anchor };
      }),
    [paneRef],
  );

  useEffect(() => {
    if (!annotations) return undefined;
    const refresh = () => {
      const pane = paneRef.current;
      const next = pane && !pointerDownRef.current ? readTranscriptSelection(pane) : null;
      setSelection((current) => (isSameSelection(current, next) ? current : next));
    };
    // The button and comment box follow the transcript while it scrolls or streams.
    const followMarker = (event: Event) => {
      if (!(event.target instanceof Node) || !paneRef.current?.contains(event.target)) return;
      refresh();
      snapEditorToMarker();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest(".annotation-popover")) return;
      pointerDownRef.current = true;
      setSelection(null);
    };
    const onPointerUp = () => {
      pointerDownRef.current = false;
      // The selection settles after pointerup.
      requestAnimationFrame(refresh);
    };
    document.addEventListener("selectionchange", refresh);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointerup", onPointerUp, true);
    document.addEventListener("scroll", followMarker, true);
    return () => {
      document.removeEventListener("selectionchange", refresh);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("pointerup", onPointerUp, true);
      document.removeEventListener("scroll", followMarker, true);
    };
  }, [annotations, paneRef, snapEditorToMarker]);

  const addSelection = useCallback(() => {
    if (!annotations || !selection) return;
    const id = annotations.add({
      messageIds: selection.messageIds,
      start: selection.start,
      end: selection.end,
      anchorText: selection.anchorText,
      quote: selection.quote,
    });
    window.getSelection()?.removeAllRanges();
    setSelection(null);
    setEditor({ id, anchor: selection.rect });
  }, [annotations, selection]);

  useEffect(() => {
    if (!selection) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isAddToChatShortcut(event, platform) || event.repeat || event.defaultPrevented) return;
      // Typing elsewhere (composer, terminal, search) keeps its own Ctrl+L.
      const active = document.activeElement;
      if (isTextEntry(active) && !active?.closest(".annotation-popover")) return;
      if (active?.closest("[data-pi-terminal]")) return;
      event.preventDefault();
      addSelection();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [addSelection, platform, selection]);

  // A new annotation's marker is placed a frame after the add; the box then sits above it.
  const editorId = editor?.id;
  useEffect(() => {
    if (!editorId) return undefined;
    const frame = requestAnimationFrame(snapEditorToMarker);
    return () => cancelAnimationFrame(frame);
  }, [editorId, snapEditorToMarker]);

  const openAnnotation: OpenAnnotation = useCallback((id, anchor) => {
    setSelection(null);
    setEditor({ id, anchor });
  }, []);

  const editing = editor ? annotations?.list.find((entry) => entry.id === editor.id) : undefined;
  const editorOrphaned = editor !== null && !editing;
  useEffect(() => {
    if (editorOrphaned) setEditor(null);
  }, [editorOrphaned]);
  const layer = (
    <>
      {selection && !editor ? (
        <AddToChatButton anchor={selection.rect} platform={platform} onAdd={addSelection} />
      ) : null}
      {editor && editing && annotations ? (
        <AnnotationEditor
          anchor={editor.anchor}
          key={editor.id}
          note={editing.note}
          onClose={() => setEditor(null)}
          onRemove={() => {
            annotations.remove(editor.id);
            setEditor(null);
          }}
          onSave={(note) => annotations.setNote(editor.id, note)}
        />
      ) : null}
    </>
  );
  return { layer, openAnnotation };
}

function AddToChatButton({
  anchor,
  platform,
  onAdd,
}: {
  readonly anchor: DOMRect;
  readonly platform: NodeJS.Platform;
  readonly onAdd: () => void;
}) {
  return (
    <div
      className="annotation-popover annotation-add"
      style={{ top: popoverTop(anchor, 32), left: Math.max(POPOVER_GAP, anchor.left) }}
    >
      <button
        className="annotation-add__button"
        data-testid="add-to-chat"
        type="button"
        // Keep the transcript selection alive through the click.
        onMouseDown={(event) => event.preventDefault()}
        onClick={onAdd}
      >
        <span>Add to Chat</span>
        <span className="annotation-add__keys" aria-hidden="true">
          {addToChatShortcutKeys(platform).map((key) => (
            <kbd key={key}>{key}</kbd>
          ))}
        </span>
      </button>
    </div>
  );
}

function AnnotationEditor({
  anchor,
  note,
  onSave,
  onRemove,
  onClose,
}: {
  readonly anchor: DOMRect;
  readonly note: string;
  readonly onSave: (note: string) => void;
  readonly onRemove: () => void;
  readonly onClose: () => void;
}) {
  const [value, setValue] = useState(note);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const closingRef = useRef(false);
  const pendingSaveRef = useRef(() => onSave(value.trim()));
  pendingSaveRef.current = () => onSave(value.trim());

  useEffect(() => {
    inputRef.current?.focus();
    // Opening another marker replaces this box without a blur; keep what was typed.
    return () => {
      if (!closingRef.current) pendingSaveRef.current();
    };
  }, []);

  const finish = (save: boolean) => {
    if (closingRef.current) return;
    closingRef.current = true;
    if (save) onSave(value.trim());
    onClose();
  };

  return (
    <div
      className="annotation-popover annotation-editor"
      data-testid="annotation-editor"
      style={{ top: popoverTop(anchor, 44), left: Math.max(POPOVER_GAP, anchor.left - 24) }}
    >
      <input
        aria-label="Annotation comment"
        className="annotation-editor__input"
        placeholder="Add an optional comment…"
        ref={inputRef}
        value={value}
        onBlur={() => finish(true)}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            finish(true);
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            finish(false);
          }
        }}
      />
      <button
        aria-label="Remove annotation"
        className="annotation-editor__remove"
        data-testid="annotation-remove"
        title="Remove annotation"
        type="button"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          closingRef.current = true;
          onRemove();
        }}
      >
        <CloseIcon />
      </button>
    </div>
  );
}
