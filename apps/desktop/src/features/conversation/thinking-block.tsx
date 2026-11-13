import { ChevronRightIcon } from "../../ui/icons";

/**
 * One assistant turn's reasoning, drawn collapsed above the answer. The transcript stays clean
 * until the user opens it, and it stays readable after the run because pi saved it with the turn.
 */
export function ThinkingBlock({
  thinking,
  expanded,
  onToggle,
}: {
  readonly thinking: string;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <div className="timeline-thinking" data-testid="timeline-thinking">
      <button
        aria-expanded={expanded}
        className="timeline-thinking__toggle"
        data-testid="timeline-thinking-toggle"
        type="button"
        onClick={onToggle}
      >
        <span
          className={`timeline-thinking__chevron${expanded ? " timeline-thinking__chevron--expanded" : ""}`}
          aria-hidden="true"
        >
          <ChevronRightIcon />
        </span>
        <span className="timeline-thinking__label">Thinking</span>
        <span className="timeline-thinking__hint">{expanded ? "Hide" : "Show"}</span>
      </button>
      {expanded ? (
        <div className="timeline-thinking__body" data-testid="timeline-thinking-body">
          {thinking.trim()}
        </div>
      ) : null}
    </div>
  );
}
