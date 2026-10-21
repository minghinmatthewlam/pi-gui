import type { ComposerAttachment, QueuedComposerMessage } from "../../../contracts/desktop-state";
import { useTranslation, type Translate } from "../../i18n";
import { FileIcon } from "../../ui/icons";
import { ImageAttachmentThumb } from "./image-attachment-thumb";
import { parseAnnotatedPrompt } from "./annotations/annotation-prompt";

function queuedPreview(text: string, t: Translate): string {
  const annotated = parseAnnotatedPrompt(text);
  if (!annotated) return text;
  const label = t("queuedComposer.annotations", { count: annotated.annotations.length });
  return annotated.body.trim() ? `${annotated.body.trim()} · ${label}` : label;
}

interface QueuedComposerMessagesProps {
  readonly messages: readonly QueuedComposerMessage[];
  readonly editingQueuedMessageId?: string;
  readonly onEditMessage: (messageId: string) => void;
  readonly onRemoveMessage: (messageId: string) => void;
  readonly onSteerMessage: (messageId: string) => void;
  readonly onCancelEdit: () => void;
}

export function QueuedComposerMessages({
  messages,
  editingQueuedMessageId,
  onEditMessage,
  onRemoveMessage,
  onSteerMessage,
  onCancelEdit,
}: QueuedComposerMessagesProps) {
  const { t } = useTranslation();

  if (messages.length === 0 && !editingQueuedMessageId) {
    return null;
  }

  return (
    <div className="queued-composer-messages" data-testid="queued-composer-messages">
      {editingQueuedMessageId ? (
        <div className="queued-composer-messages__editing" data-testid="queued-composer-editing">
          <span>{t("ui.editingQueuedMessage")}</span>
          <button type="button" onClick={onCancelEdit}>
            {t("scheduledTasks.editor.cancel")}
          </button>
        </div>
      ) : null}
      {messages.map((message) => (
        <div
          className={`queued-composer-message ${message.id === editingQueuedMessageId ? "queued-composer-message--editing" : ""}`}
          data-testid="queued-composer-message"
          key={message.id}
        >
          <div className="queued-composer-message__header">
            {message.text ? (
              <div className="queued-composer-message__text">{queuedPreview(message.text, t)}</div>
            ) : null}
            <div className="queued-composer-message__actions">
              {message.mode !== "steer" ? (
                <button type="button" onClick={() => onSteerMessage(message.id)}>
                  {t("ui.steer")}
                </button>
              ) : null}
              {/* Its annotations cannot be reattached to the transcript, so it is not editable. */}
              {parseAnnotatedPrompt(message.text) ? null : (
                <button type="button" onClick={() => onEditMessage(message.id)}>
                  {t("scheduledTasks.row.edit")}
                </button>
              )}
              <button
                aria-label={t("ui.deleteQueuedMessageValue", { value: message.text || message.id })}
                type="button"
                onClick={() => onRemoveMessage(message.id)}
              >
                {t("scheduledTasks.row.delete")}
              </button>
            </div>
          </div>
          {message.attachments.length > 0 ? (
            <div className="queued-composer-message__attachments">
              {message.attachments.map((attachment, index) => (
                <QueuedAttachmentPreview
                  attachment={attachment}
                  key={`${message.id}:${attachment.name}:${index}`}
                />
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function QueuedAttachmentPreview({ attachment }: { readonly attachment: ComposerAttachment }) {
  return (
    <div className={`queued-composer-attachment queued-composer-attachment--${attachment.kind}`}>
      {attachment.kind === "image" ? (
        <ImageAttachmentThumb
          className="queued-composer-attachment__preview"
          name={attachment.name}
          src={`data:${attachment.mimeType};base64,${attachment.data}`}
        />
      ) : (
        <>
          <span className="queued-composer-attachment__icon" aria-hidden="true">
            <FileIcon />
          </span>
          <span className="queued-composer-attachment__name">{attachment.name}</span>
        </>
      )}
    </div>
  );
}
