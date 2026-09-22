import { useEffect, useRef, useState } from "react";

export function WorkbenchResizeHandle({
  onResize,
}: {
  readonly onResize: (width: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; x: number; width: number } | null>(null);
  const [size, setSize] = useState({ width: 440, min: 320, max: 1200 });
  const [resizing, setResizing] = useState(false);

  useEffect(() => {
    const panel = ref.current?.parentElement;
    const main = panel?.parentElement;
    if (!panel || !main) return;
    const measure = () => {
      const max = Math.floor(
        Math.min(1200, main.clientWidth * (window.innerWidth <= 980 ? 1 : 0.65)),
      );
      setSize({
        width: Math.round(panel.getBoundingClientRect().width),
        min: Math.min(320, max),
        max,
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    observer.observe(main);
    measure();
    return () => observer.disconnect();
  }, []);

  const resize = (width: number) => onResize(Math.max(size.min, Math.min(size.max, width)));
  return (
    <div
      ref={ref}
      className="workbench__resize-handle"
      role="separator"
      aria-label="Side panel width"
      aria-orientation="vertical"
      aria-controls="task-workbench"
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
          resize(start.width + start.x - event.clientX);
      }}
      onPointerUp={(event) => {
        if (drag.current?.pointerId !== event.pointerId) return;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onLostPointerCapture={() => {
        drag.current = null;
        setResizing(false);
      }}
      onKeyDown={(event) => {
        const next =
          event.key === "ArrowLeft"
            ? size.width + 20
            : event.key === "ArrowRight"
              ? size.width - 20
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
