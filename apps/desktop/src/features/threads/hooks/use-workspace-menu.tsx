import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  type SetStateAction,
} from "react";
import type {
  DesktopAppState,
  WorkspaceRecord,
  WorktreeRecord,
} from "../../../../contracts/desktop-state";
import type { PiDesktopApi } from "../../../../contracts/ipc";

interface UseWorkspaceMenuParams {
  readonly api: PiDesktopApi | undefined;
  readonly setSnapshot: Dispatch<SetStateAction<DesktopAppState | null>>;
  readonly updateSnapshot: (
    setSnapshot: Dispatch<SetStateAction<DesktopAppState | null>>,
    action: () => Promise<DesktopAppState>,
  ) => Promise<DesktopAppState>;
}

export interface WorkspaceMenuState {
  readonly workspaceMenuId: string | null;
  readonly workspaceRenameId: string | null;
  readonly workspaceRenameDraft: string;
  readonly setWorkspaceRenameDraft: Dispatch<SetStateAction<string>>;
  readonly workspaceMenuWrapRef: RefObject<HTMLSpanElement | null>;
  readonly workspaceRenamePanelRef: RefObject<HTMLFormElement | null>;
  readonly workspaceRenameInputRef: RefObject<HTMLInputElement | null>;
  readonly openWorkspaceMenu: (workspaceId: string) => void;
  readonly closeWorkspaceMenu: () => void;
  readonly startRename: (workspace: WorkspaceRecord) => void;
  readonly submitRename: (workspace: WorkspaceRecord) => void;
  readonly cancelRename: () => void;
  readonly removeWorkspace: (workspace: WorkspaceRecord) => void;
  readonly createWorktree: (
    workspaceId: string,
    fromSessionWorkspaceId?: string,
    fromSessionId?: string,
  ) => void;
  readonly removeWorktree: (workspaceId: string, worktree: WorktreeRecord) => void;
  readonly selectWorkspace: (workspaceId: string) => void;
  readonly runWorkspaceMenuAction: (
    event: ReactMouseEvent<HTMLElement>,
    action: () => void,
  ) => void;
}

export function useWorkspaceMenu(params: UseWorkspaceMenuParams): WorkspaceMenuState {
  const { api, setSnapshot, updateSnapshot } = params;

  const [workspaceMenuId, setWorkspaceMenuId] = useState<string | null>(null);
  const [workspaceRenameId, setWorkspaceRenameId] = useState<string | null>(null);
  const [workspaceRenameDraft, setWorkspaceRenameDraft] = useState("");

  const workspaceMenuWrapRef = useRef<HTMLSpanElement | null>(null);
  const workspaceRenamePanelRef = useRef<HTMLFormElement | null>(null);
  const workspaceRenameInputRef = useRef<HTMLInputElement | null>(null);

  // Focus/select rename input when rename starts
  useEffect(() => {
    if (!workspaceRenameId) {
      return undefined;
    }

    workspaceRenameInputRef.current?.focus();
    workspaceRenameInputRef.current?.select();
    return undefined;
  }, [workspaceRenameId]);

  // Click-outside / Escape handler for workspace menu and rename panel
  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      const menuContains = workspaceMenuWrapRef.current?.contains(target) ?? false;
      const renamePanelContains = workspaceRenamePanelRef.current?.contains(target) ?? false;
      if (!menuContains && !renamePanelContains) {
        setWorkspaceMenuId(null);
        setWorkspaceRenameId(null);
      }
    };

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setWorkspaceMenuId(null);
        setWorkspaceRenameId(null);
      }
    };

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  const openWorkspaceMenu = (workspaceId: string) => {
    setWorkspaceMenuId((current) => (current === workspaceId ? null : workspaceId));
  };

  const closeWorkspaceMenu = () => {
    setWorkspaceMenuId(null);
  };

  const startRename = (workspace: WorkspaceRecord) => {
    setWorkspaceMenuId(null);
    setWorkspaceRenameId(workspace.id);
    setWorkspaceRenameDraft(workspace.name);
  };

  const submitRename = (workspace: WorkspaceRecord) => {
    const nextName = workspaceRenameDraft.trim();
    setWorkspaceMenuId(null);
    setWorkspaceRenameId(null);
    if (!nextName || nextName === workspace.name) {
      setWorkspaceRenameDraft("");
      return;
    }
    setWorkspaceRenameDraft("");
    if (!api) {
      return;
    }
    void updateSnapshot(setSnapshot, () => api.renameWorkspace(workspace.id, nextName)).catch(
      (error: unknown) => {
        console.error("[renderer] renameWorkspace failed", error);
      },
    );
  };

  const cancelRename = () => {
    setWorkspaceRenameId(null);
    setWorkspaceRenameDraft("");
  };

  const removeWorkspace = (workspace: WorkspaceRecord) => {
    const confirmed = window.confirm(
      `Remove ${workspace.name} from pi-gui? This will not delete any files.`,
    );
    setWorkspaceMenuId(null);
    setWorkspaceRenameId(null);
    if (!confirmed || !api) {
      return;
    }
    void updateSnapshot(setSnapshot, () => api.removeWorkspace(workspace.id)).catch(
      (error: unknown) => {
        console.error("[renderer] removeWorkspace failed", error);
      },
    );
  };

  const createWorktree = (
    workspaceId: string,
    fromSessionWorkspaceId?: string,
    fromSessionId?: string,
  ) => {
    setWorkspaceMenuId(null);
    if (!api) {
      return;
    }
    void updateSnapshot(setSnapshot, () =>
      api.createWorktree({ workspaceId, fromSessionWorkspaceId, fromSessionId }),
    ).catch((error: unknown) => {
      console.error("[renderer] updateSnapshot failed", error);
    });
  };

  const removeWorktree = (workspaceId: string, worktree: WorktreeRecord) => {
    const confirmed = window.confirm(
      `Remove worktree ${worktree.name}? This removes the git worktree from disk.`,
    );
    if (!confirmed || !api) {
      return;
    }
    void updateSnapshot(setSnapshot, () =>
      api.removeWorktree({ workspaceId, worktreeId: worktree.id }),
    ).catch((error: unknown) => {
      console.error("[renderer] updateSnapshot failed", error);
    });
  };

  const selectWorkspace = (workspaceId: string) => {
    if (!api) {
      return;
    }
    void updateSnapshot(setSnapshot, () => api.selectWorkspace(workspaceId)).catch(
      (error: unknown) => {
        console.error("[renderer] selectWorkspace failed", error);
      },
    );
  };

  const runWorkspaceMenuAction = (event: ReactMouseEvent<HTMLElement>, action: () => void) => {
    event.preventDefault();
    event.stopPropagation();
    setWorkspaceMenuId(null);
    action();
  };

  return {
    workspaceMenuId,
    workspaceRenameId,
    workspaceRenameDraft,
    setWorkspaceRenameDraft,
    workspaceMenuWrapRef,
    workspaceRenamePanelRef,
    workspaceRenameInputRef,
    openWorkspaceMenu,
    closeWorkspaceMenu,
    startRename,
    submitRename,
    cancelRename,
    removeWorkspace,
    createWorktree,
    removeWorktree,
    selectWorkspace,
    runWorkspaceMenuAction,
  };
}
