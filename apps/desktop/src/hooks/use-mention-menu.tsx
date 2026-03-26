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
  readonly insertMention: (filePath: string) => void;
}

// Match @<query> at end of string (or preceded by whitespace)
function extractMentionQuery(text: string): { query: string; atIndex: number } | null {
  // Find the last @ that could be a mention trigger
  const match = /(?:^|\s)@([^\s]*)$/.exec(text);
  if (!match) {
    return null;
  }
  const query = match[1] ?? "";
  const atIndex = text.length - query.length - 1; // position of @
  return { query, atIndex };
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
  const [suppressed, setSuppressed] = useState(false);

  // Fetch file list when workspace changes
  useEffect(() => {
    if (!api || !workspaceId) {
      setAllFiles([]);
      return;
    }
    void api.listWorkspaceFiles(workspaceId).then(setAllFiles).catch(() => setAllFiles([]));
  }, [api, workspaceId]);

  // Reset suppression when draft changes
  useEffect(() => {
    setSuppressed(false);
  }, [composerDraft]);

  // Detect active @ mention from the draft text
  const mentionMatch = useMemo(() => {
    if (suppressed) {
      return null;
    }
    return extractMentionQuery(composerDraft);
  }, [composerDraft, suppressed]);

  const mentionOptions = useMemo(() => {
    if (!mentionMatch) {
      return [];
    }
    const lowerQuery = mentionMatch.query.toLowerCase();
    return allFiles
      .filter((file) => file.toLowerCase().includes(lowerQuery))
      .slice(0, 10);
  }, [allFiles, mentionMatch]);

  const showMentionMenu = mentionOptions.length > 0;

  // Reset selection when options change
  useEffect(() => {
    setSelectedIndex(0);
  }, [mentionOptions.length]);

  const insertMention = useCallback(
    (filePath: string) => {
      if (!mentionMatch) {
        return;
      }
      const before = composerDraft.slice(0, mentionMatch.atIndex);
      const afterCursor = composerDraft.slice(mentionMatch.atIndex + 1 + mentionMatch.query.length);
      const inserted = `@${filePath} `;
      const newDraft = `${before}${inserted}${afterCursor}`;
      setComposerDraft(newDraft);
      setSuppressed(true);
      requestAnimationFrame(() => {
        const textarea = composerRef.current;
        if (textarea) {
          const newPos = before.length + inserted.length;
          textarea.setSelectionRange(newPos, newPos);
        }
      });
    },
    [composerDraft, composerRef, setComposerDraft, mentionMatch],
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
        setSuppressed(true);
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
    insertMention,
  };
}
