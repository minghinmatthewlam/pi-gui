import { useEffect, useRef, useState, type Dispatch, type MouseEvent as ReactMouseEvent, type RefObject, type SetStateAction } from "react";
import type { DesktopAppState, WorkspaceRecord, WorktreeRecord } from "../desktop-state";
import type { PiDesktopApi } from "../ipc";

interface UseWorkspaceMenuParams {
  readonly api: PiDesktopApi | undefined;
  readonly setSnapshot: Dispatch<SetStateAction<DesktopAppState | null>>;
  readonly updateSnapshot: (
    api: PiDesktopApi,
    setSnapshot: Dispatch<SetStateAction<DesktopAppState | null>>,
    action: () => Promise<DesktopAppState>,
  ) => Promise<DesktopAppState>;
}

export interface WorkspaceMenuState {
  readonly workspaceMenuId: string | null;
  readonly workspaceRenameId: string | null;
  readonly workspaceRenameDraft: string;
  readonly setWorkspaceRenameDraft: Dispatch<SetStateAction<string>>;
  readonly expandedArchivedByWorkspace: Record<string, boolean>;
  readonly collapsedWorkspaces: Record<string, boolean>;
  readonly environmentMenuOpen: boolean;
  readonly setEnvironmentMenuOpen: Dispatch<SetStateAction<boolean>>;
  readonly workspaceMenuWrapRef: RefObject<HTMLSpanElement | null>;
  readonly workspaceRenamePanelRef: RefObject<HTMLFormElement | null>;
  readonly workspaceRenameInputRef: RefObject<HTMLInputElement | null>;
  readonly environmentMenuRef: RefObject<HTMLDivElement | null>;
  readonly openWorkspaceMenu: (workspaceId: string) => void;
  readonly closeWorkspaceMenu: () => void;
  readonly startRename: (workspace: WorkspaceRecord) => void;
  readonly submitRename: (workspace: WorkspaceRecord) => void;
  readonly cancelRename: () => void;
  readonly removeWorkspace: (workspace: WorkspaceRecord) => void;
  readonly toggleArchived: (workspaceId: string, open: boolean) => void;
  readonly toggleWorkspaceCollapsed: (workspaceId: string) => void;
  readonly expandWorkspace: (workspaceId: string) => void;
  readonly createWorktree: (workspaceId: string, fromSessionWorkspaceId?: string, fromSessionId?: string) => void;
  readonly removeWorktree: (workspaceId: string, worktree: WorktreeRecord) => void;
  readonly selectWorkspace: (workspaceId: string) => void;
  readonly runWorkspaceMenuAction: (event: ReactMouseEvent<HTMLElement>, action: () => void) => void;
}

export function useWorkspaceMenu(params: UseWorkspaceMenuParams): WorkspaceMenuState {
  const { api, setSnapshot, updateSnapshot } = params;

  const [workspaceMenuId, setWorkspaceMenuId] = useState<string | null>(null);
  const [workspaceRenameId, setWorkspaceRenameId] = useState<string | null>(null);
  const [workspaceRenameDraft, setWorkspaceRenameDraft] = useState("");
  const [expandedArchivedByWorkspace, setExpandedArchivedByWorkspace] = useState<Record<string, boolean>>({});
  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<Record<string, boolean>>({});
  const [environmentMenuOpen, setEnvironmentMenuOpen] = useState(false);

  const workspaceMenuWrapRef = useRef<HTMLSpanElement | null>(null);
  const workspaceRenamePanelRef = useRef<HTMLFormElement | null>(null);
  const workspaceRenameInputRef = useRef<HTMLInputElement | null>(null);
  const environmentMenuRef = useRef<HTMLDivElement | null>(null);

  // Focus/select rename input when rename starts
  useEffect(() => {
    if (!workspaceRenameId) {
      return undefined;
    }

    workspaceRenameInputRef.current?.focus();
    workspaceRenameInputRef.current?.select();
    return undefined;
  }, [workspaceRenameId]);

  // Click-outside / Escape handler for workspace menu, rename panel, and environment menu
  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      const menuContains = workspaceMenuWrapRef.current?.contains(target) ?? false;
      const renamePanelContains = workspaceRenamePanelRef.current?.contains(target) ?? false;
      const environmentMenuContains = environmentMenuRef.current?.contains(target) ?? false;
      if (!menuContains && !renamePanelContains && !environmentMenuContains) {
        setWorkspaceMenuId(null);
        setWorkspaceRenameId(null);
        setEnvironmentMenuOpen(false);
      }
    };

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setWorkspaceMenuId(null);
        setWorkspaceRenameId(null);
        setEnvironmentMenuOpen(false);
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
    void updateSnapshot(api, setSnapshot, () => api.renameWorkspace(workspace.id, nextName));
  };

  const cancelRename = () => {
    setWorkspaceRenameId(null);
    setWorkspaceRenameDraft("");
  };

  const removeWorkspace = (workspace: WorkspaceRecord) => {
    const confirmed = window.confirm(`Remove ${workspace.name} from pi-gui? This will not delete any files.`);
    setWorkspaceMenuId(null);
    setWorkspaceRenameId(null);
    if (!confirmed || !api) {
      return;
    }
    void updateSnapshot(api, setSnapshot, () => api.removeWorkspace(workspace.id));
  };

  const toggleArchived = (workspaceId: string, open: boolean) => {
    setExpandedArchivedByWorkspace((current) => ({ ...current, [workspaceId]: open }));
  };

  const toggleWorkspaceCollapsed = (workspaceId: string) => {
    setCollapsedWorkspaces((current) => ({ ...current, [workspaceId]: !current[workspaceId] }));
  };

  const expandWorkspace = (workspaceId: string) => {
    setCollapsedWorkspaces((current) => {
      if (!current[workspaceId]) return current;
      return { ...current, [workspaceId]: false };
    });
  };

  const createWorktree = (workspaceId: string, fromSessionWorkspaceId?: string, fromSessionId?: string) => {
    setWorkspaceMenuId(null);
    setEnvironmentMenuOpen(false);
    if (!api) {
      return;
    }
    void updateSnapshot(api, setSnapshot, () =>
      api.createWorktree({ workspaceId, fromSessionWorkspaceId, fromSessionId }),
    );
  };

  const removeWorktree = (workspaceId: string, worktree: WorktreeRecord) => {
    const confirmed = window.confirm(`Remove worktree ${worktree.name}? This removes the git worktree from disk.`);
    setEnvironmentMenuOpen(false);
    if (!confirmed || !api) {
      return;
    }
    void updateSnapshot(api, setSnapshot, () =>
      api.removeWorktree({ workspaceId, worktreeId: worktree.id }),
    );
  };

  const selectWorkspace = (workspaceId: string) => {
    setEnvironmentMenuOpen(false);
    if (!api) {
      return;
    }
    void updateSnapshot(api, setSnapshot, () => api.selectWorkspace(workspaceId));
  };

  const runWorkspaceMenuAction = (
    event: ReactMouseEvent<HTMLElement>,
    action: () => void,
  ) => {
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
    expandedArchivedByWorkspace,
    collapsedWorkspaces,
    environmentMenuOpen,
    setEnvironmentMenuOpen,
    workspaceMenuWrapRef,
    workspaceRenamePanelRef,
    workspaceRenameInputRef,
    environmentMenuRef,
    openWorkspaceMenu,
    closeWorkspaceMenu,
    startRename,
    submitRename,
    cancelRename,
    removeWorkspace,
    toggleArchived,
    toggleWorkspaceCollapsed,
    expandWorkspace,
    createWorktree,
    removeWorktree,
    selectWorkspace,
    runWorkspaceMenuAction,
  };
}
