import { useEffect, useRef, type ClipboardEvent, type DragEvent, type KeyboardEvent, type RefObject } from "react";
import type { RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import type { ComposerImageAttachment, NewThreadEnvironment, WorkspaceRecord } from "./desktop-state";
import { ArrowUpIcon, PiLogoMark, PlusIcon } from "./icons";
import {
  MODEL_OPTIONS_EMPTY_TITLE,
  type ComposerSlashCommand,
  type ComposerSlashCommandSection,
  type ComposerSlashOption,
  type ComposerSlashOptionEmptyState,
} from "./composer-commands";
import { ComposerSurface } from "./composer-surface";
import { COMPOSER_IMAGE_FILE_INPUT_ACCEPT } from "./composer-images";
import { ModelSelector } from "./model-selector";

interface NewThreadViewProps {
  readonly workspaces: readonly WorkspaceRecord[];
  readonly selectedWorkspaceId: string;
  readonly runtime?: RuntimeSnapshot;
  readonly environment: NewThreadEnvironment;
  readonly prompt: string;
  readonly attachments: readonly ComposerImageAttachment[];
  readonly provider: string | undefined;
  readonly modelId: string | undefined;
  readonly thinkingLevel: string | undefined;
  readonly composerRef: RefObject<HTMLTextAreaElement | null>;
  readonly activeSlashCommand?: ComposerSlashCommand;
  readonly activeSlashCommandMeta?: string;
  readonly slashSections: readonly ComposerSlashCommandSection[];
  readonly slashOptions: readonly ComposerSlashOption[];
  readonly selectedSlashCommand?: ComposerSlashCommand;
  readonly selectedSlashOption?: ComposerSlashOption;
  readonly showSlashMenu: boolean;
  readonly showSlashOptionMenu: boolean;
  readonly slashOptionEmptyState?: ComposerSlashOptionEmptyState;
  readonly showMentionMenu: boolean;
  readonly mentionOptions: readonly string[];
  readonly selectedMentionIndex: number;
  readonly onChangePrompt: (prompt: string) => void;
  readonly onSelectEnvironment: (environment: NewThreadEnvironment) => void;
  readonly onSelectWorkspace: (workspaceId: string) => void;
  readonly onSetModel: (provider: string, modelId: string) => void;
  readonly onSetThinking: (level: string) => void;
  readonly onComposerKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  readonly onComposerPaste: (event: ClipboardEvent<HTMLDivElement>) => void;
  readonly onComposerDrop: (event: DragEvent<HTMLDivElement>) => void;
  readonly onClearSlashCommand: () => void;
  readonly onSelectSlashCommand: (command: ComposerSlashCommand) => void;
  readonly onSelectSlashOption: (option: ComposerSlashOption) => void;
  readonly onSelectMention: (filePath: string) => void;
  readonly onAddImages: (files: File[]) => void;
  readonly onRemoveImage: (attachmentId: string) => void;
  readonly onSubmit: () => void;
}

export function NewThreadView({
  workspaces,
  selectedWorkspaceId,
  runtime,
  environment,
  prompt,
  attachments,
  provider,
  modelId,
  thinkingLevel,
  composerRef,
  activeSlashCommand,
  activeSlashCommandMeta,
  slashSections,
  slashOptions,
  selectedSlashCommand,
  selectedSlashOption,
  showSlashMenu,
  showSlashOptionMenu,
  slashOptionEmptyState,
  showMentionMenu,
  mentionOptions,
  selectedMentionIndex,
  onChangePrompt,
  onSelectEnvironment,
  onSelectWorkspace,
  onSetModel,
  onSetThinking,
  onComposerKeyDown,
  onComposerPaste,
  onComposerDrop,
  onClearSlashCommand,
  onSelectSlashCommand,
  onSelectSlashOption,
  onSelectMention,
  onAddImages,
  onRemoveImage,
  onSubmit,
}: NewThreadViewProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const workspace = workspaces.find((entry) => entry.id === selectedWorkspaceId);

  useEffect(() => {
    composerRef.current?.focus();
  }, [composerRef]);

  useEffect(() => {
    const composer = composerRef.current;
    if (!composer) {
      return;
    }

    composer.style.height = "0px";
    composer.style.height = `${Math.min(composer.scrollHeight, 260)}px`;
  }, [composerRef, prompt]);

  if (!workspace) {
    return (
      <section className="canvas canvas--empty">
        <div className="empty-panel">
          <div className="session-header__eyebrow">New thread</div>
          <h1>Open a folder to begin</h1>
          <p>Select a repository from the sidebar first, then start a local or worktree-backed thread.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="canvas canvas--new-thread">
      <div className="new-thread">
        <div className="new-thread__hero">
          <div className="new-thread__logo" data-testid="new-thread-logo">
            <PiLogoMark />
          </div>
          <div className="new-thread__eyebrow">New thread</div>
          <h1 className="new-thread__title">Let&apos;s build</h1>
          <label className="new-thread__workspace-picker">
            <span className="sr-only">Workspace</span>
            <select
              className="new-thread__workspace"
              value={workspace.id}
              onChange={(event) => onSelectWorkspace(event.target.value)}
            >
              {workspaces.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="new-thread__composer composer">
          <div className="conversation conversation--composer">
            <ComposerSurface
              activeSlashCommand={activeSlashCommand}
              activeSlashCommandMeta={activeSlashCommandMeta}
              composerDraft={prompt}
              setComposerDraft={onChangePrompt}
              composerRef={composerRef}
              attachments={attachments}
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
              onRemoveImage={onRemoveImage}
              onSelectSlashCommand={onSelectSlashCommand}
              onSelectSlashOption={onSelectSlashOption}
              showMentionMenu={showMentionMenu}
              mentionOptions={mentionOptions}
              selectedMentionIndex={selectedMentionIndex}
              onSelectMention={onSelectMention}
              textareaLabel="New thread prompt"
              textareaTestId="new-thread-composer"
              textareaClassName="new-thread__textarea"
              textareaPlaceholder="Ask pi anything, use / for commands, or $ for skills"
              footer={(
                <NewThreadComposerFooter
                  runtime={runtime}
                  environment={environment}
                  provider={provider}
                  modelId={modelId}
                  thinkingLevel={thinkingLevel}
                  hasContent={Boolean(prompt.trim() || attachments.length > 0)}
                  fileInputRef={fileInputRef}
                  onSelectEnvironment={onSelectEnvironment}
                  onSetModel={onSetModel}
                  onSetThinking={onSetThinking}
                  onAddImages={onAddImages}
                  onSubmit={onSubmit}
                />
              )}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

interface NewThreadComposerFooterProps {
  readonly runtime?: RuntimeSnapshot;
  readonly environment: NewThreadEnvironment;
  readonly provider: string | undefined;
  readonly modelId: string | undefined;
  readonly thinkingLevel: string | undefined;
  readonly hasContent: boolean;
  readonly fileInputRef: RefObject<HTMLInputElement | null>;
  readonly onSelectEnvironment: (environment: NewThreadEnvironment) => void;
  readonly onSetModel: (provider: string, modelId: string) => void;
  readonly onSetThinking: (level: string) => void;
  readonly onAddImages: (files: File[]) => void;
  readonly onSubmit: () => void;
}

function NewThreadComposerFooter({
  runtime,
  environment,
  provider,
  modelId,
  thinkingLevel,
  hasContent,
  fileInputRef,
  onSelectEnvironment,
  onSetModel,
  onSetThinking,
  onAddImages,
  onSubmit,
}: NewThreadComposerFooterProps) {
  return (
    <>
      <div className="composer__hint new-thread__hint">
        <div className="new-thread__environment-group">
          <button
            className={`new-thread__environment ${environment === "local" ? "new-thread__environment--active" : ""}`}
            type="button"
            onClick={() => onSelectEnvironment("local")}
          >
            <span>Local</span>
          </button>
          <button
            className={`new-thread__environment ${environment === "worktree" ? "new-thread__environment--active" : ""}`}
            type="button"
            onClick={() => onSelectEnvironment("worktree")}
          >
            <span>Worktree</span>
          </button>
        </div>
        <span className="new-thread__hint-separator">·</span>
        <ModelSelector
          runtime={runtime}
          provider={provider}
          modelId={modelId}
          thinkingLevel={thinkingLevel}
          dropdownPlacement="below"
          showEmptyModelControl
          emptyModelLabel={MODEL_OPTIONS_EMPTY_TITLE}
          onSetModel={onSetModel}
          onSetThinking={onSetThinking}
        />
      </div>

      <div className="composer__actions">
        <input
          ref={fileInputRef}
          hidden
          type="file"
          accept={COMPOSER_IMAGE_FILE_INPUT_ACCEPT}
          multiple
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            if (files.length > 0) {
              onAddImages(files);
            }
            event.currentTarget.value = "";
          }}
        />
        <button
          aria-label="Attach image"
          className="icon-button composer__attach"
          type="button"
          onClick={() => fileInputRef.current?.click()}
        >
          <PlusIcon />
        </button>
        <button
          aria-label="Start thread"
          className="button button--primary button--cta-icon"
          type="button"
          disabled={!hasContent}
          onClick={onSubmit}
        >
          <ArrowUpIcon />
        </button>
      </div>
    </>
  );
}
