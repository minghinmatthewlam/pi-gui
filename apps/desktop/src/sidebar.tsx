import { forwardRef, useState, type CSSProperties } from "react";
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
import { arrayMove, SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { AppView, SessionRecord, WorkspaceRecord, WorktreeRecord } from "./desktop-state";
import { ArchiveIcon, ChevronDownIcon, ExtensionIcon, FolderIcon, PackageIcon, PinIcon, PlusIcon, RestoreIcon, SettingsIcon, SkillIcon, WorktreeIcon } from "./icons";
import type { PiDesktopApi } from "./ipc";
import { formatRelativeTime } from "./string-utils";
import type { WorkspaceMenuState } from "./hooks/use-workspace-menu";
import { comparePinnedThreads, sessionThreadKey, type ThreadGroup, type ThreadListEntry } from "./thread-groups";
import type { Dispatch, SetStateAction } from "react";
import type { DesktopAppState } from "./desktop-state";

interface SidebarProps {
  readonly activeView: AppView;
  readonly selectedWorkspace: WorkspaceRecord | undefined;
  readonly selectedSession: SessionRecord | undefined;
  readonly visibleWorkspaces: readonly WorkspaceRecord[];
  readonly threadGroups: readonly ThreadGroup[];
  readonly pinnedSessionOrder: readonly string[];
  readonly linkedWorktreeByWorkspaceId: ReadonlyMap<string, WorktreeRecord>;
  readonly wsMenu: WorkspaceMenuState;
  readonly api: PiDesktopApi;
  readonly setSnapshot: Dispatch<SetStateAction<DesktopAppState | null>>;
  readonly updateSnapshot: (
    api: PiDesktopApi,
    setSnapshot: Dispatch<SetStateAction<DesktopAppState | null>>,
    action: () => Promise<DesktopAppState>,
  ) => Promise<DesktopAppState>;
  readonly onNewThread: () => void;
  readonly onSetActiveView: (view: AppView) => void;
  readonly onOpenSkills: (workspaceId?: string) => void;
  readonly onOpenExtensions: (workspaceId?: string) => void;
  readonly onOpenPackages: (workspaceId?: string) => void;
  readonly onOpenSettings: (workspaceId?: string) => void;
  readonly onArchiveSession: (target: { workspaceId: string; sessionId: string }) => void;
  readonly onSelectSession: (target: { workspaceId: string; sessionId: string }) => void;
  readonly onSetSessionPinned: (target: { workspaceId: string; sessionId: string }, pinned: boolean) => void;
  readonly onUnarchiveSession: (target: { workspaceId: string; sessionId: string }) => void;
}

export function Sidebar(props: SidebarProps) {
  const {
    activeView,
    selectedWorkspace,
    selectedSession,
    visibleWorkspaces,
    threadGroups,
    pinnedSessionOrder,
    linkedWorktreeByWorkspaceId,
    wsMenu,
    api,
    setSnapshot,
    updateSnapshot,
    onNewThread,
    onSetActiveView,
    onOpenSkills,
    onOpenExtensions,
    onOpenPackages,
    onOpenSettings,
    onArchiveSession,
    onSelectSession,
    onSetSessionPinned,
    onUnarchiveSession,
  } = props;

  const [activeId, setActiveId] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const pinnedSortableId = (thread: ThreadListEntry) => `pinned:${sessionThreadKey(thread)}`;
  const pinnedSessionKeyFromSortableId = (id: string) => id.startsWith("pinned:") ? id.slice("pinned:".length) : id;

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
      return closest ? [{ id: closest.id, data: { droppableContainer: args.droppableContainers.find((c) => String(c.id) === closest!.id)! } }] : [];
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
    return closest ? [{ id: closest.id, data: { droppableContainer: args.droppableContainers.find((c) => String(c.id) === closest!.id)! } }] : [];
  };

  const rootGroups = threadGroups.filter((g) => g.rootWorkspace.kind === "primary");
  const orphanGroups = threadGroups.filter((g) => g.rootWorkspace.kind !== "primary");
  const pinnedThreads = threadGroups
    .flatMap((group) => group.pinnedThreads)
    .sort((left, right) => comparePinnedThreads(left, right, pinnedSessionOrder));
  const pinnedSortableIds = pinnedThreads.map(pinnedSortableId);
  const rootGroupIds = rootGroups.map((g) => g.rootWorkspace.id);
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

      const newOrder = arrayMove(pinnedSortableIds, oldIndex, newIndex).map(pinnedSessionKeyFromSortableId);
      setSnapshot((prev) => prev ? { ...prev, pinnedSessionOrder: newOrder } : prev);
      void api.reorderPinnedSessions(newOrder);
      return;
    }

    const oldIndex = rootGroupIds.indexOf(String(active.id));
    const newIndex = rootGroupIds.indexOf(String(over.id));
    if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return;

    const newOrder = arrayMove(rootGroupIds, oldIndex, newIndex);
    // Optimistically update local state to avoid snap-back animation
    setSnapshot((prev) => prev ? { ...prev, workspaceOrder: newOrder } : prev);
    void api.reorderWorkspaces(newOrder);
  }

  const activeGroup = activeId ? rootGroups.find((g) => g.rootWorkspace.id === activeId) : undefined;
  const activePinnedThread = activeId?.startsWith("pinned:")
    ? pinnedThreads.find((thread) => pinnedSortableId(thread) === activeId)
    : undefined;

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
            className="sidebar__nav-item"
            type="button"
            onClick={() => onOpenSkills(selectedWorkspace?.rootWorkspaceId ?? selectedWorkspace?.id)}
          >
            <SkillIcon />
            <span>Skills</span>
          </button>
          <button
            className="sidebar__nav-item"
            type="button"
            onClick={() => onOpenExtensions(selectedWorkspace?.rootWorkspaceId ?? selectedWorkspace?.id)}
          >
            <ExtensionIcon />
            <span>Extensions</span>
          </button>
          <button
            className="sidebar__nav-item"
            type="button"
            onClick={() => onOpenPackages(selectedWorkspace?.rootWorkspaceId ?? selectedWorkspace?.id)}
          >
            <PackageIcon />
            <span>Packages</span>
          </button>
          <button
            className="sidebar__nav-item"
            type="button"
            onClick={() => onOpenSettings(selectedWorkspace?.rootWorkspaceId ?? selectedWorkspace?.id)}
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
            <button
              aria-label="Open folder"
              className="icon-button"
              type="button"
              onClick={() => {
                void updateSnapshot(api, setSnapshot, () => api.pickWorkspace());
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
                void updateSnapshot(api, setSnapshot, () => api.pickWorkspace());
              }}
            >
              Open first folder
            </button>
          </div>
        ) : (
          <DndContext sensors={sensors} collisionDetection={headerCollision} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
            <div className="workspace-list" data-testid="workspace-list">
              {pinnedThreads.length > 0 ? (
                <PinnedThreadsSection
                  pinnedThreads={pinnedThreads}
                  sortableIds={pinnedSortableIds}
                  sortableIdForThread={pinnedSortableId}
                  selectedWorkspace={selectedWorkspace}
                  selectedSession={selectedSession}
                  onArchiveSession={onArchiveSession}
                  onSelectSession={onSelectSession}
                  onSetSessionPinned={onSetSessionPinned}
                />
              ) : null}
              <SortableContext items={rootGroupIds} strategy={verticalListSortingStrategy}>
                {rootGroups.map((group) => (
                  <SortableWorkspaceGroup
                    key={group.rootWorkspace.id}
                    group={group}
                    canDrag={canDrag}
                    selectedWorkspace={selectedWorkspace}
                    selectedSession={selectedSession}
                    linkedWorktreeByWorkspaceId={linkedWorktreeByWorkspaceId}
                    wsMenu={wsMenu}
                    api={api}
                    onArchiveSession={onArchiveSession}
                    onSelectSession={onSelectSession}
                    onSetSessionPinned={onSetSessionPinned}
                    onUnarchiveSession={onUnarchiveSession}
                  />
                ))}
              </SortableContext>
              {orphanGroups.map((group) => (
                <WorkspaceGroupContent
                  key={group.rootWorkspace.id}
                  group={group}
                  canDrag={false}
                  selectedWorkspace={selectedWorkspace}
                  selectedSession={selectedSession}
                  linkedWorktreeByWorkspaceId={linkedWorktreeByWorkspaceId}
                  wsMenu={wsMenu}
                  api={api}
                  onArchiveSession={onArchiveSession}
                  onSelectSession={onSelectSession}
                  onSetSessionPinned={onSetSessionPinned}
                  onUnarchiveSession={onUnarchiveSession}
                />
              ))}
            </div>
            <DragOverlay>
              {activePinnedThread ? (
                <ThreadSessionRow
                  active={activePinnedThread.workspaceId === selectedWorkspace?.id && activePinnedThread.session.id === selectedSession?.id}
                  thread={activePinnedThread}
                  showContext
                  overlay
                  onAction={() => undefined}
                  onSelect={() => undefined}
                  onTogglePinned={() => undefined}
                />
              ) : activeGroup ? (
                <div className="workspace-group workspace-group--overlay">
                  <WorkspaceGroupContent
                    group={activeGroup}
                    canDrag={false}
                    selectedWorkspace={selectedWorkspace}
                    selectedSession={selectedSession}
                    linkedWorktreeByWorkspaceId={linkedWorktreeByWorkspaceId}
                    wsMenu={wsMenu}
                    api={api}
                    onArchiveSession={onArchiveSession}
                    onSelectSession={onSelectSession}
                    onSetSessionPinned={onSetSessionPinned}
                    onUnarchiveSession={onUnarchiveSession}
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

/* ── Sortable workspace group wrapper ──────────────────── */

interface WorkspaceGroupProps {
  readonly group: ThreadGroup;
  readonly canDrag: boolean;
  readonly selectedWorkspace: WorkspaceRecord | undefined;
  readonly selectedSession: SessionRecord | undefined;
  readonly linkedWorktreeByWorkspaceId: ReadonlyMap<string, WorktreeRecord>;
  readonly wsMenu: WorkspaceMenuState;
  readonly api: PiDesktopApi;
  readonly onArchiveSession: (target: { workspaceId: string; sessionId: string }) => void;
  readonly onSelectSession: (target: { workspaceId: string; sessionId: string }) => void;
  readonly onSetSessionPinned: (target: { workspaceId: string; sessionId: string }, pinned: boolean) => void;
  readonly onUnarchiveSession: (target: { workspaceId: string; sessionId: string }) => void;
}

function SortableWorkspaceGroup(props: WorkspaceGroupProps) {
  const { group, wsMenu } = props;
  const isRenaming = wsMenu.workspaceRenameId === group.rootWorkspace.id;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: group.rootWorkspace.id,
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
    >
      <WorkspaceGroupContent
        {...props}
        dragHandleProps={props.canDrag && !isRenaming ? { attributes, listeners } : undefined}
      />
    </section>
  );
}

/* ── Workspace group content (used both inline and in overlay) ──── */

interface DragHandleProps {
  readonly attributes: DraggableAttributes;
  readonly listeners: DraggableSyntheticListeners;
}

function WorkspaceGroupContent(
  props: WorkspaceGroupProps & { readonly dragHandleProps?: DragHandleProps },
) {
  const {
    group: { rootWorkspace, threads, archivedThreads },
    selectedWorkspace,
    selectedSession,
    linkedWorktreeByWorkspaceId,
    wsMenu,
    api,
    onArchiveSession,
    onSelectSession,
    onSetSessionPinned,
    onUnarchiveSession,
    dragHandleProps,
  } = props;

  const workspaceActive =
    rootWorkspace.id === selectedWorkspace?.id ||
    rootWorkspace.id === selectedWorkspace?.rootWorkspaceId;
  const linkedWorktree = linkedWorktreeByWorkspaceId.get(rootWorkspace.id);
  const archivedSectionOpen = wsMenu.expandedArchivedByWorkspace[rootWorkspace.id] ?? false;
  const isCollapsed = wsMenu.collapsedWorkspaces[rootWorkspace.id] ?? false;

  return (
    <>
      <div className={`workspace-row ${workspaceActive ? "workspace-row--active" : ""}`}>
        <button
          className={`workspace-row__select ${dragHandleProps ? "workspace-row__select--draggable" : ""}`}
          onClick={() => {
            wsMenu.selectWorkspace(rootWorkspace.id);
            wsMenu.toggleWorkspaceCollapsed(rootWorkspace.id);
          }}
          type="button"
          {...(dragHandleProps ? { ...dragHandleProps.attributes, ...dragHandleProps.listeners } : {})}
        >
          <span className="workspace-row__icon" aria-hidden="true" data-collapsed={isCollapsed || undefined}>
            <span className="workspace-row__icon-folder"><FolderIcon /></span>
            <span className="workspace-row__icon-chevron"><ChevronDownIcon /></span>
          </span>
          <span className="workspace-row__name">{rootWorkspace.name}</span>
        </button>
        <span
          className="workspace-row__menu-wrap"
          ref={wsMenu.workspaceMenuId === rootWorkspace.id ? wsMenu.workspaceMenuWrapRef : undefined}
        >
          <button
            aria-label={`Workspace actions for ${rootWorkspace.name}`}
            aria-haspopup="menu"
            className="icon-button workspace-row__menu-button"
            aria-expanded={wsMenu.workspaceMenuId === rootWorkspace.id}
            type="button"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              wsMenu.openWorkspaceMenu(rootWorkspace.id);
            }}
          >
            …
          </button>
          {wsMenu.workspaceMenuId === rootWorkspace.id ? (
            <div className="workspace-menu">
              <button
                className="workspace-menu__item"
                type="button"
                onClick={(event) =>
                  wsMenu.runWorkspaceMenuAction(event, () => {
                    void api.openWorkspaceInFinder(rootWorkspace.id);
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
                      wsMenu.removeWorktree(linkedWorktree.rootWorkspaceId || rootWorkspace.id, linkedWorktree),
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
                    wsMenu.runWorkspaceMenuAction(event, () => wsMenu.createWorktree(rootWorkspace.id))
                  }
                >
                  Create permanent worktree
                </button>
              )}
              <button
                className="workspace-menu__item"
                type="button"
                onClick={(event) => wsMenu.runWorkspaceMenuAction(event, () => wsMenu.startRename(rootWorkspace))}
              >
                Edit name
              </button>
              <button
                className="workspace-menu__item workspace-menu__item--danger"
                type="button"
                onClick={(event) => wsMenu.runWorkspaceMenuAction(event, () => wsMenu.removeWorkspace(rootWorkspace))}
              >
                Remove
              </button>
            </div>
          ) : null}
        </span>
      </div>
      {wsMenu.workspaceRenameId === rootWorkspace.id ? (
        <form
          className="workspace-rename"
          ref={wsMenu.workspaceRenamePanelRef}
          onSubmit={(event) => {
            event.preventDefault();
            wsMenu.submitRename(rootWorkspace);
          }}
        >
          <input
            aria-label={`Rename ${rootWorkspace.name}`}
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
            <button className="workspace-rename__button" type="button" onClick={wsMenu.cancelRename}>
              Cancel
            </button>
            <button className="workspace-rename__button workspace-rename__button--primary" type="submit">
              Save
            </button>
          </div>
        </form>
      ) : null}
      {!isCollapsed ? (
        <>
          <div className="session-list">
            {threads.map((thread) => {
              const active = thread.workspaceId === selectedWorkspace?.id && thread.session.id === selectedSession?.id;
              return (
                <ThreadSessionRow
                  key={`${thread.workspaceId}:${thread.session.id}`}
                  active={active}
                  thread={thread}
                  onAction={() =>
                    onArchiveSession({
                      workspaceId: thread.workspaceId,
                      sessionId: thread.session.id,
                    })
                  }
                  onSelect={() => onSelectSession({ workspaceId: thread.workspaceId, sessionId: thread.session.id })}
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
          {archivedThreads.length > 0 ? (
            <div className="archived-thread-group">
              <button
                aria-expanded={archivedSectionOpen}
                className="archived-thread-group__toggle"
                type="button"
                onClick={() => wsMenu.toggleArchived(rootWorkspace.id, !archivedSectionOpen)}
              >
                <span
                  aria-hidden="true"
                  className={`archived-thread-group__chevron ${archivedSectionOpen ? "archived-thread-group__chevron--open" : ""}`}
                >
                  <ChevronDownIcon />
                </span>
                <span>Archived</span>
                <span className="archived-thread-group__count">{archivedThreads.length}</span>
              </button>
              {archivedSectionOpen ? (
                <div className="session-list session-list--archived">
                  {archivedThreads.map((thread) => {
                    const active =
                      thread.workspaceId === selectedWorkspace?.id && thread.session.id === selectedSession?.id;
                    return (
                      <ThreadSessionRow
                        key={`${thread.workspaceId}:${thread.session.id}`}
                        active={active}
                        archived
                        thread={thread}
                        onAction={() =>
                          onUnarchiveSession({
                            workspaceId: thread.workspaceId,
                            sessionId: thread.session.id,
                          })
                        }
                        onSelect={() => onSelectSession({ workspaceId: thread.workspaceId, sessionId: thread.session.id })}
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
          ) : null}
        </>
      ) : null}
    </>
  );
}

function PinnedThreadsSection({
  pinnedThreads,
  sortableIds,
  sortableIdForThread,
  selectedWorkspace,
  selectedSession,
  onArchiveSession,
  onSelectSession,
  onSetSessionPinned,
}: {
  readonly pinnedThreads: readonly ThreadListEntry[];
  readonly sortableIds: readonly string[];
  readonly sortableIdForThread: (thread: ThreadListEntry) => string;
  readonly selectedWorkspace: WorkspaceRecord | undefined;
  readonly selectedSession: SessionRecord | undefined;
  readonly onArchiveSession: (target: { workspaceId: string; sessionId: string }) => void;
  readonly onSelectSession: (target: { workspaceId: string; sessionId: string }) => void;
  readonly onSetSessionPinned: (target: { workspaceId: string; sessionId: string }, pinned: boolean) => void;
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
            const active = thread.workspaceId === selectedWorkspace?.id && thread.session.id === selectedSession?.id;
            return (
              <SortablePinnedThreadRow
                key={`${thread.workspaceId}:${thread.session.id}`}
                id={sortableIdForThread(thread)}
                active={active}
                thread={thread}
                onAction={() =>
                  onArchiveSession({
                    workspaceId: thread.workspaceId,
                    sessionId: thread.session.id,
                  })
                }
                onSelect={() => onSelectSession({ workspaceId: thread.workspaceId, sessionId: thread.session.id })}
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
  onAction,
  onSelect,
  onTogglePinned,
}: {
  readonly id: string;
  readonly active: boolean;
  readonly thread: ThreadListEntry;
  readonly onAction: () => void;
  readonly onSelect: () => void;
  readonly onTogglePinned: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
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

function sessionIndicatorVariant(thread: ThreadListEntry): "running" | "unseen" | "none" {
  if (thread.session.status === "running") {
    return "running";
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
  readonly onAction: () => void;
  readonly onSelect: () => void;
  readonly onTogglePinned: () => void;
}

const ThreadSessionRow = forwardRef<HTMLDivElement, ThreadSessionRowProps>(function ThreadSessionRow({
  active,
  archived = false,
  showContext = false,
  overlay = false,
  dragging = false,
  style,
  dragAttributes,
  dragListeners,
  thread,
  onAction,
  onSelect,
  onTogglePinned,
}, ref) {
  const indicatorVariant = sessionIndicatorVariant(thread);
  const pinned = Boolean(thread.session.pinnedAt);
  const actionContext = showContext ? ` in ${thread.contextLabel}` : "";
  const classes = [
    "session-row",
    active ? "session-row--active" : "",
    pinned ? "session-row--pinned" : "",
    dragging ? "session-row--dragging" : "",
    overlay ? "session-row--overlay" : "",
  ].filter(Boolean).join(" ");
  return (
    <div
      ref={ref}
      style={style}
      className={classes}
      data-sidebar-indicator={indicatorVariant}
      data-session-pinned={pinned ? "true" : "false"}
      data-session-id={thread.session.id}
    >
      <button
        className="session-row__select"
        onClick={onSelect}
        type="button"
        {...dragAttributes}
        {...dragListeners}
      >
        <span className="session-row__leading" aria-hidden="true">
          {indicatorVariant === "running" ? <span className="session-row__status session-row__status--running" /> : null}
          {indicatorVariant === "unseen" ? <span className="session-row__status session-row__status--unseen" /> : null}
        </span>
        <span className="session-row__body">
          <span className="session-row__title-line">
            <span className="session-row__title">{thread.session.title}</span>
          </span>
          {showContext ? <span className="session-row__context">{thread.contextLabel}</span> : null}
          {thread.session.preview ? <span className="session-row__preview">{thread.session.preview}</span> : null}
        </span>
      </button>
      <span className="session-row__trailing">
        {thread.environment.kind === "worktree" ? (
          <span className="session-row__workspace-icon" aria-hidden="true" title="Worktree">
            <WorktreeIcon />
          </span>
        ) : null}
        <span className="session-row__time">{formatRelativeTime(thread.session.updatedAt)}</span>
        {!archived ? (
          <button
            aria-label={`${pinned ? "Unpin" : "Pin"} ${thread.session.title}${actionContext}`}
            aria-pressed={pinned}
            className="icon-button session-row__action session-row__pin-action"
            type="button"
            onClick={onTogglePinned}
          >
            <PinIcon filled={pinned} />
          </button>
        ) : null}
        <button
          aria-label={`${archived ? "Restore" : "Archive"} ${thread.session.title}${actionContext}`}
          className="icon-button session-row__action"
          type="button"
          onClick={onAction}
        >
          {archived ? <RestoreIcon /> : <ArchiveIcon />}
        </button>
      </span>
    </div>
  );
});
