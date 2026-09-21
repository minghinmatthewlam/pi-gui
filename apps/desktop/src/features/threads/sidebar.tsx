import {
  forwardRef,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DraggableAttributes,
  type DraggableSyntheticListeners,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type {
  AppView,
  SessionRecord,
  ThreadGrouping,
  WorkspaceRecord,
  WorktreeRecord,
} from "../../../contracts/desktop-state";
import {
  ArchiveIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CustomizeSidebarIcon,
  ExtensionIcon,
  FolderIcon,
  PinIcon,
  PlusIcon,
  RestoreIcon,
  SettingsIcon,
  SkillIcon,
  ClockIcon,
  WorktreeIcon,
} from "../../ui/icons";
import type { PiDesktopApi } from "../../../contracts/ipc";
import { formatRelativeTime } from "../../lib/string-utils";
import { sessionLastInteractedAt } from "../../../contracts/thread-recency";
import type { WorkspaceMenuState } from "./hooks/use-workspace-menu";
import { useThreadMenu, type ThreadMenuState } from "./hooks/use-thread-menu";
import {
  sessionThreadKey,
  threadHistoryPreview,
  type RecencyThreadSection,
  type ThreadSidebarModel,
  type ThreadListEntry,
  type WorkspaceThreadGroup,
} from "./thread-groups";
import type { Dispatch, SetStateAction } from "react";
import type { DesktopAppState } from "../../../contracts/desktop-state";

interface SidebarProps {
  readonly activeView: AppView;
  readonly selectedWorkspace: WorkspaceRecord | undefined;
  readonly selectedSession: SessionRecord | undefined;
  readonly visibleWorkspaces: readonly WorkspaceRecord[];
  readonly threadSidebarModel: ThreadSidebarModel;
  readonly threadGrouping: ThreadGrouping;
  readonly linkedWorktreeByWorkspaceId: ReadonlyMap<string, WorktreeRecord>;
  readonly wsMenu: WorkspaceMenuState;
  readonly api: PiDesktopApi;
  readonly setSnapshot: Dispatch<SetStateAction<DesktopAppState | null>>;
  readonly updateSnapshot: (
    setSnapshot: Dispatch<SetStateAction<DesktopAppState | null>>,
    action: () => Promise<DesktopAppState>,
  ) => Promise<DesktopAppState>;
  readonly onNewThread: () => void;
  readonly onSetActiveView: (view: AppView) => void;
  readonly onOpenSkills: (workspaceId?: string) => void;
  readonly onOpenExtensions: (workspaceId?: string) => void;
  readonly onOpenSettings: (workspaceId?: string) => void;
  readonly onArchiveSession: (target: { workspaceId: string; sessionId: string }) => void;
  readonly onSelectSession: (target: { workspaceId: string; sessionId: string }) => void;
  readonly onSetSessionPinned: (
    target: { workspaceId: string; sessionId: string },
    pinned: boolean,
  ) => void;
  readonly onUnarchiveSession: (target: { workspaceId: string; sessionId: string }) => void;
}

const IS_MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent);
const RENAME_THREAD_SHORTCUT_HINT = IS_MAC ? "⇧⌘R" : "Ctrl+Shift+R";

export function Sidebar(props: SidebarProps) {
  const {
    activeView,
    selectedWorkspace,
    selectedSession,
    visibleWorkspaces,
    threadSidebarModel,
    threadGrouping,
    linkedWorktreeByWorkspaceId,
    wsMenu,
    api,
    setSnapshot,
    updateSnapshot,
    onNewThread,
    onSetActiveView,
    onOpenSkills,
    onOpenExtensions,
    onOpenSettings,
    onArchiveSession,
    onSelectSession,
    onSetSessionPinned,
    onUnarchiveSession,
  } = props;

  const [activeId, setActiveId] = useState<string | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [expandedHistory, setExpandedHistory] = useState<ReadonlySet<string>>(() => new Set());
  const threadMenu = useThreadMenu({ api, setSnapshot, updateSnapshot });

  // Cmd+Shift+R renames the currently selected thread (same flow as the
  // "Rename thread" context-menu item).
  useEffect(() => {
    const handleRenameShortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey) return;
      if (event.key.toLowerCase() !== "r" && event.code !== "KeyR") return;
      if (activeView !== "threads" || !selectedWorkspace || !selectedSession) return;
      const entry = [
        ...threadSidebarModel.pinnedThreads,
        ...threadSidebarModel.recencyOrder,
        ...threadSidebarModel.archivedThreads,
      ].find((t) => t.workspaceId === selectedWorkspace.id && t.session.id === selectedSession.id);
      if (!entry) return;
      event.preventDefault();
      threadMenu.startRename(entry);
    };
    window.addEventListener("keydown", handleRenameShortcut);
    return () => window.removeEventListener("keydown", handleRenameShortcut);
  }, [activeView, selectedWorkspace, selectedSession, threadSidebarModel, threadMenu]);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const pinnedSortableId = (thread: ThreadListEntry) => `pinned:${sessionThreadKey(thread)}`;
  const pinnedSessionKeyFromSortableId = (id: string) =>
    id.startsWith("pinned:") ? id.slice("pinned:".length) : id;

  // Collision detection based on workspace row headers only (~30px top of each group),
  // not the full group height including all sessions.
  const headerCollision: CollisionDetection = (args) => {
    if (String(args.active.id).startsWith("pinned:")) {
      const pointerY = args.pointerCoordinates?.y;
      if (pointerY == null) return [];
      let closest: { id: string; distance: number } | null = null;
      for (const container of args.droppableContainers) {
        const containerId = String(container.id);
        if (!containerId.startsWith("pinned:") || containerId === String(args.active.id)) {
          continue;
        }
        const rect = container.rect.current;
        if (!rect) continue;
        const rowCenter = rect.top + rect.height / 2;
        const distance = Math.abs(pointerY - rowCenter);
        if (!closest || distance < closest.distance) {
          closest = { id: containerId, distance };
        }
      }
      return closest
        ? [
            {
              id: closest.id,
              data: {
                droppableContainer: args.droppableContainers.find(
                  (c) => String(c.id) === closest!.id,
                )!,
              },
            },
          ]
        : [];
    }
    const pointerY = args.pointerCoordinates?.y;
    if (pointerY == null) return [];

    let closest: { id: string; distance: number } | null = null;
    for (const container of args.droppableContainers) {
      if (String(container.id).startsWith("pinned:")) {
        continue;
      }
      const rect = container.rect.current;
      if (!rect) continue;
      const headerCenter = rect.top + 15; // center of the ~30px workspace row header
      const distance = Math.abs(pointerY - headerCenter);
      if (!closest || distance < closest.distance) {
        closest = { id: String(container.id), distance };
      }
    }
    return closest
      ? [
          {
            id: closest.id,
            data: {
              droppableContainer: args.droppableContainers.find(
                (c) => String(c.id) === closest!.id,
              )!,
            },
          },
        ]
      : [];
  };

  const folderHasThreads = (folderId: string) =>
    threadSidebarModel.workspaceGroups.some(
      (group) => group.workspace.id === folderId && group.threads.length > 0,
    ) ||
    threadSidebarModel.pinnedThreads.some((thread) => thread.folderId === folderId) ||
    threadSidebarModel.archivedThreads.some((thread) => thread.folderId === folderId);
  const showFolderRow = (group: WorkspaceThreadGroup) =>
    threadGrouping === "workspace" || !folderHasThreads(group.workspace.id);
  const rootGroups = threadSidebarModel.workspaceGroups.filter(
    (group) => group.workspace.kind === "primary" && showFolderRow(group),
  );
  const orphanGroups = threadSidebarModel.workspaceGroups.filter(
    (group) => group.workspace.kind !== "primary" && showFolderRow(group),
  );
  const pinnedThreads = threadSidebarModel.pinnedThreads;
  const pinnedSortableIds = pinnedThreads.map(pinnedSortableId);
  const rootGroupIds = rootGroups.map((group) => group.workspace.id);
  const canDrag = rootGroups.length > 1;

  function handleDragStart(event: DragStartEvent) {
    setActiveId(String(event.active.id));
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    if (String(active.id).startsWith("pinned:")) {
      const oldIndex = pinnedSortableIds.indexOf(String(active.id));
      const newIndex = pinnedSortableIds.indexOf(String(over.id));
      if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return;

      const newOrder = arrayMove(pinnedSortableIds, oldIndex, newIndex).map(
        pinnedSessionKeyFromSortableId,
      );
      applyOptimisticReorder(
        (prev) => ({ ...prev, pinnedSessionOrder: newOrder }),
        () => api.reorderPinnedSessions(newOrder),
      );
      return;
    }

    const oldIndex = rootGroupIds.indexOf(String(active.id));
    const newIndex = rootGroupIds.indexOf(String(over.id));
    if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return;

    const newOrder = arrayMove(rootGroupIds, oldIndex, newIndex);
    applyOptimisticReorder(
      (prev) => ({ ...prev, workspaceOrder: newOrder }),
      () => api.reorderWorkspaces(newOrder),
    );
  }

  // Optimistically update local state to avoid snap-back animation, then reconcile with the
  // authoritative state the IPC call returns; roll back to the pre-reorder snapshot on rejection.
  function applyOptimisticReorder(
    optimistic: (prev: DesktopAppState) => DesktopAppState,
    commit: () => Promise<DesktopAppState>,
  ) {
    let previousSnapshot: DesktopAppState | null = null;
    setSnapshot((prev) => {
      previousSnapshot = prev;
      return prev ? optimistic(prev) : prev;
    });
    void commit().then(
      (state) => setSnapshot(state),
      () => setSnapshot(previousSnapshot),
    );
  }

  const activeFolder = activeId
    ? rootGroups.find((group) => group.workspace.id === activeId)?.workspace
    : undefined;
  const activePinnedThread = activeId?.startsWith("pinned:")
    ? pinnedThreads.find((thread) => pinnedSortableId(thread) === activeId)
    : undefined;

  function toggleHistoryExpanded(key: string) {
    setExpandedHistory((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  return (
    <aside className="sidebar">
      <div className="sidebar__top">
        <button
          className="sidebar__new"
          type="button"
          disabled={!selectedWorkspace}
          onClick={onNewThread}
        >
          <PlusIcon />
          <span>New thread</span>
        </button>

        <div className="sidebar__nav">
          <button
            className={`sidebar__nav-item ${activeView === "threads" ? "sidebar__nav-item--active" : ""}`}
            type="button"
            onClick={() => onSetActiveView("threads")}
          >
            <FolderIcon />
            <span>Threads</span>
          </button>
          <button
            className={`sidebar__nav-item ${activeView === "scheduled" ? "sidebar__nav-item--active" : ""}`}
            type="button"
            data-testid="sidebar-scheduled"
            onClick={() => onSetActiveView("scheduled")}
          >
            <ClockIcon />
            <span>Scheduled</span>
          </button>
          <button
            className="sidebar__nav-item"
            type="button"
            onClick={() =>
              onOpenSkills(selectedWorkspace?.rootWorkspaceId ?? selectedWorkspace?.id)
            }
          >
            <SkillIcon />
            <span>Skills</span>
          </button>
          <button
            className="sidebar__nav-item"
            type="button"
            onClick={() =>
              onOpenExtensions(selectedWorkspace?.rootWorkspaceId ?? selectedWorkspace?.id)
            }
          >
            <ExtensionIcon />
            <span>Extensions</span>
          </button>
          <button
            className="sidebar__nav-item"
            type="button"
            onClick={() =>
              onOpenSettings(selectedWorkspace?.rootWorkspaceId ?? selectedWorkspace?.id)
            }
          >
            <SettingsIcon />
            <span>Settings</span>
          </button>
        </div>
      </div>

      <div className="sidebar__section">
        <div className="section__head">
          <span>Threads</span>
          <div className="section__tools">
            <ThreadGroupingControl
              grouping={threadGrouping}
              onChange={(grouping) => {
                void updateSnapshot(setSnapshot, () => api.setThreadGrouping(grouping)).catch(
                  (error: unknown) => {
                    console.error("[renderer] setThreadGrouping failed", error);
                  },
                );
              }}
            />
            <button
              aria-label="Open folder"
              className="icon-button"
              type="button"
              onClick={() => {
                void updateSnapshot(setSnapshot, () => api.pickWorkspace()).catch(
                  (error: unknown) => {
                    console.error("[renderer] pickWorkspace failed", error);
                  },
                );
              }}
            >
              <FolderIcon />
            </button>
          </div>
        </div>

        {visibleWorkspaces.length === 0 ? (
          <div className="empty-state" data-testid="empty-state">
            <h2>No folders yet</h2>
            <p>Open a project folder to start building a workspace and session list.</p>
            <button
              className="button button--primary"
              type="button"
              onClick={() => {
                void updateSnapshot(setSnapshot, () => api.pickWorkspace()).catch(
                  (error: unknown) => {
                    console.error("[renderer] pickWorkspace failed", error);
                  },
                );
              }}
            >
              Open first folder
            </button>
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={headerCollision}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          >
            <div className="workspace-list" data-testid="workspace-list">
              <SortableContext items={rootGroupIds} strategy={verticalListSortingStrategy}>
                {rootGroups.map((group) => (
                  <SortableWorkspaceFolder
                    key={group.workspace.id}
                    workspace={group.workspace}
                    threads={threadGrouping === "workspace" ? group.threads : undefined}
                    historyExpanded={expandedHistory.has(`workspace:${group.workspace.id}`)}
                    onToggleHistory={() => toggleHistoryExpanded(`workspace:${group.workspace.id}`)}
                    canDrag={canDrag}
                    selectedWorkspace={selectedWorkspace}
                    selectedSession={selectedSession}
                    linkedWorktreeByWorkspaceId={linkedWorktreeByWorkspaceId}
                    wsMenu={wsMenu}
                    api={api}
                    threadMenu={threadMenu}
                    onArchiveSession={onArchiveSession}
                    onSelectSession={onSelectSession}
                    onSetSessionPinned={onSetSessionPinned}
                  />
                ))}
              </SortableContext>
              {orphanGroups.map((group) => (
                <section
                  key={group.workspace.id}
                  className="workspace-group"
                  data-workspace-id={group.workspace.id}
                >
                  <WorkspaceFolderContent
                    workspace={group.workspace}
                    threads={threadGrouping === "workspace" ? group.threads : undefined}
                    historyExpanded={expandedHistory.has(`workspace:${group.workspace.id}`)}
                    onToggleHistory={() => toggleHistoryExpanded(`workspace:${group.workspace.id}`)}
                    canDrag={false}
                    selectedWorkspace={selectedWorkspace}
                    selectedSession={selectedSession}
                    linkedWorktreeByWorkspaceId={linkedWorktreeByWorkspaceId}
                    wsMenu={wsMenu}
                    api={api}
                    threadMenu={threadMenu}
                    onArchiveSession={onArchiveSession}
                    onSelectSession={onSelectSession}
                    onSetSessionPinned={onSetSessionPinned}
                  />
                </section>
              ))}
              {pinnedThreads.length > 0 ? (
                <PinnedThreadsSection
                  pinnedThreads={pinnedThreads}
                  sortableIds={pinnedSortableIds}
                  sortableIdForThread={pinnedSortableId}
                  selectedWorkspace={selectedWorkspace}
                  selectedSession={selectedSession}
                  threadMenu={threadMenu}
                  onArchiveSession={onArchiveSession}
                  onSelectSession={onSelectSession}
                  onSetSessionPinned={onSetSessionPinned}
                />
              ) : null}
              {threadGrouping === "time"
                ? threadSidebarModel.recencySections.map((section) => (
                    <RecencyThreadSectionView
                      key={section.bucket}
                      section={section}
                      historyExpanded={expandedHistory.has(`bucket:${section.bucket}`)}
                      onToggleHistory={() => toggleHistoryExpanded(`bucket:${section.bucket}`)}
                      selectedWorkspace={selectedWorkspace}
                      selectedSession={selectedSession}
                      threadMenu={threadMenu}
                      onArchiveSession={onArchiveSession}
                      onSelectSession={onSelectSession}
                      onSetSessionPinned={onSetSessionPinned}
                    />
                  ))
                : null}
              {threadSidebarModel.archivedThreads.length > 0 ? (
                <ArchivedThreadsSection
                  archivedThreads={threadSidebarModel.archivedThreads}
                  open={archivedOpen}
                  onToggle={() => setArchivedOpen((current) => !current)}
                  selectedWorkspace={selectedWorkspace}
                  selectedSession={selectedSession}
                  threadMenu={threadMenu}
                  onUnarchiveSession={onUnarchiveSession}
                  onSelectSession={onSelectSession}
                  onSetSessionPinned={onSetSessionPinned}
                />
              ) : null}
            </div>
            <DragOverlay>
              {activePinnedThread ? (
                <ThreadSessionRow
                  active={
                    activePinnedThread.workspaceId === selectedWorkspace?.id &&
                    activePinnedThread.session.id === selectedSession?.id
                  }
                  thread={activePinnedThread}
                  showContext
                  overlay
                  onAction={() => undefined}
                  onSelect={() => undefined}
                  onTogglePinned={() => undefined}
                />
              ) : activeFolder ? (
                <div className="workspace-group workspace-group--overlay">
                  <WorkspaceFolderContent
                    workspace={activeFolder}
                    canDrag={false}
                    selectedWorkspace={selectedWorkspace}
                    linkedWorktreeByWorkspaceId={linkedWorktreeByWorkspaceId}
                    wsMenu={wsMenu}
                    api={api}
                  />
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        )}
      </div>
    </aside>
  );
}

/* ── Sortable workspace folder ─────────────────────────── */

interface WorkspaceFolderProps {
  readonly workspace: WorkspaceRecord;
  readonly threads?: readonly ThreadListEntry[];
  readonly historyExpanded?: boolean;
  readonly onToggleHistory?: () => void;
  readonly canDrag: boolean;
  readonly selectedWorkspace: WorkspaceRecord | undefined;
  readonly selectedSession?: SessionRecord;
  readonly linkedWorktreeByWorkspaceId: ReadonlyMap<string, WorktreeRecord>;
  readonly wsMenu: WorkspaceMenuState;
  readonly api: PiDesktopApi;
  readonly threadMenu?: ThreadMenuState;
  readonly onArchiveSession?: (target: { workspaceId: string; sessionId: string }) => void;
  readonly onSelectSession?: (target: { workspaceId: string; sessionId: string }) => void;
  readonly onSetSessionPinned?: (
    target: { workspaceId: string; sessionId: string },
    pinned: boolean,
  ) => void;
}

function SortableWorkspaceFolder(props: WorkspaceFolderProps) {
  const { workspace, wsMenu } = props;
  const isRenaming = wsMenu.workspaceRenameId === workspace.id;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: workspace.id,
    disabled: isRenaming,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.3 : undefined,
  };

  return (
    <section
      ref={setNodeRef}
      style={style}
      className={`workspace-group ${isDragging ? "workspace-group--dragging" : ""}`}
      data-workspace-id={workspace.id}
    >
      <WorkspaceFolderContent
        {...props}
        dragHandleProps={props.canDrag && !isRenaming ? { attributes, listeners } : undefined}
      />
    </section>
  );
}

interface DragHandleProps {
  readonly attributes: DraggableAttributes;
  readonly listeners: DraggableSyntheticListeners;
}

function WorkspaceFolderContent(
  props: WorkspaceFolderProps & { readonly dragHandleProps?: DragHandleProps },
) {
  const {
    workspace,
    threads,
    historyExpanded = false,
    onToggleHistory,
    selectedWorkspace,
    selectedSession,
    linkedWorktreeByWorkspaceId,
    wsMenu,
    api,
    threadMenu,
    onArchiveSession,
    onSelectSession,
    onSetSessionPinned,
    dragHandleProps,
  } = props;
  const history = threads ? threadHistoryPreview(threads, historyExpanded) : undefined;

  const workspaceActive =
    workspace.id === selectedWorkspace?.id || workspace.id === selectedWorkspace?.rootWorkspaceId;
  const linkedWorktree = linkedWorktreeByWorkspaceId.get(workspace.id);

  return (
    <>
      <div className={`workspace-row ${workspaceActive ? "workspace-row--active" : ""}`}>
        <button
          className={`workspace-row__select ${dragHandleProps ? "workspace-row__select--draggable" : ""}`}
          onClick={() => {
            wsMenu.selectWorkspace(workspace.id);
          }}
          type="button"
          {...(dragHandleProps
            ? { ...dragHandleProps.attributes, ...dragHandleProps.listeners }
            : {})}
        >
          <span className="workspace-row__icon" aria-hidden="true">
            <span className="workspace-row__icon-folder">
              <FolderIcon />
            </span>
          </span>
          <span className="workspace-row__name">{workspace.name}</span>
        </button>
        <span
          className="workspace-row__menu-wrap"
          ref={wsMenu.workspaceMenuId === workspace.id ? wsMenu.workspaceMenuWrapRef : undefined}
        >
          <button
            aria-label={`Workspace actions for ${workspace.name}`}
            aria-haspopup="menu"
            className="icon-button workspace-row__menu-button"
            aria-expanded={wsMenu.workspaceMenuId === workspace.id}
            type="button"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              wsMenu.openWorkspaceMenu(workspace.id);
            }}
          >
            …
          </button>
          {wsMenu.workspaceMenuId === workspace.id ? (
            <div className="workspace-menu">
              <button
                className="workspace-menu__item"
                type="button"
                onClick={(event) =>
                  wsMenu.runWorkspaceMenuAction(event, () => {
                    void api.openWorkspaceInFinder(workspace.id).catch((error: unknown) => {
                      console.error("[renderer] openWorkspaceInFinder failed", error);
                    });
                  })
                }
              >
                Open folder
              </button>
              {linkedWorktree ? (
                <button
                  className="workspace-menu__item workspace-menu__item--danger"
                  type="button"
                  onClick={(event) =>
                    wsMenu.runWorkspaceMenuAction(event, () =>
                      wsMenu.removeWorktree(
                        linkedWorktree.rootWorkspaceId || workspace.id,
                        linkedWorktree,
                      ),
                    )
                  }
                >
                  Remove worktree
                </button>
              ) : (
                <button
                  className="workspace-menu__item"
                  type="button"
                  onClick={(event) =>
                    wsMenu.runWorkspaceMenuAction(event, () => wsMenu.createWorktree(workspace.id))
                  }
                >
                  Create permanent worktree
                </button>
              )}
              <button
                className="workspace-menu__item"
                type="button"
                onClick={(event) =>
                  wsMenu.runWorkspaceMenuAction(event, () => wsMenu.startRename(workspace))
                }
              >
                Edit name
              </button>
              <button
                className="workspace-menu__item workspace-menu__item--danger"
                type="button"
                onClick={(event) =>
                  wsMenu.runWorkspaceMenuAction(event, () => wsMenu.removeWorkspace(workspace))
                }
              >
                Remove
              </button>
            </div>
          ) : null}
        </span>
      </div>
      {wsMenu.workspaceRenameId === workspace.id ? (
        <form
          className="workspace-rename"
          ref={wsMenu.workspaceRenamePanelRef}
          onSubmit={(event) => {
            event.preventDefault();
            wsMenu.submitRename(workspace);
          }}
        >
          <input
            aria-label={`Rename ${workspace.name}`}
            className="workspace-rename__input"
            ref={wsMenu.workspaceRenameInputRef}
            value={wsMenu.workspaceRenameDraft}
            onChange={(event) => {
              wsMenu.setWorkspaceRenameDraft(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                wsMenu.cancelRename();
              }
            }}
          />
          <div className="workspace-rename__actions">
            <button
              className="workspace-rename__button"
              type="button"
              onClick={wsMenu.cancelRename}
            >
              Cancel
            </button>
            <button
              className="workspace-rename__button workspace-rename__button--primary"
              type="submit"
            >
              Save
            </button>
          </div>
        </form>
      ) : null}
      {history && onSelectSession && onArchiveSession && onSetSessionPinned ? (
        <>
          <div className="session-list session-list--history">
            {history.visible.map((thread) => (
              <HistoryThreadRow
                key={`${thread.workspaceId}:${thread.session.id}`}
                thread={thread}
                selectedWorkspace={selectedWorkspace}
                selectedSession={selectedSession}
                threadMenu={threadMenu}
                onArchiveSession={onArchiveSession}
                onSelectSession={onSelectSession}
                onSetSessionPinned={onSetSessionPinned}
              />
            ))}
          </div>
          {history.overflow && onToggleHistory ? (
            <HistoryToggle
              expanded={historyExpanded}
              label={workspace.name}
              onToggle={onToggleHistory}
            />
          ) : null}
        </>
      ) : null}
    </>
  );
}

function RecencyThreadSectionView({
  section,
  historyExpanded,
  onToggleHistory,
  selectedWorkspace,
  selectedSession,
  threadMenu,
  onArchiveSession,
  onSelectSession,
  onSetSessionPinned,
}: {
  readonly section: RecencyThreadSection;
  readonly historyExpanded: boolean;
  readonly onToggleHistory: () => void;
  readonly selectedWorkspace: WorkspaceRecord | undefined;
  readonly selectedSession: SessionRecord | undefined;
  readonly threadMenu: ThreadMenuState;
  readonly onArchiveSession: (target: { workspaceId: string; sessionId: string }) => void;
  readonly onSelectSession: (target: { workspaceId: string; sessionId: string }) => void;
  readonly onSetSessionPinned: (
    target: { workspaceId: string; sessionId: string },
    pinned: boolean,
  ) => void;
}) {
  const history = threadHistoryPreview(section.threads, historyExpanded);
  return (
    <section
      className="recency-thread-group"
      aria-label={section.label}
      data-recency-bucket={section.bucket}
    >
      <div className="recency-thread-group__head">{section.label}</div>
      <div className="session-list session-list--history">
        {history.visible.map((thread) => (
          <HistoryThreadRow
            key={`${thread.workspaceId}:${thread.session.id}`}
            showContext
            thread={thread}
            selectedWorkspace={selectedWorkspace}
            selectedSession={selectedSession}
            threadMenu={threadMenu}
            onArchiveSession={onArchiveSession}
            onSelectSession={onSelectSession}
            onSetSessionPinned={onSetSessionPinned}
          />
        ))}
      </div>
      {history.overflow ? (
        <HistoryToggle
          expanded={historyExpanded}
          label={section.label}
          onToggle={onToggleHistory}
        />
      ) : null}
    </section>
  );
}

function HistoryThreadRow({
  thread,
  showContext = false,
  selectedWorkspace,
  selectedSession,
  threadMenu,
  onArchiveSession,
  onSelectSession,
  onSetSessionPinned,
}: {
  readonly thread: ThreadListEntry;
  readonly showContext?: boolean;
  readonly selectedWorkspace: WorkspaceRecord | undefined;
  readonly selectedSession: SessionRecord | undefined;
  readonly threadMenu: ThreadMenuState | undefined;
  readonly onArchiveSession: (target: { workspaceId: string; sessionId: string }) => void;
  readonly onSelectSession: (target: { workspaceId: string; sessionId: string }) => void;
  readonly onSetSessionPinned: (
    target: { workspaceId: string; sessionId: string },
    pinned: boolean,
  ) => void;
}) {
  const active =
    thread.workspaceId === selectedWorkspace?.id && thread.session.id === selectedSession?.id;
  return (
    <ThreadSessionRow
      active={active}
      showContext={showContext}
      thread={thread}
      threadMenu={threadMenu}
      onAction={() =>
        onArchiveSession({
          workspaceId: thread.workspaceId,
          sessionId: thread.session.id,
        })
      }
      onSelect={() =>
        onSelectSession({
          workspaceId: thread.workspaceId,
          sessionId: thread.session.id,
        })
      }
      onTogglePinned={() =>
        onSetSessionPinned(
          { workspaceId: thread.workspaceId, sessionId: thread.session.id },
          !thread.session.pinnedAt,
        )
      }
    />
  );
}

function HistoryToggle({
  expanded,
  label,
  onToggle,
}: {
  readonly expanded: boolean;
  readonly label: string;
  readonly onToggle: () => void;
}) {
  const text = expanded ? "Show less" : "Show more";
  return (
    <button
      aria-expanded={expanded}
      aria-label={`${text} ${label}`}
      className="thread-history-toggle"
      type="button"
      onClick={onToggle}
    >
      {text}
    </button>
  );
}

function ThreadGroupingControl({
  grouping,
  onChange,
}: {
  readonly grouping: ThreadGrouping;
  readonly onChange: (grouping: ThreadGrouping) => void;
}) {
  const [open, setOpen] = useState(false);
  const [submenuOpen, setSubmenuOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const [submenuStyle, setSubmenuStyle] = useState<CSSProperties>({});
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const groupingRef = useRef<HTMLButtonElement | null>(null);
  const submenuRef = useRef<HTMLDivElement | null>(null);
  const submenuTimer = useRef<number | null>(null);

  const closeSubmenuSoon = () => {
    if (submenuTimer.current !== null) {
      window.clearTimeout(submenuTimer.current);
    }
    submenuTimer.current = window.setTimeout(() => {
      submenuTimer.current = null;
      setSubmenuOpen(false);
    }, 140);
  };

  const keepSubmenu = () => {
    if (submenuTimer.current !== null) {
      window.clearTimeout(submenuTimer.current);
      submenuTimer.current = null;
    }
    setSubmenuOpen(true);
  };

  const closeMenu = () => {
    if (submenuTimer.current !== null) {
      window.clearTimeout(submenuTimer.current);
      submenuTimer.current = null;
    }
    setSubmenuOpen(false);
    setOpen(false);
  };

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (wrapRef.current?.contains(target) || menuRef.current?.contains(target)) {
        return;
      }
      closeMenu();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeMenu();
      }
    };
    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  useEffect(
    () => () => {
      if (submenuTimer.current !== null) {
        window.clearTimeout(submenuTimer.current);
      }
    },
    [],
  );

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) {
      return;
    }
    const rect = buttonRef.current.getBoundingClientRect();
    setMenuStyle({
      top: rect.bottom + 6,
      left: rect.right,
      right: "auto",
      width: "max-content",
      transform: "translateX(-100%)",
    });
  }, [open]);

  useLayoutEffect(() => {
    if (!submenuOpen || !groupingRef.current) {
      return;
    }
    const rect = groupingRef.current.getBoundingClientRect();
    const gap = 6;
    const width = submenuRef.current?.offsetWidth ?? 0;
    const openRight = rect.right + gap;
    const left =
      width > 0 && openRight + width > window.innerWidth - 8
        ? Math.max(8, rect.left - gap - width)
        : openRight;
    setSubmenuStyle({
      top: rect.top - 6,
      left,
      right: "auto",
      width: "max-content",
    });
  }, [submenuOpen]);

  return (
    <span className="shortcut-tooltip-wrap thread-grouping" ref={wrapRef}>
      <button
        ref={buttonRef}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Customize Sidebar"
        className="icon-button"
        type="button"
        onClick={() => {
          if (open) {
            closeMenu();
            return;
          }
          setOpen(true);
        }}
      >
        <CustomizeSidebarIcon />
      </button>
      {open ? null : (
        <span className="shortcut-tooltip" role="tooltip">
          Customize Sidebar
        </span>
      )}
      {open
        ? createPortal(
            <div ref={menuRef}>
              <div
                aria-label="Customize Sidebar"
                className="workspace-menu thread-grouping__menu"
                role="menu"
                style={menuStyle}
              >
                <button
                  ref={groupingRef}
                  aria-expanded={submenuOpen}
                  aria-haspopup="menu"
                  className={`workspace-menu__item${submenuOpen ? " thread-grouping__parent--open" : ""}`}
                  role="menuitem"
                  type="button"
                  onClick={() => {
                    keepSubmenu();
                  }}
                  onMouseEnter={keepSubmenu}
                  onMouseLeave={closeSubmenuSoon}
                >
                  <span>Grouping</span>
                  <ChevronRightIcon />
                </button>
              </div>
              {submenuOpen ? (
                <div
                  ref={submenuRef}
                  aria-label="Grouping"
                  className="workspace-menu thread-grouping__submenu"
                  role="menu"
                  style={submenuStyle}
                  onMouseEnter={keepSubmenu}
                  onMouseLeave={closeSubmenuSoon}
                >
                  {(
                    [
                      ["time", "Time"],
                      ["workspace", "Workspace"],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      aria-checked={grouping === value}
                      className="workspace-menu__item thread-grouping__option"
                      role="menuitemradio"
                      type="button"
                      onClick={() => {
                        closeMenu();
                        if (value !== grouping) {
                          onChange(value);
                        }
                      }}
                    >
                      <span aria-hidden="true" className="thread-grouping__check">
                        {grouping === value ? <CheckIcon /> : null}
                      </span>
                      {label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}

function ArchivedThreadsSection({
  archivedThreads,
  open,
  onToggle,
  selectedWorkspace,
  selectedSession,
  threadMenu,
  onUnarchiveSession,
  onSelectSession,
  onSetSessionPinned,
}: {
  readonly archivedThreads: readonly ThreadListEntry[];
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly selectedWorkspace: WorkspaceRecord | undefined;
  readonly selectedSession: SessionRecord | undefined;
  readonly threadMenu: ThreadMenuState;
  readonly onUnarchiveSession: (target: { workspaceId: string; sessionId: string }) => void;
  readonly onSelectSession: (target: { workspaceId: string; sessionId: string }) => void;
  readonly onSetSessionPinned: (
    target: { workspaceId: string; sessionId: string },
    pinned: boolean,
  ) => void;
}) {
  return (
    <div className="archived-thread-group">
      <button
        aria-expanded={open}
        className="archived-thread-group__toggle"
        type="button"
        onClick={onToggle}
      >
        <span
          aria-hidden="true"
          className={`archived-thread-group__chevron ${open ? "archived-thread-group__chevron--open" : ""}`}
        >
          <ChevronDownIcon />
        </span>
        <span>Archived</span>
        <span className="archived-thread-group__count">{archivedThreads.length}</span>
      </button>
      {open ? (
        <div className="session-list session-list--archived">
          {archivedThreads.map((thread) => {
            const active =
              thread.workspaceId === selectedWorkspace?.id &&
              thread.session.id === selectedSession?.id;
            return (
              <ThreadSessionRow
                key={`${thread.workspaceId}:${thread.session.id}`}
                active={active}
                archived
                thread={thread}
                showContext
                threadMenu={threadMenu}
                onAction={() =>
                  onUnarchiveSession({
                    workspaceId: thread.workspaceId,
                    sessionId: thread.session.id,
                  })
                }
                onSelect={() =>
                  onSelectSession({
                    workspaceId: thread.workspaceId,
                    sessionId: thread.session.id,
                  })
                }
                onTogglePinned={() =>
                  onSetSessionPinned(
                    { workspaceId: thread.workspaceId, sessionId: thread.session.id },
                    !thread.session.pinnedAt,
                  )
                }
              />
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function PinnedThreadsSection({
  pinnedThreads,
  sortableIds,
  sortableIdForThread,
  selectedWorkspace,
  selectedSession,
  threadMenu,
  onArchiveSession,
  onSelectSession,
  onSetSessionPinned,
}: {
  readonly pinnedThreads: readonly ThreadListEntry[];
  readonly sortableIds: readonly string[];
  readonly sortableIdForThread: (thread: ThreadListEntry) => string;
  readonly selectedWorkspace: WorkspaceRecord | undefined;
  readonly selectedSession: SessionRecord | undefined;
  readonly threadMenu: ThreadMenuState;
  readonly onArchiveSession: (target: { workspaceId: string; sessionId: string }) => void;
  readonly onSelectSession: (target: { workspaceId: string; sessionId: string }) => void;
  readonly onSetSessionPinned: (
    target: { workspaceId: string; sessionId: string },
    pinned: boolean,
  ) => void;
}) {
  return (
    <section className="pinned-thread-group" aria-label="Pinned threads">
      <div className="pinned-thread-group__head">
        <PinIcon filled />
        <span>Pinned</span>
      </div>
      <SortableContext items={[...sortableIds]} strategy={verticalListSortingStrategy}>
        <div className="session-list session-list--pinned">
          {pinnedThreads.map((thread) => {
            const active =
              thread.workspaceId === selectedWorkspace?.id &&
              thread.session.id === selectedSession?.id;
            return (
              <SortablePinnedThreadRow
                key={`${thread.workspaceId}:${thread.session.id}`}
                id={sortableIdForThread(thread)}
                active={active}
                thread={thread}
                threadMenu={threadMenu}
                onAction={() =>
                  onArchiveSession({
                    workspaceId: thread.workspaceId,
                    sessionId: thread.session.id,
                  })
                }
                onSelect={() =>
                  onSelectSession({ workspaceId: thread.workspaceId, sessionId: thread.session.id })
                }
                onTogglePinned={() =>
                  onSetSessionPinned(
                    { workspaceId: thread.workspaceId, sessionId: thread.session.id },
                    !thread.session.pinnedAt,
                  )
                }
              />
            );
          })}
        </div>
      </SortableContext>
    </section>
  );
}

/* ── Thread session row ────────────────────────────────── */

function SortablePinnedThreadRow({
  id,
  active,
  thread,
  threadMenu,
  onAction,
  onSelect,
  onTogglePinned,
}: {
  readonly id: string;
  readonly active: boolean;
  readonly thread: ThreadListEntry;
  readonly threadMenu: ThreadMenuState;
  readonly onAction: () => void;
  readonly onSelect: () => void;
  readonly onTogglePinned: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.3 : undefined,
  };
  return (
    <ThreadSessionRow
      ref={setNodeRef}
      style={style}
      active={active}
      thread={thread}
      threadMenu={threadMenu}
      showContext
      dragging={isDragging}
      dragAttributes={attributes}
      dragListeners={listeners}
      onAction={onAction}
      onSelect={onSelect}
      onTogglePinned={onTogglePinned}
    />
  );
}

function sessionIndicatorVariant(
  thread: ThreadListEntry,
): "running" | "failed" | "unseen" | "none" {
  if (thread.session.status === "running") {
    return "running";
  }
  if (thread.session.status === "failed") {
    return "failed";
  }
  if (thread.session.hasUnseenUpdate) {
    return "unseen";
  }
  return "none";
}

interface ThreadSessionRowProps {
  readonly active: boolean;
  readonly archived?: boolean;
  readonly showContext?: boolean;
  readonly overlay?: boolean;
  readonly dragging?: boolean;
  readonly style?: CSSProperties;
  readonly dragAttributes?: DraggableAttributes;
  readonly dragListeners?: DraggableSyntheticListeners;
  readonly thread: ThreadListEntry;
  readonly threadMenu?: ThreadMenuState;
  readonly onAction: () => void;
  readonly onSelect: () => void;
  readonly onTogglePinned: () => void;
}

const ThreadSessionRow = forwardRef<HTMLDivElement, ThreadSessionRowProps>(
  function ThreadSessionRow(
    {
      active,
      archived = false,
      showContext = false,
      overlay = false,
      dragging = false,
      style,
      dragAttributes,
      dragListeners,
      thread,
      threadMenu,
      onAction,
      onSelect,
      onTogglePinned,
    },
    ref,
  ) {
    const indicatorVariant = sessionIndicatorVariant(thread);
    const pinned = Boolean(thread.session.pinnedAt);
    const actionContext = showContext ? ` in ${thread.contextLabel}` : "";
    const classes = [
      "session-row",
      active ? "session-row--active" : "",
      pinned ? "session-row--pinned" : "",
      dragging ? "session-row--dragging" : "",
      overlay ? "session-row--overlay" : "",
    ]
      .filter(Boolean)
      .join(" ");
    return (
      <>
        <div
          ref={ref}
          style={style}
          className={classes}
          data-sidebar-indicator={indicatorVariant}
          data-session-pinned={pinned ? "true" : "false"}
          data-session-id={thread.session.id}
          onClick={() => {
            if (!dragging) onSelect();
          }}
          onContextMenu={(event) => {
            if (!threadMenu || overlay) return;
            event.preventDefault();
            event.stopPropagation();
            threadMenu.openMenu(thread.session.id);
          }}
        >
          <button
            className="session-row__select"
            onClick={(event) => {
              event.stopPropagation();
              onSelect();
            }}
            type="button"
            {...dragAttributes}
            {...dragListeners}
          >
            <span className="session-row__leading" aria-hidden="true">
              {indicatorVariant === "running" ? (
                <span className="session-row__status session-row__status--running" />
              ) : null}
              {indicatorVariant === "failed" ? (
                <span className="session-row__status session-row__status--failed" />
              ) : null}
              {indicatorVariant === "unseen" ? (
                <span className="session-row__status session-row__status--unseen" />
              ) : null}
            </span>
            <span className="session-row__body">
              <span className="session-row__title-line">
                <span className="session-row__title">{thread.session.title}</span>
              </span>
              {showContext ? (
                <span className="session-row__context">{thread.contextLabel}</span>
              ) : null}
              {thread.session.preview ? (
                <span className="session-row__preview">{thread.session.preview}</span>
              ) : null}
            </span>
          </button>
          <span className="session-row__trailing">
            {thread.environment.kind === "worktree" ? (
              <span className="session-row__workspace-icon" aria-hidden="true" title="Worktree">
                <WorktreeIcon />
              </span>
            ) : null}
            <span className="session-row__time">
              {formatRelativeTime(sessionLastInteractedAt(thread.session))}
            </span>
            <span className="session-row__action-cluster">
              {!archived ? (
                <button
                  aria-label={`${pinned ? "Unpin" : "Pin"} ${thread.session.title}${actionContext}`}
                  aria-pressed={pinned}
                  className="icon-button session-row__action session-row__pin-action"
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onTogglePinned();
                  }}
                >
                  <PinIcon filled={pinned} />
                </button>
              ) : null}
              <button
                aria-label={`${archived ? "Restore" : "Archive"} ${thread.session.title}${actionContext}`}
                className="icon-button session-row__action"
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onAction();
                }}
              >
                {archived ? <RestoreIcon /> : <ArchiveIcon />}
              </button>
              {threadMenu && !overlay ? (
                <span
                  className="session-row__menu-wrap"
                  ref={
                    threadMenu.menuSessionId === thread.session.id
                      ? threadMenu.menuWrapRef
                      : undefined
                  }
                >
                  <button
                    aria-label={`Thread actions for ${thread.session.title}${actionContext}`}
                    aria-haspopup="menu"
                    aria-expanded={threadMenu.menuSessionId === thread.session.id}
                    className="icon-button session-row__action session-row__menu-button"
                    type="button"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      threadMenu.toggleMenu(thread.session.id);
                    }}
                  >
                    …
                  </button>
                  {threadMenu.menuSessionId === thread.session.id ? (
                    <div className="workspace-menu session-row__menu" role="menu">
                      <button
                        className="workspace-menu__item"
                        type="button"
                        onClick={(event) =>
                          threadMenu.runMenuAction(event, () => threadMenu.startRename(thread))
                        }
                      >
                        <span>Rename thread</span>
                        <span className="workspace-menu__shortcut" aria-hidden="true">
                          {RENAME_THREAD_SHORTCUT_HINT}
                        </span>
                      </button>
                      <button
                        className="workspace-menu__item"
                        type="button"
                        onClick={(event) =>
                          threadMenu.runMenuAction(event, () => threadMenu.archiveOrRestore(thread))
                        }
                      >
                        {archived ? "Restore" : "Archive"}
                      </button>
                      {thread.session.hasUnseenUpdate ? (
                        <button
                          className="workspace-menu__item"
                          type="button"
                          onClick={(event) =>
                            threadMenu.runMenuAction(event, () => threadMenu.markRead(thread))
                          }
                        >
                          Mark as read
                        </button>
                      ) : null}
                      <button
                        className="workspace-menu__item"
                        type="button"
                        onClick={(event) =>
                          threadMenu.runMenuAction(event, () => threadMenu.copySessionId(thread))
                        }
                      >
                        Copy session id
                      </button>
                    </div>
                  ) : null}
                </span>
              ) : null}
            </span>
          </span>
        </div>
        {threadMenu?.renameSessionId === thread.session.id ? (
          <form
            className="workspace-rename session-rename"
            ref={threadMenu.renamePanelRef}
            onSubmit={(event) => {
              event.preventDefault();
              threadMenu.submitRename(thread);
            }}
          >
            <input
              aria-label={`Rename thread ${thread.session.title}`}
              className="workspace-rename__input"
              ref={threadMenu.renameInputRef}
              value={threadMenu.renameDraft}
              onChange={(event) => threadMenu.setRenameDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  threadMenu.cancelRename();
                }
              }}
            />
            <div className="workspace-rename__actions">
              <button
                className="workspace-rename__button"
                type="button"
                onClick={threadMenu.cancelRename}
              >
                Cancel
              </button>
              <button
                className="workspace-rename__button workspace-rename__button--primary"
                type="submit"
              >
                Save
              </button>
            </div>
          </form>
        ) : null}
      </>
    );
  },
);
