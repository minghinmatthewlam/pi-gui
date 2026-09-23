import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import type {
  AppView,
  DesktopAppState,
  WorkspaceSessionTarget,
} from "../../contracts/desktop-state";
import type { DesktopExtensionViewInfo } from "../../contracts/extension-views";
import {
  createChordPairGate,
  createChordToggleGate,
  CHANGES_TOGGLE_DEDUPE_MS,
  desktopCommands,
  earlyModifierChords,
  getDesktopCommandFromShortcut,
  isCloseFocusedSurfaceShortcut,
  isPaletteCommand,
  platformShortcutModifier,
  type ChordSource,
  type PiDesktopApi,
  type PiDesktopCommand,
} from "../../contracts/ipc";
import { toolRefId, type BuiltinToolKind } from "../../contracts/workbench";
import {
  buildPaletteActions,
  type PaletteAction,
  type PaletteMode,
} from "../features/command-palette/palette-actions";
import type { SettingsSection } from "../features/settings/settings-view";
import {
  visibleThreadShortcutOrder,
  type ThreadListEntry,
  type ThreadSidebarModel,
} from "../features/threads/thread-groups";
import { dismissThreadShortcutHints } from "../features/threads/thread-shortcut-hints";
import type { useWorkbench } from "../features/workbench/use-workbench";
import {
  canTogglePrimarySidebar,
  closableSurfaceFromTarget,
  isEventInsideTerminal,
} from "./app-shell-utils";
import { updateSnapshot } from "./desktop-app-state";

/** Returns false when the command could not act, so its key event is left alone. */
type CommandHandler = (source: ChordSource) => boolean | void;

interface DesktopCommandsInput {
  readonly api: PiDesktopApi | undefined;
  readonly snapshot: DesktopAppState | null;
  readonly setSnapshot: Dispatch<SetStateAction<DesktopAppState | null>>;
  readonly hasWorkspace: boolean;
  readonly selectedRootWorkspaceId: string | undefined;
  /** The thread open in the main pane. */
  readonly selectedThread:
    | {
        readonly target: WorkspaceSessionTarget;
        readonly pinned: boolean;
        readonly canSwitchModel: boolean;
      }
    | undefined;
  readonly threadSidebarModel: ThreadSidebarModel | undefined;
  readonly threadShortcutOrderRef: RefObject<readonly ThreadListEntry[] | null>;
  readonly threadSearch: {
    readonly isOpen: boolean;
    readonly open: () => void;
    readonly close: () => void;
  };
  readonly workbench: ReturnType<typeof useWorkbench>;
  readonly sidePanelAvailable: boolean;
  readonly sidePanelVisible: boolean;
  readonly selectedToolId: string | null;
  readonly extensionViews: readonly DesktopExtensionViewInfo[];
  readonly openNewThread: (rootWorkspaceId?: string) => void;
  readonly openSettings: (workspaceId?: string, section?: SettingsSection) => void;
  readonly openSkills: (workspaceId?: string) => void;
  readonly openExtensions: (workspaceId?: string) => void;
  readonly setActiveView: (view: AppView) => void;
  readonly setThreadPinned: (target: WorkspaceSessionTarget, pinned: boolean) => void;
  readonly archiveThread: (target: WorkspaceSessionTarget) => void;
}

/**
 * Desktop commands from main-process menus and renderer shortcuts, and the
 * command palette. Every command has one handler; palette entries call the same actions.
 */
export function useDesktopCommands(input: DesktopCommandsInput) {
  const {
    api,
    snapshot,
    setSnapshot,
    selectedRootWorkspaceId,
    selectedThread,
    threadSidebarModel,
    threadShortcutOrderRef,
    threadSearch,
    workbench,
    sidePanelAvailable,
    sidePanelVisible,
    selectedToolId,
  } = input;
  const [paletteMode, setPaletteMode] = useState<PaletteMode | null>(null);
  const sidebarToggleStateRef = useRef({
    api,
    activeView: undefined as AppView | undefined,
    sidebarCollapsed: false,
  });
  sidebarToggleStateRef.current = {
    api,
    activeView: snapshot?.activeView,
    sidebarCollapsed: snapshot?.sidebarCollapsed ?? false,
  };
  const threadSearchGate = useRef(createChordToggleGate());
  const changesToggleGate = useRef(createChordToggleGate(CHANGES_TOGGLE_DEDUPE_MS));
  // IPC and the renderer can both deliver one chord. Collapse only that pair so
  // a quick second press still toggles.
  const paletteGates = useRef({
    commands: createChordPairGate(),
    files: createChordPairGate(),
  });
  const handleCommandRef = useRef<(command: PiDesktopCommand, source?: ChordSource) => boolean>(
    () => false,
  );
  const handleRendererKeyDownRef = useRef<(event: globalThis.KeyboardEvent) => void>(() => {});
  const toggleThreadSearchRef = useRef<() => void>(() => {});

  const openNewThread = () => input.openNewThread(selectedRootWorkspaceId);
  const toggleWorkbenchTool = (kind: BuiltinToolKind) => {
    if (!sidePanelAvailable) return;
    if (sidePanelVisible && selectedToolId === kind) workbench.setVisibility("hidden");
    else workbench.openTool({ kind });
  };
  const toggleSidePanel = () => {
    if (sidePanelAvailable) workbench.toggleVisibility();
  };
  const closeFocusedSurface = () => {
    if (!closableSurfaceFromTarget(document.activeElement)) return;
    if (workbench.view.selection.kind === "tool")
      workbench.closeTool(workbench.view.selection.toolId);
    else workbench.setVisibility("hidden");
    window.requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(
          '#task-workbench [role="tab"][aria-selected="true"], #task-workbench [data-testid="workbench-add-tab"]',
        )
        ?.focus();
    });
  };
  const togglePrimarySidebar = useCallback(() => {
    const sidebarState = sidebarToggleStateRef.current;
    const sidebarApi = sidebarState.api;
    if (!sidebarApi || !canTogglePrimarySidebar(sidebarState.activeView)) {
      return false;
    }
    void updateSnapshot(setSnapshot, () =>
      sidebarApi.setSidebarCollapsed(!sidebarState.sidebarCollapsed),
    ).catch((error: unknown) => {
      console.error("[renderer] updateSnapshot failed", error);
    });
    return true;
  }, []);
  const togglePalette = (mode: "commands" | "files", source: ChordSource) => {
    if (threadSidebarModel && paletteGates.current[mode](source, performance.now())) {
      setPaletteMode((current) => (current === mode ? null : mode));
    }
  };
  const selectRecentThread = (index: number) => {
    const threads =
      threadShortcutOrderRef.current ??
      (threadSidebarModel
        ? visibleThreadShortcutOrder({
            grouping: snapshot?.threadGrouping ?? "time",
            model: threadSidebarModel,
          })
        : []);
    const thread = threads[index];
    if (!thread || !api) return;
    void updateSnapshot(setSnapshot, () =>
      api.selectSession({ workspaceId: thread.workspaceId, sessionId: thread.session.id }),
    ).catch((error: unknown) => {
      console.error("[renderer] selectSession failed", error);
    });
  };

  const handlers: Record<PiDesktopCommand, CommandHandler> = {
    [desktopCommands.openSettings]: () => input.openSettings(selectedRootWorkspaceId),
    [desktopCommands.openNewThread]: openNewThread,
    [desktopCommands.toggleTerminal]: () => toggleWorkbenchTool("terminal"),
    [desktopCommands.toggleSidePanel]: toggleSidePanel,
    [desktopCommands.toggleChanges]: () => {
      // IPC and the renderer can both see one Cmd+D. Collapse that same-tick
      // pair while preserving a deliberate second press.
      if (changesToggleGate.current(performance.now())) toggleWorkbenchTool("changes");
    },
    [desktopCommands.closeFocusedSurface]: closeFocusedSurface,
    [desktopCommands.toggleSidebar]: togglePrimarySidebar,
    [desktopCommands.openCommandPalette]: (source) => togglePalette("commands", source),
    [desktopCommands.openFilePalette]: (source) => togglePalette("files", source),
    [desktopCommands.selectRecentThread1]: () => selectRecentThread(0),
    [desktopCommands.selectRecentThread2]: () => selectRecentThread(1),
    [desktopCommands.selectRecentThread3]: () => selectRecentThread(2),
    [desktopCommands.selectRecentThread4]: () => selectRecentThread(3),
    [desktopCommands.selectRecentThread5]: () => selectRecentThread(4),
    [desktopCommands.selectRecentThread6]: () => selectRecentThread(5),
    [desktopCommands.selectRecentThread7]: () => selectRecentThread(6),
    [desktopCommands.selectRecentThread8]: () => selectRecentThread(7),
    [desktopCommands.selectRecentThread9]: () => selectRecentThread(8),
  };
  handleCommandRef.current = (command, source = "renderer") => {
    // Any other shortcut acts on the app behind the palette, so close it first.
    if (paletteMode && !isPaletteCommand(command)) {
      setPaletteMode(null);
    }
    return handlers[command](source) !== false;
  };
  toggleThreadSearchRef.current = () => {
    if (!threadSearchGate.current(performance.now())) return;
    setPaletteMode(null);
    if (threadSearch.isOpen) threadSearch.close();
    else threadSearch.open();
  };
  handleRendererKeyDownRef.current = (event: globalThis.KeyboardEvent) => {
    const closeSurfaceShortcut = isCloseFocusedSurfaceShortcut({
      meta: event.metaKey,
      control: event.ctrlKey,
      alt: event.altKey,
      shift: event.shiftKey,
      key: event.key,
      code: event.code,
      platform: api?.platform ?? "linux",
    });
    if (closeSurfaceShortcut && closableSurfaceFromTarget(event.target)) {
      event.preventDefault();
      closeFocusedSurface();
      return;
    }
    if (isEventInsideTerminal(event)) {
      const command = getDesktopCommandFromShortcut({
        modifier: event.metaKey || event.ctrlKey,
        alt: event.altKey,
        shift: event.shiftKey,
        key: event.key,
        code: event.code,
      });
      if (
        command === desktopCommands.toggleTerminal ||
        command === desktopCommands.toggleSidePanel
      ) {
        event.preventDefault();
        handleCommandRef.current(command);
      }
      return;
    }
    if (
      (event.metaKey || event.ctrlKey) &&
      !event.shiftKey &&
      !event.repeat &&
      (event.key.toLowerCase() === "f" || event.code === "KeyF")
    ) {
      event.preventDefault();
      toggleThreadSearchRef.current();
      return;
    }
    const command = getDesktopCommandFromShortcut({
      modifier: event.metaKey || event.ctrlKey,
      alt: event.altKey,
      shift: event.shiftKey,
      key: event.key,
      code: event.code,
    });
    if (isPaletteCommand(command)) {
      if (
        !platformShortcutModifier(api?.platform ?? "linux", {
          meta: event.metaKey,
          control: event.ctrlKey,
        })
      ) {
        return;
      }
      if (event.repeat) {
        event.preventDefault();
        return;
      }
    }
    if (command && handleCommandRef.current(command)) {
      event.preventDefault();
    }
  };

  useEffect(() => {
    // Bind once. Re-subscribing when session or search identity changes drops
    // Cmd+D and 1-9 in the gap after a thread switch or relaunch.
    const dispatch = (command: PiDesktopCommand, source: ChordSource) => {
      dismissThreadShortcutHints();
      handleCommandRef.current(command, source);
    };
    const removeCommandListener = window.piApp?.onCommand?.((command) => dispatch(command, "main"));
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      handleRendererKeyDownRef.current(event);
    };
    for (const chord of earlyModifierChords.arm()) {
      const key = chord.key.toLowerCase();
      if (key === "f" || chord.code === "KeyF") {
        toggleThreadSearchRef.current();
        continue;
      }
      const command = getDesktopCommandFromShortcut({
        modifier: true,
        shift: false,
        key: chord.key,
        code: chord.code,
      });
      if (command) dispatch(command, "renderer");
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      removeCommandListener?.();
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  useEffect(() => {
    // Main routes Cmd+W to closeFocusedSurface only while a side panel tool other
    // than the terminal has focus.
    const desktopApi = window.piApp;
    if (!desktopApi) {
      return undefined;
    }
    let armed = false;
    const sync = () => {
      const surface = closableSurfaceFromTarget(document.activeElement);
      const next = surface !== null && surface !== "terminal";
      if (next === armed) {
        return;
      }
      armed = next;
      desktopApi.setSidePanelFocused(next).catch((error: unknown) => {
        console.error("[renderer] setSidePanelFocused failed", error);
      });
    };
    document.addEventListener("focusin", sync);
    sync();
    return () => {
      document.removeEventListener("focusin", sync);
      if (armed) {
        desktopApi.setSidePanelFocused(false).catch((error: unknown) => {
          console.error("[renderer] setSidePanelFocused failed", error);
        });
      }
    };
  }, []);

  const paletteActions: readonly PaletteAction[] =
    paletteMode && threadSidebarModel && api
      ? buildPaletteActions({
          platform: api.platform,
          hasWorkspace: input.hasWorkspace,
          thread: selectedThread,
          canToggleSidebar: canTogglePrimarySidebar(snapshot?.activeView),
          newThread: openNewThread,
          openFolder: () => {
            void updateSnapshot(setSnapshot, () => api.pickWorkspace()).catch((error: unknown) => {
              console.error("[renderer] pickWorkspace failed", error);
            });
          },
          openSettings: (section) => input.openSettings(selectedRootWorkspaceId, section),
          openSkills: () => input.openSkills(selectedRootWorkspaceId),
          openExtensions: () => input.openExtensions(selectedRootWorkspaceId),
          openScheduledTasks: () => input.setActiveView("scheduled"),
          toggleSidebar: togglePrimarySidebar,
          toggleTool: toggleWorkbenchTool,
          toggleSidePanel,
          extensionViews: input.extensionViews
            .filter((view) => view.state === "ready")
            .map((view) => {
              const tool = {
                kind: "extension",
                extensionId: view.extensionId,
                viewId: view.id,
              } as const;
              return {
                id: toolRefId(tool),
                title: view.title,
                open: () => workbench.openTool(tool),
              };
            }),
          findInThread: threadSearch.open,
          setThreadPinned: (pinned) => {
            if (selectedThread) input.setThreadPinned(selectedThread.target, pinned);
          },
          archiveThread: () => {
            if (selectedThread) input.archiveThread(selectedThread.target);
          },
          openPaletteMode: setPaletteMode,
        })
      : [];

  return { paletteMode, setPaletteMode, paletteActions, toggleSidePanel, togglePrimarySidebar };
}
