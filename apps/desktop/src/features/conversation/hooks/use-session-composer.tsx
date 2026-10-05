import {
  type ClipboardEvent,
  type Dispatch,
  type DragEvent,
  type KeyboardEvent,
  type MutableRefObject,
  type SetStateAction,
  useState,
} from "react";
import {
  type ComposerImageAttachment,
  type DesktopAppState,
  type SessionRecord,
} from "../../../../contracts/desktop-state";
import type { ClipboardImageRead } from "../../../../contracts/composer-attachments";
import { updateSnapshot } from "../../../app/desktop-app-state";
import {
  extractFilesFromDataTransfer,
  handleClipboardImageShortcut,
  handleComposerImagePaste,
  readComposerAttachmentsFromFiles,
} from "../composer-attachments";
import { parseTreeComposerCommand } from "../composer-commands";
import { formatAnnotatedPrompt } from "../annotations/annotation-prompt";
import type { TranscriptAnnotations } from "../annotations/use-transcript-annotations";
import type { PiDesktopApi } from "../../../../contracts/ipc";

interface UseSessionComposerParams {
  readonly api: PiDesktopApi | undefined;
  readonly snapshot: DesktopAppState | null;
  readonly setSnapshot: Dispatch<SetStateAction<DesktopAppState | null>>;
  readonly selectedSession: SessionRecord | undefined;
  readonly composerDraft: string;
  readonly setComposerDraft: Dispatch<SetStateAction<string>>;
  readonly composerDraftRef: MutableRefObject<string>;
  /** Sends a debounced draft write now, so it cannot land after a host action that replaces the draft. */
  readonly flushComposerDraft: () => void;
  readonly composerRef: MutableRefObject<HTMLTextAreaElement | null>;
  readonly requiresModelSelection: boolean;
  readonly openTreeModal: () => void;
  readonly handleMentionKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  readonly handleSlashKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  readonly newThreadComposerRef: MutableRefObject<HTMLTextAreaElement | null>;
  readonly appendNewThreadAttachment: (attachment: ComposerImageAttachment) => void;
  readonly onNewThreadComposerError: (message: string) => void;
  readonly annotations: TranscriptAnnotations;
}

export function useSessionComposer(params: UseSessionComposerParams) {
  const {
    api,
    snapshot,
    setSnapshot,
    selectedSession,
    composerDraft,
    setComposerDraft,
    composerDraftRef,
    flushComposerDraft,
    composerRef,
    requiresModelSelection,
    openTreeModal,
    handleMentionKeyDown,
    handleSlashKeyDown,
    newThreadComposerRef,
    appendNewThreadAttachment,
    onNewThreadComposerError,
    annotations,
  } = params;

  const [attachmentsClearedOnSubmit, setAttachmentsClearedOnSubmit] = useState(false);
  const composerAttachments = attachmentsClearedOnSubmit
    ? []
    : (snapshot?.composerAttachments ?? []);

  const stopCurrentRun = () => {
    if (!api || selectedSession?.status !== "running") return;
    void updateSnapshot(setSnapshot, () => api.cancelCurrentRun()).catch((error: unknown) => {
      console.error("[renderer] cancelCurrentRun failed", error);
    });
  };

  const submitComposerDraft = (options: { readonly deliverAs?: "steer" | "followUp" } = {}) => {
    if (!api || !selectedSession) {
      return;
    }

    const hasComposerInput =
      composerDraft.trim().length > 0 ||
      composerAttachments.length > 0 ||
      annotations.list.length > 0;
    if (selectedSession.status === "running" && !hasComposerInput) {
      stopCurrentRun();
      return;
    }

    if (!hasComposerInput) {
      return;
    }
    if (requiresModelSelection) {
      return;
    }

    const treeCommand = parseTreeComposerCommand(composerDraft);
    if (treeCommand?.type === "error") {
      setSnapshot((current) =>
        current
          ? {
              ...current,
              lastError: treeCommand.message,
            }
          : current,
      );
      return;
    }
    if (treeCommand?.type === "tree") {
      openTreeModal();
      return;
    }

    const previousDraft = composerDraft;
    // A slash command keeps its annotations for the next message rather than breaking the command.
    const sentAnnotations = composerDraft.trimStart().startsWith("/") ? null : annotations.take();
    const text = sentAnnotations?.taken.length
      ? formatAnnotatedPrompt(sentAnnotations.taken, previousDraft)
      : previousDraft;
    setComposerDraft("");
    setAttachmentsClearedOnSubmit(true);
    void (async () => {
      const nextState = await updateSnapshot(setSnapshot, () =>
        api.submitComposer(
          text,
          selectedSession.status === "running"
            ? { deliverAs: options.deliverAs ?? "followUp" }
            : undefined,
        ),
      );
      // A failed send hands the text back as the draft; give back the annotations and the
      // typed text rather than their formatted blocks.
      const returnedToComposer = sentAnnotations?.taken.length && nextState.composerDraft === text;
      if (returnedToComposer) sentAnnotations.undo();
      // Only apply the resolved draft if the user hasn't typed into the composer during the
      // in-flight submit; otherwise their new input would be clobbered.
      if (composerDraftRef.current === "") {
        setComposerDraft(returnedToComposer ? previousDraft : nextState.composerDraft);
      }
      setAttachmentsClearedOnSubmit(false);
    })().catch(() => {
      if (composerDraftRef.current === "") {
        setComposerDraft(previousDraft);
      }
      sentAnnotations?.undo();
      setAttachmentsClearedOnSubmit(false);
    });
  };

  const handlePickAttachments = () => {
    if (!api) {
      return;
    }
    void updateSnapshot(setSnapshot, () => api.pickComposerAttachments()).catch(
      (error: unknown) => {
        console.error("[renderer] pickComposerAttachments failed", error);
      },
    );
  };

  const handleRemoveAttachment = (attachmentId: string) => {
    if (!api) {
      return;
    }
    void updateSnapshot(setSnapshot, () => api.removeComposerAttachment(attachmentId)).catch(
      (error: unknown) => {
        console.error("[renderer] removeComposerAttachment failed", error);
      },
    );
  };

  const handleEditQueuedMessage = (messageId: string) => {
    if (!api) {
      return;
    }
    flushComposerDraft();
    void updateSnapshot(setSnapshot, () => api.editQueuedComposerMessage(messageId, composerDraft))
      .then(() => {
        composerRef.current?.focus();
      })
      .catch((error: unknown) => {
        console.error("[renderer] editQueuedComposerMessage failed", error);
      });
  };

  const handleCancelQueuedEdit = () => {
    if (!api) {
      return;
    }
    flushComposerDraft();
    void updateSnapshot(setSnapshot, () => api.cancelQueuedComposerEdit())
      .then(() => {
        composerRef.current?.focus();
      })
      .catch((error: unknown) => {
        console.error("[renderer] cancelQueuedComposerEdit failed", error);
      });
  };

  const handleRemoveQueuedMessage = (messageId: string) => {
    if (!api) {
      return;
    }
    flushComposerDraft();
    void updateSnapshot(setSnapshot, () => api.removeQueuedComposerMessage(messageId)).catch(
      (error: unknown) => {
        console.error("[renderer] removeQueuedComposerMessage failed", error);
      },
    );
  };

  const handleSteerQueuedMessage = (messageId: string) => {
    if (!api) {
      return;
    }
    void updateSnapshot(setSnapshot, () => api.steerQueuedComposerMessage(messageId)).catch(
      (error: unknown) => {
        console.error("[renderer] steerQueuedComposerMessage failed", error);
      },
    );
  };

  const handleAttachmentDrop = (
    event: DragEvent<HTMLDivElement>,
    onFiles: (files: File[]) => void,
  ) => {
    event.preventDefault();
    const files = extractFilesFromDataTransfer(event.dataTransfer);
    if (files.length === 0) {
      return;
    }
    onFiles(files);
  };

  async function addAttachmentsToSessionComposer(files: File[]) {
    if (!api) {
      return;
    }
    const valid = await readComposerAttachmentsFromFiles(
      files,
      snapshot?.composerAttachments ?? [],
    );
    if (valid.length === 0) {
      return;
    }
    void updateSnapshot(setSnapshot, () => api.addComposerAttachments(valid)).catch(
      (error: unknown) => {
        console.error("[renderer] addComposerAttachments failed", error);
      },
    );
  }

  const handleComposerPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    handleComposerImagePaste(event, (files) => {
      void addAttachmentsToSessionComposer(files).catch((error: unknown) => {
        setComposerLimitError(error);
        console.error("[renderer] addAttachmentsToSessionComposer failed", error);
      });
    });
  };

  const handleComposerDrop = (event: DragEvent<HTMLDivElement>) => {
    handleAttachmentDrop(event, (files) => {
      void addAttachmentsToSessionComposer(files).catch((error: unknown) => {
        setComposerLimitError(error);
        console.error("[renderer] addAttachmentsToSessionComposer failed", error);
      });
    });
  };

  function setComposerLimitError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    setSnapshot((current) => (current ? { ...current, lastError: message } : current));
  }

  function handlePastedClipboardImage(clipboardImage: ClipboardImageRead) {
    if (!clipboardImage.ok) {
      if (!clipboardImage.message) {
        return;
      }
      if (document.activeElement === newThreadComposerRef.current) {
        onNewThreadComposerError(clipboardImage.message);
        return;
      }
      setComposerLimitError(clipboardImage.message);
      return;
    }
    const activeElement = document.activeElement;
    if (activeElement === composerRef.current) {
      if (!api) {
        return;
      }
      void updateSnapshot(setSnapshot, () =>
        api.addComposerAttachments([clipboardImage.attachment]),
      ).catch((error: unknown) => {
        console.error("[renderer] addComposerAttachments failed", error);
      });
      return;
    }

    if (activeElement === newThreadComposerRef.current) {
      appendNewThreadAttachment(clipboardImage.attachment);
    }
  }

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    handleClipboardImageShortcut(
      event,
      api?.readClipboardImage,
      (clipboardImage) => {
        if (!api) {
          return;
        }
        void updateSnapshot(setSnapshot, () => api.addComposerAttachments([clipboardImage])).catch(
          (error: unknown) => {
            console.error("[renderer] addComposerAttachments failed", error);
          },
        );
      },
      setComposerLimitError,
    );

    if (handleMentionKeyDown(event)) {
      return;
    }

    if (handleSlashKeyDown(event)) {
      return;
    }

    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing &&
      selectedSession?.status === "running"
    ) {
      event.preventDefault();
      submitComposerDraft({ deliverAs: event.metaKey || event.ctrlKey ? "steer" : "followUp" });
      return;
    }

    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }

    event.preventDefault();
    if (
      !composerDraft.trim() &&
      composerAttachments.length === 0 &&
      annotations.list.length === 0
    ) {
      return;
    }
    if (requiresModelSelection) {
      return;
    }

    submitComposerDraft();
  };

  return {
    composerAttachments,
    submitComposerDraft,
    stopCurrentRun,
    handlePickAttachments,
    handleRemoveAttachment,
    handleEditQueuedMessage,
    handleCancelQueuedEdit,
    handleRemoveQueuedMessage,
    handleSteerQueuedMessage,
    handleComposerPaste,
    handleComposerDrop,
    handlePastedClipboardImage,
    handleComposerKeyDown,
  };
}
