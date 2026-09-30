import { useLayoutEffect, useState, type RefObject } from "react";
import { offsetsToRange } from "./text-offsets";

/**
 * The marker's span now. Streaming can re-render earlier markdown (a line becoming a table
 * or heading) and shift offsets, so this finds the selected text again nearest its old
 * place, and gives up rather than mark the wrong text.
 */
function locate(root: Element, marker: AnnotationMarker): Range | null {
  const range = offsetsToRange(root, marker.start, marker.end);
  if (range?.toString() === marker.anchorText) return range;
  const text = root.textContent ?? "";
  let best = -1;
  for (
    let at = text.indexOf(marker.anchorText);
    at >= 0;
    at = text.indexOf(marker.anchorText, at + 1)
  ) {
    if (best < 0 || Math.abs(at - marker.start) < Math.abs(best - marker.start)) best = at;
  }
  return best < 0 ? null : offsetsToRange(root, best, best + marker.anchorText.length);
}

function samePlacement(a: readonly PlacedMarker[], b: readonly PlacedMarker[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (marker, index) =>
        marker.id === b[index]?.id &&
        marker.number === b[index]?.number &&
        marker.top === b[index]?.top &&
        marker.left === b[index]?.left,
    )
  );
}

export interface AnnotationMarker {
  readonly id: string;
  readonly number: number;
  readonly start: number;
  readonly end: number;
  readonly anchorText: string;
}

export type OpenAnnotation = (id: string, anchor: DOMRect) => void;

/** Marks the element whose text annotation offsets count. One per message. */
export const ANNOTATION_ROOT_ATTRIBUTE = "data-annotation-root";

const HIGHLIGHT_NAME = "pi-annotation";
const rangesByMessage = new Map<string, readonly Range[]>();

// The CSS Custom Highlight API paints the annotated text without touching the markdown DOM,
// which React owns and thread search rewrites.
function publishHighlights() {
  if (typeof CSS === "undefined" || !CSS.highlights) return;
  const ranges = [...rangesByMessage.values()].flat();
  if (ranges.length === 0) CSS.highlights.delete(HIGHLIGHT_NAME);
  else CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(...ranges));
}

interface PlacedMarker extends AnnotationMarker {
  readonly top: number;
  readonly left: number;
}

/**
 * Numbered markers at the end of each annotated span of one message. Positions are
 * relative to the message article and follow its reflow and streaming text.
 */
export function AnnotationMarkers({
  messageId,
  articleRef,
  markers,
  onOpen,
}: {
  readonly messageId: string;
  readonly articleRef: RefObject<HTMLElement | null>;
  readonly markers: readonly AnnotationMarker[];
  readonly onOpen: OpenAnnotation;
}) {
  const [placed, setPlaced] = useState<readonly PlacedMarker[]>([]);

  useLayoutEffect(() => {
    const article = articleRef.current;
    const root = article?.querySelector(`[${ANNOTATION_ROOT_ATTRIBUTE}]`);
    if (!article || !root) return undefined;

    const place = () => {
      const base = article.getBoundingClientRect();
      const ranges: Range[] = [];
      const next: PlacedMarker[] = [];
      for (const marker of markers) {
        const range = locate(root, marker);
        const rects = range?.getClientRects();
        const last = rects?.[rects.length - 1];
        if (!range || !last) continue;
        ranges.push(range);
        next.push({ ...marker, top: last.top - base.top, left: last.right - base.left });
      }
      rangesByMessage.set(messageId, ranges);
      publishHighlights();
      setPlaced((current) => (samePlacement(current, next) ? current : next));
    };

    place();
    const resizeObserver = new ResizeObserver(place);
    resizeObserver.observe(article);
    const mutationObserver = new MutationObserver(place);
    mutationObserver.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      rangesByMessage.delete(messageId);
      publishHighlights();
    };
  }, [articleRef, markers, messageId]);

  return (
    <div className="annotation-markers">
      {placed.map((marker) => (
        <button
          aria-label={`Edit annotation ${marker.number}`}
          className="annotation-marker"
          data-annotation-id={marker.id}
          data-testid="annotation-marker"
          key={marker.id}
          style={{ top: marker.top, left: marker.left }}
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => onOpen(marker.id, event.currentTarget.getBoundingClientRect())}
        >
          {marker.number}
        </button>
      ))}
    </div>
  );
}
