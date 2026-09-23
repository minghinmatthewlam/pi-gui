import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import { flushSync } from "react-dom";
import type { DisplayTimelineItem } from "../../../../contracts/timeline-types";
import {
  anchorAt,
  compensateAnchorShift,
  type RowEstimate,
  layoutRows,
  recoverAnchor,
  resolveAnchor,
  totalRowHeight,
  visibleRows,
  type TimelinePosition,
  type TimelineRow,
} from "../timeline-layout";

type ScrollState =
  TimelinePosition | { readonly kind: "restoring"; readonly destination: TimelinePosition };
interface Options {
  readonly sessionKey: string;
  readonly active: boolean;
  readonly transcriptReady: boolean;
  readonly rows: readonly DisplayTimelineItem[];
  readonly paneRef: MutableRefObject<HTMLDivElement | null>;
}

/**
 * Rows are placed from estimates and move once measured, on a later frame. The pane's
 * data-layout says whether that has finished, so tests can wait before clicking inside
 * the transcript: a press and release that straddle a move never reach the row.
 */
function markLayout(pane: HTMLDivElement | null, layout: "settling" | "settled"): void {
  if (pane && pane.dataset.layout !== layout) pane.dataset.layout = layout;
}

/** The only writer of timeline scroll position. Size changes never select a new intent. */
export function useTimelineViewport({
  sessionKey,
  active,
  transcriptReady,
  rows,
  paneRef,
}: Options) {
  const saved = useRef(new Map<string, TimelinePosition>());
  const model = useRef({
    key: "",
    state: { kind: "following" } as ScrollState,
    heights: new Map<string, number>(),
    estimates: new Map<string, RowEstimate>(),
    geometryRevision: 0,
    layout: [] as readonly TimelineRow[],
    width: 0,
    height: 0,
    scrollExtent: 0,
    committedHeight: 0,
    generation: 0,
    frame: 0,
    userIntent: 0,
    activityMarker: "",
    newActivity: false,
    expectedScrollTop: null as number | null,
    pendingNavigation: true,
  });
  const [, setVersion] = useState(0);
  const [pane, setPane] = useState<HTMLDivElement | null>(null);
  const [searchMode, setSearchMode] = useState(false);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const destination = (state: ScrollState): TimelinePosition =>
    state.kind === "restoring" ? state.destination : state;

  // Identity, not the changing session snapshot, defines the lifetime of measurements.
  if (model.current.key !== sessionKey) {
    const previous = model.current;
    if (previous.key) saved.current.set(previous.key, destination(previous.state));
    if (previous.frame) cancelAnimationFrame(previous.frame);
    model.current = {
      ...previous,
      key: sessionKey,
      state: {
        kind: "restoring",
        destination: saved.current.get(sessionKey) ?? { kind: "following" },
      },
      heights: new Map(),
      estimates: new Map(),
      layout: [],
      generation: previous.generation + 1,
      frame: 0,
      userIntent: 0,
      activityMarker: "",
      newActivity: false,
      expectedScrollTop: null,
      pendingNavigation: true,
    };
  }

  const schedule = useCallback(() => {
    const current = model.current;
    markLayout(paneRef.current, "settling");
    if (current.frame) return;
    const generation = current.generation;
    current.frame = requestAnimationFrame(() => {
      current.frame = 0;
      if (model.current !== current || current.generation !== generation) return;
      setVersion((value) => value + 1);
    });
  }, [paneRef]);
  const attachPane = useCallback(
    (node: HTMLDivElement | null) => {
      if (node && node !== paneRef.current) model.current.pendingNavigation = true;
      paneRef.current = node;
      setPane(node);
    },
    [paneRef],
  );
  const savePosition = useCallback(() => {
    const current = model.current;
    if (current.key) saved.current.set(current.key, destination(current.state));
  }, []);
  const measureRow = useCallback(
    (id: string, height: number, generation: number) => {
      const current = model.current;
      if (generation !== current.generation) return;
      const next = Math.max(1, Math.ceil(height));
      if (current.heights.get(id) === next) return;
      current.heights.set(id, next);
      current.geometryRevision += 1;
      schedule();
    },
    [schedule],
  );

  const layout = useMemo(() => {
    const current = model.current;
    const items = new Map(rows.map((row) => [row.id, row]));
    for (const id of current.estimates.keys()) {
      if (!items.has(id)) {
        current.estimates.delete(id);
        current.heights.delete(id);
      }
      // Last measured size remains a provisional estimate until the mounted
      // row reports its new size. Never shrink a reading row to a text estimate
      // for one frame on each token.
    }
    return layoutRows(rows, current.heights, current.width, current.estimates);
  }, [rows, model.current.geometryRevision, sessionKey]);
  const layoutRevision = model.current.geometryRevision;
  const totalHeight = totalRowHeight(layout);
  const current = model.current;
  let position = destination(current.state);
  if (position.kind === "reading" && transcriptReady) {
    const anchor = recoverAnchor(layout, current.layout, position.anchor);
    if (anchor) position = { kind: "reading", anchor };
  }
  const target =
    position.kind === "following"
      ? Math.max(0, totalHeight - current.height)
      : (resolveAnchor(layout, position.anchor) ?? 0);
  const placements = searchMode ? layout : visibleRows(layout, target, current.height || 800);
  const placedFromEstimates = placements.some((row) => !current.heights.has(row.item.id));

  useLayoutEffect(() => {
    if (!pane || !active) return;
    const observer = new ResizeObserver(() => {
      const current = model.current;
      const width = Math.min(
        pane.clientWidth,
        pane.querySelector<HTMLElement>(".timeline")?.clientWidth ?? pane.clientWidth,
      );
      current.height = pane.clientHeight;
      if (width === current.width) {
        schedule();
        return;
      }
      current.width = width;
      current.heights.clear();
      current.estimates.clear();
      // Mounted rows have already reflowed at the new width. Keep their real heights and
      // place them before this frame paints, so no row shows at an old or estimated top.
      for (const row of pane.querySelectorAll<HTMLElement>("[data-message-id]")) {
        const id = row.dataset.messageId;
        if (id) current.heights.set(id, Math.max(1, Math.ceil(row.getBoundingClientRect().height)));
      }
      current.geometryRevision += 1;
      current.generation += 1;
      if (current.frame) cancelAnimationFrame(current.frame);
      current.frame = 0;
      flushSync(() => setVersion((value) => value + 1));
    });
    observer.observe(pane);
    return () => observer.disconnect();
  }, [pane, active, schedule]);

  useLayoutEffect(() => {
    const current = model.current;
    if (!pane) return;
    if (!active || !transcriptReady) {
      markLayout(pane, "settling");
      return;
    }
    const restoring = current.state.kind === "restoring";
    const before = destination(current.state);
    const previousAnchorTop =
      before.kind === "reading" ? resolveAnchor(current.layout, before.anchor) : null;
    if (before.kind === "reading") {
      const anchor = recoverAnchor(layout, current.layout, before.anchor);
      if (anchor) current.state = { kind: "reading", anchor };
    }
    current.layout = layout;
    const ids = new Set(rows.map((row) => row.id));
    for (const id of current.heights.keys()) if (!ids.has(id)) current.heights.delete(id);
    // The list's extent is committed now. Tail rows remain mounted while their
    // estimates converge, so no full-history render is needed to find the bottom.
    const geometryChanged =
      current.scrollExtent !== pane.scrollHeight || current.committedHeight !== pane.clientHeight;
    current.scrollExtent = pane.scrollHeight;
    current.committedHeight = pane.clientHeight;
    const maximum = Math.max(0, current.scrollExtent - pane.clientHeight);
    let desired =
      destination(current.state).kind === "following" ? maximum : Math.min(maximum, target);
    // A render is not a request to scroll. Native wheel motion can already
    // be visible before its queued scroll event updates our saved anchor.
    const anchorMoved = previousAnchorTop !== null && Math.abs(target - previousAnchorTop) > 0.5;
    const align =
      current.pendingNavigation ||
      restoring ||
      (before.kind === "following" ? geometryChanged : anchorMoved);
    const compensateReading =
      align &&
      !current.pendingNavigation &&
      !restoring &&
      before.kind === "reading" &&
      previousAnchorTop !== null;
    if (compensateReading) {
      desired = compensateAnchorShift(pane.scrollTop, previousAnchorTop, target, maximum);
    }
    current.pendingNavigation = false;
    if (align && Math.abs(pane.scrollTop - desired) > 0.5) {
      current.expectedScrollTop = desired;
      pane.scrollTop = desired;
    } else if (geometryChanged && (pane.scrollTop <= 0 || pane.scrollTop >= maximum - 1)) {
      // A smaller extent may clamp without an explicit write. That event
      // must not turn a reader into a follower.
      current.expectedScrollTop = pane.scrollTop;
    }
    if (compensateReading) {
      const anchor = anchorAt(layout, pane.scrollTop);
      if (anchor) current.state = { kind: "reading", anchor };
      if (Math.abs(pane.scrollTop - target) > 0.5) schedule();
    }
    const measured = placements.every((row) => current.heights.has(row.item.id));
    if (measured) {
      current.state = destination(current.state);
    }
    // Rows placed from estimates measured themselves in this commit. Render again before
    // paint instead of on the next frame, or they visibly jump once. Rows that were already
    // measured (a streaming reply growing) keep the frame-coalesced path.
    if (placedFromEstimates && current.geometryRevision !== layoutRevision && current.frame) {
      cancelAnimationFrame(current.frame);
      current.frame = 0;
      setVersion((value) => value + 1);
    }
    markLayout(pane, measured && !current.frame ? "settled" : "settling");
    if (current.key) saved.current.set(current.key, destination(current.state));
    const last = rows.at(-1);
    const marker = `${rows.length}:${last?.id ?? ""}:${last?.kind === "message" ? last.text.length : last?.kind === "tool" ? last.status : ""}`;
    if (destination(current.state).kind === "following") current.newActivity = false;
    else if (current.activityMarker && marker !== current.activityMarker)
      current.newActivity = true;
    current.activityMarker = marker;
    setShowJumpToLatest(current.newActivity);
  }, [
    active,
    transcriptReady,
    pane,
    layout,
    layoutRevision,
    placedFromEstimates,
    rows,
    target,
    placements,
    schedule,
  ]);

  useLayoutEffect(() => {
    if (!pane || !active) return;
    let draggingScrollbar = false;
    const read = () => {
      const current = model.current;
      if (
        current.expectedScrollTop !== null &&
        Math.abs(pane.scrollTop - current.expectedScrollTop) < 1
      ) {
        // Several delayed events can describe the same owned position. Keep
        // this marker until explicit input or an unmatched native scroll.
        return;
      }
      // Browser clamping after a layout update is not user intent.
      // Native scrollbar drags may not dispatch DOM pointer events. An
      // unmatched scroll with unchanged geometry is user navigation; a layout
      // clamp is not. Compare dimensions from the same committed layout, not
      // the newer ResizeObserver measurement. Our own writes are matched above.
      if (
        !draggingScrollbar &&
        performance.now() > current.userIntent &&
        (pane.scrollHeight !== current.scrollExtent ||
          pane.clientHeight !== current.committedHeight)
      )
        return;
      const anchor = anchorAt(current.layout, pane.scrollTop);
      const previous = destination(current.state);
      const previousTop =
        previous.kind === "reading" ? resolveAnchor(current.layout, previous.anchor) : null;
      // Small upward trackpad deltas must escape the bottom. Resume following
      // only on reaching the actual bottom without moving upward.
      if (
        pane.scrollHeight - pane.scrollTop - pane.clientHeight <= 1 &&
        (previousTop === null || pane.scrollTop >= previousTop)
      )
        current.state = { kind: "following" };
      else if (anchor) current.state = { kind: "reading", anchor };
      current.expectedScrollTop = null;
      savePosition();
      schedule();
    };
    const intent = (leaveBottom: boolean) => {
      const current = model.current;
      current.userIntent = performance.now() + 1000;
      current.pendingNavigation = false;
      current.expectedScrollTop = null;
      const anchor = anchorAt(current.layout, pane.scrollTop);
      if (anchor && leaveBottom) current.state = { kind: "reading", anchor };
    };
    const wheel = (event: WheelEvent) => {
      if (event.deltaY !== 0) intent(event.deltaY < 0);
    };
    const key = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)
        return;
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key))
        intent(
          ["ArrowUp", "PageUp", "Home"].includes(event.key) ||
            (event.key === " " && event.shiftKey),
        );
    };
    const pointer = (event: PointerEvent) => {
      const bounds = pane.getBoundingClientRect();
      // Overlay scrollbars live inside clientWidth. Only pane-edge presses
      // arm a drag; selecting text/clicking message controls does not unpin.
      if (event.target === pane && event.clientX >= bounds.right - 18) {
        draggingScrollbar = true;
        intent(true);
      }
    };
    const release = () => {
      draggingScrollbar = false;
    };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    window.addEventListener("blur", release);
    pane.addEventListener("scroll", read, { passive: true });
    pane.addEventListener("wheel", wheel, { passive: true });
    pane.addEventListener("pointerdown", pointer);
    pane.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      window.removeEventListener("blur", release);
      pane.removeEventListener("scroll", read);
      pane.removeEventListener("wheel", wheel);
      pane.removeEventListener("pointerdown", pointer);
      pane.removeEventListener("keydown", key);
      savePosition();
      const current = model.current;
      if (current.frame) cancelAnimationFrame(current.frame);
      current.frame = 0;
    };
  }, [pane, active, schedule, savePosition]);

  const jumpToLatest = useCallback(() => {
    model.current.state = { kind: "following" };
    model.current.pendingNavigation = true;
    model.current.userIntent = 0;
    schedule();
  }, [schedule]);
  const navigateToElement = useCallback(
    (element: HTMLElement) => {
      const pane = paneRef.current;
      if (!pane || !pane.contains(element)) return;
      const top =
        pane.scrollTop +
        element.getBoundingClientRect().top -
        pane.getBoundingClientRect().top -
        pane.clientHeight / 2;
      const anchor = anchorAt(model.current.layout, Math.max(0, top));
      if (anchor) model.current.state = { kind: "reading", anchor };
      model.current.pendingNavigation = true;
      model.current.userIntent = 0;
      schedule();
    },
    [paneRef, schedule],
  );
  return {
    totalHeight,
    visibleRows: placements,
    layoutGeneration: current.generation,
    showJumpToLatest,
    attachPane,
    measureRow,
    savePosition,
    jumpToLatest,
    navigateToElement,
    setSearchMode,
  };
}
export type TimelineViewport = ReturnType<typeof useTimelineViewport>;
