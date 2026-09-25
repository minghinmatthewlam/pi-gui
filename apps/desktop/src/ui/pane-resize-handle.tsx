import { useEffect, useRef, useState } from "react";

export interface PaneWidthBounds {
  readonly min: number;
  readonly max: number;
}

/**
 * Drag and keyboard handle on one vertical edge of a pane. The handle must be a
 * direct child of the pane; `bounds` receives the pane and the pane's parent.
 * `edge` is the pane edge the handle sits on, so dragging away from the pane widens it.
 */
export function PaneResizeHandle({
  className,
  label,
  controls,
  edge,
  bounds,
  onResize,
  onReset,
}: {
  readonly className: string;
  readonly label: string;
  readonly controls: string;
  readonly edge: "left" | "right";
  readonly bounds: (pane: HTMLElement, container: HTMLElement) => PaneWidthBounds;
  readonly onResize: (width: number) => void;
  readonly onReset?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; x: number; width: number } | null>(null);
  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;
  const [size, setSize] = useState({ width: 0, min: 0, max: 0 });
  const [resizing, setResizing] = useState(false);

  useEffect(() => {
    const pane = ref.current?.parentElement;
    const container = pane?.parentElement;
    if (!pane || !container) return;
    const measure = () => {
      const { min, max } = boundsRef.current(pane, container);
      setSize({
        width: Math.round(pane.getBoundingClientRect().width),
        min: Math.min(min, max),
        max,
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(pane);
    observer.observe(container);
    measure();
    return () => observer.disconnect();
  }, []);

  const widen = edge === "right" ? 1 : -1;
  const resize = (width: number) => onResize(Math.max(size.min, Math.min(size.max, width)));
  return (
    <div
      ref={ref}
      className={className}
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-controls={controls}
      aria-valuemin={size.min}
      aria-valuemax={size.max}
      aria-valuenow={size.width}
      tabIndex={0}
      data-resizing={resizing}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointerId: event.pointerId, x: event.clientX, width: size.width };
        setResizing(true);
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (start && start.pointerId === event.pointerId)
          resize(start.width + widen * (event.clientX - start.x));
      }}
      onPointerUp={(event) => {
        if (drag.current?.pointerId !== event.pointerId) return;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onLostPointerCapture={() => {
        drag.current = null;
        setResizing(false);
      }}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        const next =
          event.key === "ArrowRight"
            ? size.width + widen * 20
            : event.key === "ArrowLeft"
              ? size.width - widen * 20
              : event.key === "Home"
                ? size.min
                : event.key === "End"
                  ? size.max
                  : undefined;
        if (next === undefined) return;
        event.preventDefault();
        resize(next);
      }}
    />
  );
}
