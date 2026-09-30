import type { SentAnnotation } from "./annotation-prompt";

/** The quotes a sent message carried, each collapsed to one line until clicked open. */
export function SentAnnotations({
  annotations,
}: {
  readonly annotations: readonly SentAnnotation[];
}) {
  return (
    <div className="sent-annotations">
      {annotations.map((annotation, index) => (
        <div className="sent-annotation" data-testid="sent-annotation" key={index}>
          <details className="sent-annotation__quote">
            <summary>{annotation.quote}</summary>
          </details>
          {annotation.note ? <p className="sent-annotation__note">{annotation.note}</p> : null}
        </div>
      ))}
    </div>
  );
}
