import { type Dispatch, type KeyboardEvent, type RefObject, type SetStateAction } from "react";
import type { ComposerImageAttachment, SessionRecord } from "./desktop-state";
import { PlusIcon } from "./icons";
import type { ComposerSlashCommand } from "./composer-commands";

interface ComposerPanelProps {
  readonly selectedSession: SessionRecord;
  readonly composerDraft: string;
  readonly setComposerDraft: Dispatch<SetStateAction<string>>;
  readonly composerRef: RefObject<HTMLTextAreaElement | null>;
  readonly runningLabel: string;
  readonly attachments: readonly ComposerImageAttachment[];
  readonly slashSuggestions: readonly ComposerSlashCommand[];
  readonly selectedSlashCommand?: ComposerSlashCommand;
  readonly showSlashMenu: boolean;
  readonly onComposerKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  readonly onPickImages: () => void;
  readonly onRemoveImage: (attachmentId: string) => void;
  readonly onSubmit: () => void;
}

export function ComposerPanel({
  selectedSession,
  composerDraft,
  setComposerDraft,
  composerRef,
  runningLabel,
  attachments,
  slashSuggestions,
  selectedSlashCommand,
  showSlashMenu,
  onComposerKeyDown,
  onPickImages,
  onRemoveImage,
  onSubmit,
}: ComposerPanelProps) {
  return (
    <footer className="composer">
      <div className="conversation conversation--composer">
        <div className="composer__surface">
          {attachments.length > 0 ? (
            <div className="composer__attachments">
              {attachments.map((attachment) => (
                <div className="composer-attachment" key={attachment.id}>
                  <img
                    alt={attachment.name}
                    className="composer-attachment__preview"
                    src={`data:${attachment.mimeType};base64,${attachment.data}`}
                  />
                  <span className="composer-attachment__name">{attachment.name}</span>
                  <button
                    aria-label={`Remove ${attachment.name}`}
                    className="composer-attachment__remove"
                    type="button"
                    onClick={() => onRemoveImage(attachment.id)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          <textarea
            aria-label="Composer"
            data-testid="composer"
            ref={composerRef}
            value={composerDraft}
            onChange={(event) => {
              setComposerDraft(event.target.value);
            }}
            onKeyDown={onComposerKeyDown}
            placeholder="Ask pi to inspect the repo, run a fix, or continue the current thread..."
          />
          {showSlashMenu ? (
            <div className="slash-menu">
              {slashSuggestions.map((command) => (
                <button
                  className={`slash-menu__item ${selectedSlashCommand?.command === command.command ? "slash-menu__item--active" : ""}`}
                  key={command.command}
                  type="button"
                  onClick={() => {
                    setComposerDraft(command.template);
                    composerRef.current?.focus();
                  }}
                >
                  <span className="slash-menu__title">{command.title}</span>
                  <span className="slash-menu__command">{command.command}</span>
                  <span className="slash-menu__description">{command.description}</span>
                </button>
              ))}
            </div>
          ) : null}
          <div className="composer__bar">
            <div className="composer__hint">
              {selectedSession.status === "running" ? runningLabel : "Enter to send · Shift+Enter for newline"}
              {selectedSession.config?.provider && selectedSession.config?.modelId ? (
                <span className="composer__config"> · {selectedSession.config.provider}:{selectedSession.config.modelId}</span>
              ) : null}
              {selectedSession.config?.thinkingLevel ? (
                <span className="composer__config"> · {selectedSession.config.thinkingLevel}</span>
              ) : null}
            </div>
            <div className="composer__actions">
              <button
                aria-label="Attach image"
                className="icon-button composer__attach"
                type="button"
                disabled={selectedSession.status === "running"}
                onClick={onPickImages}
              >
                <PlusIcon />
              </button>
              <button
                className="button button--primary"
                data-testid="send"
                type="button"
                disabled={!composerDraft.trim() && attachments.length === 0 && selectedSession.status !== "running"}
                onClick={onSubmit}
              >
                {selectedSession.status === "running" ? "Stop" : "Send"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
}
