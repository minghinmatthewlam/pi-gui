import { ChatIcon, CloseIcon } from "../../../ui/icons";
import type { TranscriptAnnotation } from "./annotation-prompt";

/** "N annotations" above the composer; hovering or focusing it lists each quote and comment. */
export function AnnotationChip({
  annotations,
  onRemove,
}: {
  readonly annotations: readonly TranscriptAnnotation[];
  readonly onRemove: (id: string) => void;
}) {
  if (annotations.length === 0) return null;
  const label = `${annotations.length} annotation${annotations.length === 1 ? "" : "s"}`;
  return (
    <div className="annotation-chip" data-testid="annotation-chip">
      <button className="annotation-chip__button" type="button">
        <ChatIcon />
        <span>{label}</span>
      </button>
      <div className="annotation-chip__popover" data-testid="annotation-chip-popover">
        <div className="annotation-chip__list">
          {annotations.map((annotation, index) => (
            <div className="annotation-chip__item" key={annotation.id}>
              <span className="annotation-chip__number">{index + 1}</span>
              <div className="annotation-chip__body">
                <div className="annotation-chip__quote">{annotation.quote}</div>
                {annotation.note ? (
                  <div className="annotation-chip__note">{annotation.note}</div>
                ) : null}
              </div>
              <button
                aria-label={`Remove annotation ${index + 1}`}
                className="annotation-chip__remove"
                type="button"
                onClick={() => onRemove(annotation.id)}
              >
                <CloseIcon />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
