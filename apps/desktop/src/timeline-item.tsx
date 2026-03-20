import type { TranscriptMessage } from "./desktop-state";
import { MessageMarkdown } from "./message-markdown";

export function TimelineItem({
  item,
}: {
  readonly item: TranscriptMessage;
}) {
  switch (item.kind) {
    case "message":
      return item.role === "user" ? (
        <article className="timeline-item timeline-item--user">
          <div className="timeline-item__bubble">
            {item.attachments?.length ? (
              <div className="timeline-item__attachments">
                {item.attachments.map((attachment, index) => (
                  <img
                    alt={attachment.name ?? `Attachment ${index + 1}`}
                    className="timeline-item__attachment"
                    key={`${item.id}:${index}`}
                    src={`data:${attachment.mimeType};base64,${attachment.data}`}
                  />
                ))}
              </div>
            ) : null}
            <MessageMarkdown text={item.text} />
          </div>
        </article>
      ) : (
        <article className="timeline-item timeline-item--assistant">
          <MessageMarkdown text={item.text} />
        </article>
      );
    case "activity":
      return (
        <div className={`timeline-activity timeline-activity--${item.tone ?? "neutral"}`}>
          <span className="timeline-activity__label">{item.label}</span>
          {item.detail ? <span className="timeline-activity__detail">{item.detail}</span> : null}
          {item.metadata ? <span className="timeline-activity__meta">{item.metadata}</span> : null}
        </div>
      );
    case "tool":
      return (
        <article className={`timeline-tool timeline-tool--${item.status}`}>
          <div className="timeline-tool__label">{item.label}</div>
          {item.detail ? <div className="timeline-tool__detail">{item.detail}</div> : null}
          <div className="timeline-tool__meta">
            <span>{toolMetaLabel(item.toolName, item.status)}</span>
            {item.metadata ? <span>{item.metadata}</span> : null}
          </div>
        </article>
      );
    case "summary":
      return item.presentation === "divider" ? (
        <div className="timeline-summary">
          <span>{item.label}</span>
          {item.metadata ? <span className="timeline-summary__meta">{item.metadata}</span> : null}
        </div>
      ) : (
        <div className="timeline-activity timeline-activity--summary">
          <span className="timeline-activity__label">{item.label}</span>
          {item.metadata ? <span className="timeline-activity__meta">{item.metadata}</span> : null}
        </div>
      );
    default:
      return null;
  }
}

function statusLabel(status: "running" | "success" | "error") {
  if (status === "running") return "Running";
  if (status === "success") return "Done";
  return "Failed";
}

function toolMetaLabel(toolName: string, status: "running" | "success" | "error") {
  return `${toolName} · ${statusLabel(status).toLowerCase()}`;
}
