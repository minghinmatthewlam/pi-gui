import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import type { PiDesktopApi } from "../ipc";

interface UseMentionMenuParams {
  readonly composerDraft: string;
  readonly setComposerDraft: (draft: string) => void;
  readonly composerRef: RefObject<HTMLTextAreaElement | null>;
  readonly workspaceId: string | undefined;
  readonly api: PiDesktopApi | undefined;
}

export interface MentionMenuState {
  readonly showMentionMenu: boolean;
  readonly mentionOptions: readonly string[];
  readonly selectedIndex: number;
  readonly handleMentionKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
}

export function useMentionMenu({
  composerDraft,
  setComposerDraft,
  composerRef,
  workspaceId,
  api,
}: UseMentionMenuParams): MentionMenuState {
  const [allFiles, setAllFiles] = useState<readonly string[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const mentionStartRef = useRef<number | null>(null);
  const suppressRef = useRef(false);

  // Fetch file list when workspace changes
  useEffect(() => {
    if (!api || !workspaceId) {
      setAllFiles([]);
      return;
    }
    void api.listWorkspaceFiles(workspaceId).then(setAllFiles);
  }, [api, workspaceId]);

  // Detect active @ mention
  const mentionQuery = useMemo(() => {
    if (suppressRef.current) {
      return null;
    }
    const textarea = composerRef.current;
    if (!textarea) {
      return null;
    }
    const cursorPos = textarea.selectionStart;
    const textBeforeCursor = composerDraft.slice(0, cursorPos);

    // Find the last @ not preceded by a non-whitespace char
    const atIndex = textBeforeCursor.lastIndexOf("@");
    if (atIndex < 0) {
      return null;
    }
    // @ must be at start or preceded by whitespace
    if (atIndex > 0 && !/\s/.test(textBeforeCursor[atIndex - 1] ?? "")) {
      return null;
    }
    const query = textBeforeCursor.slice(atIndex + 1);
    // No spaces allowed in query (once user types a space, the mention is done)
    if (/\s/.test(query)) {
      return null;
    }
    mentionStartRef.current = atIndex;
    return query;
  }, [composerDraft, composerRef]);

  const mentionOptions = useMemo(() => {
    if (mentionQuery === null) {
      return [];
    }
    const lowerQuery = mentionQuery.toLowerCase();
    return allFiles
      .filter((file) => file.toLowerCase().includes(lowerQuery))
      .slice(0, 10);
  }, [allFiles, mentionQuery]);

  const showMentionMenu = mentionOptions.length > 0;

  // Reset selection when options change
  useEffect(() => {
    setSelectedIndex(0);
  }, [mentionOptions.length]);

  const insertMention = useCallback(
    (filePath: string) => {
      const atIndex = mentionStartRef.current;
      if (atIndex === null) {
        return;
      }
      const textarea = composerRef.current;
      const cursorPos = textarea?.selectionStart ?? composerDraft.length;
      const before = composerDraft.slice(0, atIndex);
      const after = composerDraft.slice(cursorPos);
      const inserted = `@${filePath} `;
      setComposerDraft(`${before}${inserted}${after}`);
      suppressRef.current = true;
      // Reset suppress after a tick so next keystroke can re-trigger
      requestAnimationFrame(() => {
        suppressRef.current = false;
        const newPos = before.length + inserted.length;
        textarea?.setSelectionRange(newPos, newPos);
      });
    },
    [composerDraft, composerRef, setComposerDraft],
  );

  const handleMentionKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!showMentionMenu) {
        return false;
      }

      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % mentionOptions.length);
        return true;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + mentionOptions.length) % mentionOptions.length);
        return true;
      }
      if (event.key === "Tab" || event.key === "Enter") {
        event.preventDefault();
        const selected = mentionOptions[selectedIndex];
        if (selected) {
          insertMention(selected);
        }
        return true;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        suppressRef.current = true;
        requestAnimationFrame(() => {
          suppressRef.current = false;
        });
        return true;
      }

      return false;
    },
    [showMentionMenu, mentionOptions, selectedIndex, insertMention],
  );

  return {
    showMentionMenu,
    mentionOptions,
    selectedIndex,
    handleMentionKeyDown,
  };
}
