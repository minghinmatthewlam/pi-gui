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
import { updateSnapshot } from "../../../app/desktop-app-state";
import {
  extractFilesFromDataTransfer,
  extractImageFilesFromClipboardData,
  handleClipboardImageShortcut,
  readComposerAttachmentsFromFiles,
} from "../composer-attachments";
import { parseTreeComposerCommand } from "../composer-commands";
import type { PiDesktopApi } from "../../../../contracts/ipc";

interface UseSessionComposerParams {
  readonly api: PiDesktopApi | undefined;
  readonly snapshot: DesktopAppState | null;
  readonly setSnapshot: Dispatch<SetStateAction<DesktopAppState | null>>;
  readonly selectedSession: SessionRecord | undefined;
  readonly composerDraft: string;
  readonly setComposerDraft: Dispatch<SetStateAction<string>>;
  readonly composerDraftRef: MutableRefObject<string>;
  readonly composerRef: MutableRefObject<HTMLTextAreaElement | null>;
  readonly requiresModelSelection: boolean;
  readonly openTreeModal: () => void;
  readonly handleMentionKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  readonly handleSlashKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  readonly newThreadComposerRef: MutableRefObject<HTMLTextAreaElement | null>;
  readonly appendNewThreadAttachment: (attachment: ComposerImageAttachment) => void;
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
    composerRef,
    requiresModelSelection,
    openTreeModal,
    handleMentionKeyDown,
    handleSlashKeyDown,
    newThreadComposerRef,
    appendNewThreadAttachment,
  } = params;

  const [attachmentsClearedOnSubmit, setAttachmentsClearedOnSubmit] = useState(false);
  const composerAttachments = attachmentsClearedOnSubmit
    ? []
    : (snapshot?.composerAttachments ?? []);

  const submitComposerDraft = (options: { readonly deliverAs?: "steer" | "followUp" } = {}) => {
    if (!api || !selectedSession) {
      return;
    }

    const hasComposerInput = composerDraft.trim().length > 0 || composerAttachments.length > 0;
    if (selectedSession.status === "stopping") {
      return;
    }
    if (selectedSession.status === "running" && !hasComposerInput) {
      void updateSnapshot(setSnapshot, () => api.cancelCurrentRun()).catch((error: unknown) => {
        console.error("[renderer] cancelCurrentRun failed", error);
      });
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
    setComposerDraft("");
    setAttachmentsClearedOnSubmit(true);
    void (async () => {
      const nextState = await updateSnapshot(setSnapshot, () =>
        api.submitComposer(
          previousDraft,
          selectedSession.status === "running"
            ? { deliverAs: options.deliverAs ?? "followUp" }
            : undefined,
        ),
      );
      // Only apply the resolved draft if the user hasn't typed into the composer during the
      // in-flight submit; otherwise their new input would be clobbered.
      if (composerDraftRef.current === "") {
        setComposerDraft(nextState.composerDraft);
      }
      setAttachmentsClearedOnSubmit(false);
    })().catch(() => {
      if (composerDraftRef.current === "") {
        setComposerDraft(previousDraft);
      }
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

  const handleImagePaste = (
    event: ClipboardEvent<HTMLDivElement>,
    onFiles: (files: File[]) => void,
  ) => {
    const files = extractImageFilesFromClipboardData(event.clipboardData);
    if (files.length === 0) {
      return;
    }
    event.preventDefault();
    onFiles(files);
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
    const valid = await readComposerAttachmentsFromFiles(files);
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
    handleImagePaste(event, (files) => {
      void addAttachmentsToSessionComposer(files).catch((error: unknown) => {
        console.error("[renderer] addAttachmentsToSessionComposer failed", error);
      });
    });
  };

  const handleComposerDrop = (event: DragEvent<HTMLDivElement>) => {
    handleAttachmentDrop(event, (files) => {
      void addAttachmentsToSessionComposer(files).catch((error: unknown) => {
        console.error("[renderer] addAttachmentsToSessionComposer failed", error);
      });
    });
  };

  function handlePastedClipboardImage(clipboardImage: ComposerImageAttachment) {
    const activeElement = document.activeElement;
    if (activeElement === composerRef.current) {
      if (!api) {
        return;
      }
      void updateSnapshot(setSnapshot, () => api.addComposerAttachments([clipboardImage])).catch(
        (error: unknown) => {
          console.error("[renderer] addComposerAttachments failed", error);
        },
      );
      return;
    }

    if (activeElement === newThreadComposerRef.current) {
      appendNewThreadAttachment(clipboardImage);
    }
  }

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      handleClipboardImageShortcut(event, api?.readClipboardImage, (clipboardImage) => {
        if (!api) {
          return;
        }
        void updateSnapshot(setSnapshot, () => api.addComposerAttachments([clipboardImage])).catch(
          (error: unknown) => {
            console.error("[renderer] addComposerAttachments failed", error);
          },
        );
      })
    ) {
      return;
    }

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
    if (!composerDraft.trim() && composerAttachments.length === 0) {
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
