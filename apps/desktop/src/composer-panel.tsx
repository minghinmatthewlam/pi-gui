import { type ClipboardEvent, type Dispatch, type DragEvent, type KeyboardEvent, type RefObject, type SetStateAction } from "react";
import type { ComposerImageAttachment, SessionRecord } from "./desktop-state";
import { ArrowUpIcon, ModelIcon, PlusIcon, ReasoningIcon, SkillIcon, SparkIcon, StatusIcon, StopSquareIcon } from "./icons";
import type { ComposerSlashCommand, ComposerSlashCommandSection, ComposerSlashOption } from "./composer-commands";

interface ComposerPanelProps {
  readonly selectedSession: SessionRecord;
  readonly activeSlashCommand?: ComposerSlashCommand;
  readonly activeSlashCommandMeta?: string;
  readonly composerDraft: string;
  readonly setComposerDraft: Dispatch<SetStateAction<string>>;
  readonly composerRef: RefObject<HTMLTextAreaElement | null>;
  readonly runningLabel: string;
  readonly attachments: readonly ComposerImageAttachment[];
  readonly slashSections: readonly ComposerSlashCommandSection[];
  readonly slashOptions: readonly ComposerSlashOption[];
  readonly selectedSlashCommand?: ComposerSlashCommand;
  readonly selectedSlashOption?: ComposerSlashOption;
  readonly showSlashMenu: boolean;
  readonly showSlashOptionMenu: boolean;
  readonly onClearSlashCommand: () => void;
  readonly onComposerKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  readonly onComposerPaste: (event: ClipboardEvent<HTMLDivElement>) => void;
  readonly onComposerDrop: (event: DragEvent<HTMLDivElement>) => void;
  readonly onPickImages: () => void;
  readonly onRemoveImage: (attachmentId: string) => void;
  readonly onSelectSlashCommand: (command: ComposerSlashCommand) => void;
  readonly onSelectSlashOption: (option: ComposerSlashOption) => void;
  readonly onSubmit: () => void;
  readonly showMentionMenu: boolean;
  readonly mentionOptions: readonly string[];
  readonly selectedMentionIndex: number;
  readonly onSelectMention: (filePath: string) => void;
}

export function ComposerPanel({
  selectedSession,
  activeSlashCommand,
  activeSlashCommandMeta,
  composerDraft,
  setComposerDraft,
  composerRef,
  runningLabel,
  attachments,
  slashSections,
  slashOptions,
  selectedSlashCommand,
  selectedSlashOption,
  showSlashMenu,
  showSlashOptionMenu,
  onClearSlashCommand,
  onComposerKeyDown,
  onComposerPaste,
  onComposerDrop,
  onPickImages,
  onRemoveImage,
  onSelectSlashCommand,
  onSelectSlashOption,
  onSubmit,
  showMentionMenu,
  mentionOptions,
  selectedMentionIndex,
  onSelectMention,
}: ComposerPanelProps) {
  return (
    <footer className="composer">
      <div className="conversation conversation--composer">
        {showMentionMenu ? (
          <div className="composer__menus">
            <div className="mention-menu" data-testid="mention-menu" onWheel={(event) => event.stopPropagation()}>
              {mentionOptions.map((filePath, index) => {
                const lastSlash = filePath.lastIndexOf("/");
                const dirPart = lastSlash >= 0 ? filePath.slice(0, lastSlash + 1) : "";
                const namePart = lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;
                return (
                  <button
                    className={`mention-menu__item ${index === selectedMentionIndex ? "mention-menu__item--active" : ""}`}
                    key={filePath}
                    type="button"
                    onClick={() => onSelectMention(filePath)}
                  >
                    {dirPart ? <span className="mention-menu__dirname">{dirPart}</span> : null}
                    <span className="mention-menu__filename">{namePart}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
        {showSlashMenu || (showSlashOptionMenu && selectedSlashCommand) ? (
          <div className="composer__menus">
            {showSlashMenu ? (
              <div className="slash-menu" data-testid="slash-menu" onWheel={(event) => event.stopPropagation()}>
                {slashSections.map((section) => (
                  <div className="slash-menu__section" key={section.id}>
                    {section.title ? (
                      <div className={`slash-menu__section-title slash-menu__section-title--${section.id}`}>
                        <span className="slash-menu__section-icon" aria-hidden="true">
                          {section.id === "skills" ? <SkillIcon /> : <SparkIcon />}
                        </span>
                        <span>{section.title}</span>
                      </div>
                    ) : null}
                    {section.items.map((command) => (
                      <button
                        className={`slash-menu__item ${command.section === "skills" ? "slash-menu__item--skill" : ""} ${selectedSlashCommand?.command === command.command ? "slash-menu__item--active" : ""}`}
                        key={`${section.id}:${command.command}`}
                        type="button"
                        onClick={() => onSelectSlashCommand(command)}
                      >
                        <span className="slash-menu__icon" aria-hidden="true">
                          <SlashCommandIcon command={command} />
                        </span>
                        {command.section === "skills" ? (
                          <span className="slash-menu__content slash-menu__content--skill">
                            <span className="slash-menu__line">
                              <span className="slash-menu__title">{command.title}</span>
                              <span className="slash-menu__skill-badge">{skillSourceLabel(command)}</span>
                            </span>
                            <span className="slash-menu__description">{command.description}</span>
                            <span className="slash-menu__meta">
                              <span className="slash-menu__command slash-menu__command--skill">{command.command}</span>
                            </span>
                          </span>
                        ) : (
                          <span className="slash-menu__content">
                            <span className="slash-menu__line">
                              <span className="slash-menu__title">{command.title}</span>
                              <span className="slash-menu__command">{command.command}</span>
                            </span>
                            <span className="slash-menu__description">{command.description}</span>
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            ) : null}
            {showSlashOptionMenu && selectedSlashCommand ? (
              <div className="slash-menu slash-menu--options" data-testid="slash-options-menu" onWheel={(event) => event.stopPropagation()}>
                <div className="slash-menu__search">{selectedSlashCommand.title}</div>
                {slashOptions.map((option) => (
                  <button
                    className={`slash-menu__option ${selectedSlashOption?.value === option.value ? "slash-menu__option--active" : ""}`}
                    key={option.value}
                    type="button"
                    onClick={() => onSelectSlashOption(option)}
                  >
                    <span className="slash-menu__option-title">{option.label}</span>
                    <span className="slash-menu__option-description">{option.description}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        <div
          className="composer__surface"
          onPaste={onComposerPaste}
          onDrop={onComposerDrop}
          onDragOver={(event) => event.preventDefault()}
        >
          {activeSlashCommand ? (
            <div className="composer__slash-intent">
              <span className="composer__slash-intent-icon" aria-hidden="true">
                <SlashCommandIcon command={activeSlashCommand} />
              </span>
              <span className="composer__slash-intent-body">
                <span className="composer__slash-intent-title">{activeSlashCommand.title}</span>
                {activeSlashCommandMeta ? (
                  <span className="composer__slash-intent-meta">{activeSlashCommandMeta}</span>
                ) : null}
              </span>
              <button
                aria-label={`Clear ${activeSlashCommand.title}`}
                className="composer__slash-intent-clear"
                type="button"
                onClick={onClearSlashCommand}
              >
                ×
              </button>
            </div>
          ) : null}
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
                aria-label={selectedSession.status === "running" ? "Stop run" : "Send message"}
                className="button button--primary button--cta-icon"
                data-testid="send"
                type="button"
                disabled={!composerDraft.trim() && attachments.length === 0 && selectedSession.status !== "running"}
                onClick={onSubmit}
              >
                {selectedSession.status === "running" ? <StopSquareIcon /> : <ArrowUpIcon />}
              </button>
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
}

function skillSourceLabel(command: ComposerSlashCommand): string {
  const source = command.skill?.source?.trim();
  if (!source) {
    return "Skill";
  }
  return source.charAt(0).toUpperCase() + source.slice(1);
}

function SlashCommandIcon({ command }: { readonly command: ComposerSlashCommand }) {
  switch (command.kind) {
    case "model":
      return <ModelIcon />;
    case "thinking":
      return <ReasoningIcon />;
    case "status":
      return <StatusIcon />;
    case "skill":
      return <SkillIcon />;
    default:
      return <SparkIcon />;
  }
}
