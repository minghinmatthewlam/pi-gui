import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import type { DesktopAppState, WorkspaceSessionTarget } from "../../../../contracts/desktop-state";
import type { PiDesktopApi } from "../../../../contracts/ipc";
import {
  nonCompletedBindingForSession,
  type ScheduledTaskRecord,
} from "../../../../contracts/scheduled-tasks";
import type { ScheduledEditorState } from "../../scheduled-tasks/scheduled-task-editor";
import {
  buildThreadActions,
  type ThreadAction,
  type ThreadActionHandlers,
  type ThreadActionSubject,
} from "../thread-actions";

interface UseThreadActionsParams {
  readonly api: PiDesktopApi | undefined;
  readonly setSnapshot: Dispatch<SetStateAction<DesktopAppState | null>>;
  readonly updateSnapshot: (
    setSnapshot: Dispatch<SetStateAction<DesktopAppState | null>>,
    action: () => Promise<DesktopAppState>,
  ) => Promise<DesktopAppState>;
  readonly scheduledTasks: readonly ScheduledTaskRecord[];
  readonly sidebarCollapsed: boolean;
  readonly openScheduledEditor: (editor: ScheduledEditorState) => void;
}

/** Where a thread menu is open: a sidebar row's right-click menu, or the thread header. */
type OpenThreadMenu =
  { readonly surface: "sidebar"; readonly sessionId: string } | { readonly surface: "header" };

export interface ThreadMenuState {
  readonly platform: NodeJS.Platform;
  readonly openMenu: OpenThreadMenu | null;
  readonly renameSessionId: string | null;
  readonly renameDraft: string;
  readonly setRenameDraft: Dispatch<SetStateAction<string>>;
  readonly menuWrapRef: RefObject<HTMLDivElement | null>;
  readonly renamePanelRef: RefObject<HTMLFormElement | null>;
  readonly renameInputRef: RefObject<HTMLInputElement | null>;
  readonly openSidebarMenu: (sessionId: string) => void;
  readonly toggleHeaderMenu: () => void;
  readonly submitRename: (subject: ThreadActionSubject) => void;
  readonly cancelRename: () => void;
  /** The shared action list every thread menu and the command palette render. */
  readonly actionsFor: (subject: ThreadActionSubject) => readonly ThreadAction[];
  /** Runs an action picked from an open menu, closing the menu first. */
  readonly runMenuAction: (action: ThreadAction) => void;
  readonly archive: (target: WorkspaceSessionTarget) => void;
  readonly restore: (target: WorkspaceSessionTarget) => void;
  readonly setPinned: (target: WorkspaceSessionTarget, pinned: boolean) => void;
}

export function useThreadActions({
  api,
  setSnapshot,
  updateSnapshot,
  scheduledTasks,
  sidebarCollapsed,
  openScheduledEditor,
}: UseThreadActionsParams): ThreadMenuState {
  const [openMenu, setOpenMenu] = useState<OpenThreadMenu | null>(null);
  const [renameSessionId, setRenameSessionId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const menuWrapRef = useRef<HTMLDivElement | null>(null);
  const renamePanelRef = useRef<HTMLFormElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (renameSessionId) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [renameSessionId]);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (!menuWrapRef.current?.contains(target) && !renamePanelRef.current?.contains(target)) {
        setOpenMenu(null);
        setRenameSessionId(null);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpenMenu(null);
        setRenameSessionId(null);
      }
    };
    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  const targetFor = (subject: ThreadActionSubject): WorkspaceSessionTarget => ({
    workspaceId: subject.workspaceId,
    sessionId: subject.session.id,
  });
  const mutate = (action: (desktopApi: PiDesktopApi) => Promise<DesktopAppState>) => {
    if (!api) return;
    void updateSnapshot(setSnapshot, () => action(api)).catch((error: unknown) => {
      console.error("[renderer] updateSnapshot failed", error);
    });
  };
  const archive = (target: WorkspaceSessionTarget) =>
    mutate((desktopApi) => desktopApi.archiveSession(target));
  const restore = (target: WorkspaceSessionTarget) =>
    mutate((desktopApi) => desktopApi.unarchiveSession(target));
  const setPinned = (target: WorkspaceSessionTarget, pinned: boolean) =>
    mutate((desktopApi) => desktopApi.setSessionPinned(target, pinned));

  const platform = api?.platform ?? "linux";
  const handlers: ThreadActionHandlers = {
    platform,
    hasScheduledTask: (subject) =>
      Boolean(nonCompletedBindingForSession(scheduledTasks, subject.session.id)),
    startRename: (subject) => {
      // The rename field lives in the sidebar row, so show the sidebar first.
      if (sidebarCollapsed) mutate((desktopApi) => desktopApi.setSidebarCollapsed(false));
      setOpenMenu(null);
      setRenameSessionId(subject.session.id);
      setRenameDraft(subject.session.title);
    },
    setPinned: (subject, pinned) => setPinned(targetFor(subject), pinned),
    archive: (subject) => archive(targetFor(subject)),
    restore: (subject) => restore(targetFor(subject)),
    markRead: (subject) => mutate((desktopApi) => desktopApi.markSessionRead(targetFor(subject))),
    openScheduledTask: (subject) => {
      const binding = nonCompletedBindingForSession(scheduledTasks, subject.session.id);
      openScheduledEditor(
        binding
          ? { mode: "edit", taskId: binding.id }
          : {
              mode: "create",
              prefill: {
                target: {
                  kind: "existing-thread",
                  workspaceId: subject.workspaceId,
                  sessionId: subject.session.id,
                },
              },
            },
      );
    },
    copySessionId: (subject) => {
      void navigator.clipboard.writeText(subject.session.id).catch((error: unknown) => {
        console.error("[renderer] navigator.clipboard.writeText failed", error);
      });
    },
  };

  return {
    platform,
    openMenu,
    renameSessionId,
    renameDraft,
    setRenameDraft,
    menuWrapRef,
    renamePanelRef,
    renameInputRef,
    openSidebarMenu: (sessionId) => {
      setRenameSessionId(null);
      setOpenMenu({ surface: "sidebar", sessionId });
    },
    toggleHeaderMenu: () => {
      setRenameSessionId(null);
      setOpenMenu((current) => (current?.surface === "header" ? null : { surface: "header" }));
    },
    submitRename: (subject) => {
      const nextTitle = renameDraft.trim();
      setRenameSessionId(null);
      setRenameDraft("");
      if (!nextTitle || nextTitle === subject.session.title) return;
      mutate((desktopApi) => desktopApi.renameSession(targetFor(subject), nextTitle));
    },
    cancelRename: () => {
      setRenameSessionId(null);
      setRenameDraft("");
    },
    actionsFor: (subject) => buildThreadActions(subject, handlers),
    runMenuAction: (action) => {
      setOpenMenu(null);
      action.run();
    },
    archive,
    restore,
    setPinned,
  };
}
