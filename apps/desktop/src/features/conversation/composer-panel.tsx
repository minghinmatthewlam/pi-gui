import {
  type ClipboardEvent,
  type Dispatch,
  type DragEvent,
  type KeyboardEvent,
  type RefObject,
  type SetStateAction,
} from "react";
import type { RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import type {
  ComposerAttachment,
  QueuedComposerMessage,
  SessionRecord,
} from "../../../contracts/desktop-state";
import type { MentionOption } from "./hooks/use-mention-menu";
import { ArrowUpIcon, PlusIcon, StopSquareIcon } from "../../ui/icons";
import type {
  ComposerSlashCommand,
  ComposerSlashCommandSection,
  ComposerSlashOption,
  ComposerSlashOptionEmptyState,
} from "./composer-commands";
import { ComposerSurface } from "./composer-surface";
import { ModelOnboardingNoticeBanner } from "../settings/model-onboarding-notice";
import type {
  ModelOnboardingState,
  ModelOnboardingSettingsSection,
} from "../settings/model-onboarding";
import { ModelSelector } from "./model-selector";
import type { ExtensionDockModel } from "../extensions/extension-session-ui";

interface ComposerPanelProps {
  readonly preparingTaskDraft?: boolean;
  readonly selectedSession: SessionRecord;
  readonly lastError?: string;
  readonly runtime?: RuntimeSnapshot;
  readonly activeSlashCommand?: ComposerSlashCommand;
  readonly activeSlashCommandMeta?: string;
  readonly composerDraft: string;
  readonly setComposerDraft: Dispatch<SetStateAction<string>>;
  readonly composerRef: RefObject<HTMLTextAreaElement | null>;
  readonly runningLabel: string;
  readonly attachments: readonly ComposerAttachment[];
  readonly queuedMessages: readonly QueuedComposerMessage[];
  readonly editingQueuedMessageId?: string;
  readonly provider: string | undefined;
  readonly modelId: string | undefined;
  readonly thinkingLevel: string | undefined;
  readonly slashSections: readonly ComposerSlashCommandSection[];
  readonly slashOptions: readonly ComposerSlashOption[];
  readonly selectedSlashCommand?: ComposerSlashCommand;
  readonly selectedSlashOption?: ComposerSlashOption;
  readonly showSlashMenu: boolean;
  readonly showSlashOptionMenu: boolean;
  readonly slashOptionEmptyState?: ComposerSlashOptionEmptyState;
  readonly onClearSlashCommand: () => void;
  readonly onComposerKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  readonly onComposerPaste: (event: ClipboardEvent<HTMLDivElement>) => void;
  readonly onComposerDrop: (event: DragEvent<HTMLDivElement>) => void;
  readonly onPickAttachments: () => void;
  readonly onRemoveAttachment: (attachmentId: string) => void;
  readonly onEditQueuedMessage: (messageId: string) => void;
  readonly onCancelQueuedEdit: () => void;
  readonly onRemoveQueuedMessage: (messageId: string) => void;
  readonly onSteerQueuedMessage: (messageId: string) => void;
  readonly onSelectSlashCommand: (command: ComposerSlashCommand) => void;
  readonly onSelectSlashOption: (option: ComposerSlashOption) => void;
  readonly onSetModel: (provider: string, modelId: string) => void;
  readonly onSetThinking: (level: string) => void;
  readonly modelOnboarding: ModelOnboardingState;
  readonly onOpenModelSettings: (section: ModelOnboardingSettingsSection) => void;
  readonly onSubmit: () => void;
  readonly onStop: () => void;
  readonly showMentionMenu: boolean;
  readonly mentionOptions: readonly MentionOption[];
  readonly selectedMentionIndex: number;
  readonly onSelectMention: (option: MentionOption) => void;
  readonly onEnableMentionExtension: (
    option: Extract<MentionOption, { kind: "extension" }>,
  ) => void;
  readonly extensionDock?: ExtensionDockModel;
  readonly extensionDockExpanded: boolean;
  readonly onToggleExtensionDock: () => void;
}

export function ComposerPanel({
  preparingTaskDraft = false,
  selectedSession,
  lastError,
  runtime,
  activeSlashCommand,
  activeSlashCommandMeta,
  composerDraft,
  setComposerDraft,
  composerRef,
  runningLabel,
  attachments,
  queuedMessages,
  editingQueuedMessageId,
  provider,
  modelId,
  thinkingLevel,
  slashSections,
  slashOptions,
  selectedSlashCommand,
  selectedSlashOption,
  showSlashMenu,
  showSlashOptionMenu,
  slashOptionEmptyState,
  onClearSlashCommand,
  onComposerKeyDown,
  onComposerPaste,
  onComposerDrop,
  onPickAttachments,
  onRemoveAttachment,
  onEditQueuedMessage,
  onCancelQueuedEdit,
  onRemoveQueuedMessage,
  onSteerQueuedMessage,
  onSelectSlashCommand,
  onSelectSlashOption,
  onSetModel,
  onSetThinking,
  modelOnboarding,
  onOpenModelSettings,
  onSubmit,
  onStop,
  showMentionMenu,
  mentionOptions,
  selectedMentionIndex,
  onSelectMention,
  onEnableMentionExtension,
  extensionDock,
  extensionDockExpanded,
  onToggleExtensionDock,
}: ComposerPanelProps) {
  const hasComposerInput = composerDraft.trim().length > 0 || attachments.length > 0;
  const primaryActionIsStop = selectedSession.status === "running" && !hasComposerInput;

  return (
    <footer className="composer" aria-busy={preparingTaskDraft}>
      <div className="conversation conversation--composer" inert={preparingTaskDraft}>
        <ComposerSurface
          lastError={lastError}
          activeSlashCommand={activeSlashCommand}
          activeSlashCommandMeta={activeSlashCommandMeta}
          topNotice={
            <ModelOnboardingNoticeBanner
              notice={modelOnboarding.notice}
              onOpenSettings={onOpenModelSettings}
            />
          }
          composerDraft={composerDraft}
          setComposerDraft={setComposerDraft}
          composerRef={composerRef}
          attachments={attachments}
          queuedMessages={queuedMessages}
          editingQueuedMessageId={editingQueuedMessageId}
          slashSections={slashSections}
          slashOptions={slashOptions}
          selectedSlashCommand={selectedSlashCommand}
          selectedSlashOption={selectedSlashOption}
          showSlashMenu={showSlashMenu}
          showSlashOptionMenu={showSlashOptionMenu}
          slashOptionEmptyState={slashOptionEmptyState}
          onClearSlashCommand={onClearSlashCommand}
          onComposerKeyDown={onComposerKeyDown}
          onComposerPaste={onComposerPaste}
          onComposerDrop={onComposerDrop}
          onRemoveAttachment={onRemoveAttachment}
          onEditQueuedMessage={onEditQueuedMessage}
          onCancelQueuedEdit={onCancelQueuedEdit}
          onRemoveQueuedMessage={onRemoveQueuedMessage}
          onSteerQueuedMessage={onSteerQueuedMessage}
          onSelectSlashCommand={onSelectSlashCommand}
          onSelectSlashOption={onSelectSlashOption}
          showMentionMenu={showMentionMenu}
          mentionOptions={mentionOptions}
          selectedMentionIndex={selectedMentionIndex}
          onSelectMention={onSelectMention}
          onEnableMentionExtension={onEnableMentionExtension}
          textareaLabel="Composer"
          textareaTestId="composer"
          textareaPlaceholder="Ask pi to inspect the repo, run a fix, or continue the current thread..."
          extensionDock={extensionDock}
          extensionDockExpanded={extensionDockExpanded}
          onToggleExtensionDock={onToggleExtensionDock}
          footer={
            <div className="composer__footer">
              <div className="composer__footer-row">
                <div className="composer__config">
                  <ModelSelector
                    runtime={runtime}
                    provider={provider}
                    modelId={modelId}
                    thinkingLevel={thinkingLevel}
                    disabled={selectedSession.status === "running"}
                    unselectedModelLabel={modelOnboarding.unselectedModelLabel}
                    emptyModelTitle={modelOnboarding.emptyModelTitle}
                    onSetModel={onSetModel}
                    onSetThinking={onSetThinking}
                  />
                </div>
                <div className="composer__actions">
                  <button
                    aria-label="Attach files"
                    className="icon-button composer__attach"
                    type="button"
                    onClick={onPickAttachments}
                  >
                    <PlusIcon />
                  </button>
                  <button
                    aria-label={primaryActionIsStop ? "Stop run" : "Send message"}
                    className="button button--primary button--cta-icon"
                    data-testid="send"
                    type="button"
                    disabled={
                      !primaryActionIsStop &&
                      ((!composerDraft.trim() && attachments.length === 0) ||
                        modelOnboarding.requiresModelSelection)
                    }
                    onClick={onSubmit}
                  >
                    {primaryActionIsStop ? <StopSquareIcon /> : <ArrowUpIcon />}
                  </button>
                </div>
              </div>
              {selectedSession.status === "running" ? (
                <div className="composer__hint">
                  {runningLabel} · Enter to queue · Cmd+Enter to steer
                </div>
              ) : null}
            </div>
          }
        />
      </div>
      {preparingTaskDraft ? (
        <div className="composer__footer-row">
          <p className="composer__hint" role="status" data-testid="composer-prepare-task-status">
            Preparing task… Your current draft is saved before opening it.
          </p>
          {selectedSession.status === "running" ? (
            <button
              aria-label="Stop run"
              className="button button--primary button--cta-icon"
              data-testid="stop-while-preparing-task"
              onClick={onStop}
              type="button"
            >
              <StopSquareIcon />
            </button>
          ) : null}
        </div>
      ) : null}
    </footer>
  );
}
