import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import type { SessionRef } from "@pi-gui/session-driver/types";
import type { PiDesktopApi } from "../../../contracts/ipc";
import type { TaskWorkbenchTemplate, ToolRef } from "../../../contracts/workbench";
import type { FileWorkbenchTabs } from "./file-workbench-state";
import {
  activeWorkbenchTool,
  applyWorkbenchActions,
  initialWorkbenchView,
  restoreWorkbenchView,
  type WorkbenchAction,
  type WorkspaceFileReference,
} from "./workbench-state";

interface WorkbenchEntry {
  view: TaskWorkbenchTemplate;
  readonly initialView: TaskWorkbenchTemplate;
  restore: "loading" | "ready" | "failed";
  pendingActions: WorkbenchAction[];
  latestSave: number;
  error: string;
}

interface UseWorkbenchOptions {
  readonly api: PiDesktopApi | undefined;
  readonly target: SessionRef | null;
  readonly isUnsent?: boolean;
}

let saveSequence = 0;
const SAVE_ERROR = "Couldn't save tool tabs. They are kept in this window.";

function targetKey(target: SessionRef): string {
  return JSON.stringify([target.workspaceId, target.sessionId]);
}

/** Each window owns this map. Host templates are read once, never subscribed to as live state. */
export function useWorkbench({ api, target, isUnsent = false }: UseWorkbenchOptions) {
  const entries = useRef(new Map<string, WorkbenchEntry>());
  const pendingRestores = useRef(new Set<string>());
  const mounted = useRef(true);
  const [, setRevision] = useState(0);
  const current = useRef({ api, target, isUnsent });
  current.current = { api, target, isUnsent };

  const publish = useCallback(() => {
    if (mounted.current) setRevision((revision) => revision + 1);
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const ensureEntry = useCallback((ref: SessionRef, unsent = false): WorkbenchEntry => {
    const key = targetKey(ref);
    const existing = entries.current.get(key);
    if (existing) return existing;
    const initialView = initialWorkbenchView(ref.workspaceId, unsent);
    const entry: WorkbenchEntry = {
      view: initialView,
      initialView,
      restore: "loading",
      pendingActions: [],
      latestSave: 0,
      error: "",
    };
    entries.current.set(key, entry);
    return entry;
  }, []);

  const persist = useCallback(
    (ref: SessionRef, entry: WorkbenchEntry) => {
      const desktopApi = current.current.api;
      if (!desktopApi) return;
      const sequence = ++saveSequence;
      const template = entry.view;
      entry.latestSave = sequence;
      // Capture the target and value now. A task switch cannot redirect a delayed save.
      // Main serializes disk writes. Dispatch immediately so a slow write cannot delay this
      // window's next gesture until after a newer gesture made in another window.
      void desktopApi.saveTaskWorkbenchTemplate({ target: ref, template, sequence }).then(
        () => {
          if (entry.latestSave === sequence && entry.error === SAVE_ERROR) {
            entry.error = "";
            publish();
          }
        },
        () => {
          if (entry.latestSave === sequence) {
            entry.error = SAVE_ERROR;
            publish();
          }
        },
      );
    },
    [publish],
  );

  const restore = useCallback(
    (ref: SessionRef, unsent: boolean) => {
      const desktopApi = current.current.api;
      if (!desktopApi) return;
      const key = targetKey(ref);
      const entry = ensureEntry(ref, unsent);
      if (entry.restore === "ready" || pendingRestores.current.has(key)) return;
      pendingRestores.current.add(key);
      entry.restore = "loading";
      entry.error = "";
      publish();
      void desktopApi.getTaskWorkbenchTemplate(ref).then(
        (saved) => {
          const hasPendingActions = entry.pendingActions.length > 0;
          const restored = restoreWorkbenchView(entry.initialView, saved, entry.pendingActions);
          entry.view = restored.view;
          entry.error = restored.error;
          entry.pendingActions = [];
          entry.restore = "ready";
          pendingRestores.current.delete(key);
          // Restoring alone never writes. Only explicit actions waiting for this read may save.
          if (hasPendingActions) persist(ref, entry);
          publish();
        },
        () => {
          entry.restore = "failed";
          entry.error = "Couldn't restore saved tool tabs. Your current tabs are still available.";
          pendingRestores.current.delete(key);
          publish();
        },
      );
    },
    [ensureEntry, persist, publish],
  );

  const workspaceId = target?.workspaceId;
  const sessionId = target?.sessionId;
  useEffect(() => {
    if (workspaceId && sessionId) restore({ workspaceId, sessionId }, isUnsent);
  }, [api, isUnsent, restore, sessionId, workspaceId]);

  const apply = useCallback(
    (ref: SessionRef, actions: readonly WorkbenchAction[]) => {
      const entry = ensureEntry(ref, current.current.isUnsent);
      const result = applyWorkbenchActions(entry.view, actions);
      const next = result.view;
      if (result.error) {
        entry.error = result.error;
        publish();
      }
      if (next === entry.view && entry.restore === "ready") return;
      entry.view = next;
      if (entry.restore !== "ready") {
        entry.pendingActions.push(...actions);
        publish();
        return;
      }
      entry.error = result.error;
      publish();
      persist(ref, entry);
    },
    [ensureEntry, persist, publish],
  );

  const dispatch = useCallback(
    (action: WorkbenchAction) => {
      const ref = current.current.target;
      if (ref) apply(ref, [action]);
    },
    [apply],
  );
  const openTool = useCallback(
    (tool: ToolRef) => dispatch({ type: "open-tool", tool }),
    [dispatch],
  );
  const activateTool = useCallback(
    (toolId: string) => dispatch({ type: "activate-tool", toolId }),
    [dispatch],
  );
  const closeTool = useCallback(
    (toolId: string) => dispatch({ type: "close-tool", toolId }),
    [dispatch],
  );
  const showChooser = useCallback(() => dispatch({ type: "show-chooser" }), [dispatch]);
  const setVisibility = useCallback(
    (visibility: "visible" | "hidden") => dispatch({ type: "set-visibility", visibility }),
    [dispatch],
  );
  const toggleVisibility = useCallback(() => {
    const ref = current.current.target;
    if (!ref) return;
    const entry = ensureEntry(ref, current.current.isUnsent);
    dispatch({
      type: "set-visibility",
      visibility: entry.view.visibility === "visible" ? "hidden" : "visible",
    });
  }, [dispatch, ensureEntry]);

  const setFiles = useCallback(
    (update: SetStateAction<FileWorkbenchTabs>, checkoutId?: string) => {
      const ref = current.current.target;
      if (!ref) return;
      const entry = ensureEntry(ref, current.current.isUnsent);
      const files = entry.view.files;
      const nextTabs = typeof update === "function" ? update(files.tabs) : update;
      const nextWorkspaceId = checkoutId ?? files.workspaceId;
      if (nextTabs === files.tabs && nextWorkspaceId === files.workspaceId) return;
      apply(ref, [{ type: "set-files", files: { workspaceId: nextWorkspaceId, tabs: nextTabs } }]);
    },
    [apply, ensureEntry],
  );

  const setChanges = useCallback(
    (update: SetStateAction<TaskWorkbenchTemplate["changes"]>) => {
      const ref = current.current.target;
      if (!ref) return;
      const changes = ensureEntry(ref, current.current.isUnsent).view.changes;
      const next = typeof update === "function" ? update(changes) : update;
      if (next.workspaceId === changes.workspaceId && next.selectedPath === changes.selectedPath)
        return;
      apply(ref, [{ type: "set-changes", changes: next }]);
    },
    [apply, ensureEntry],
  );

  const openFile = useCallback(
    async (file: WorkspaceFileReference): Promise<void> => {
      const { target: ref, api: desktopApi } = current.current;
      if (!ref || !desktopApi) return;
      // Host validation must succeed before a transcript link changes any tab state.
      await desktopApi.readWorkspaceFile(file.workspaceId, file.path);
      apply(ref, [{ type: "open-file", file }]);
    },
    [apply],
  );

  const retryRestore = useCallback(() => {
    const { target: ref, isUnsent: unsent } = current.current;
    if (ref) restore(ref, unsent);
  }, [restore]);

  const entry = target ? entries.current.get(targetKey(target)) : undefined;
  const view = entry?.view ?? initialWorkbenchView(target?.workspaceId ?? "", isUnsent || !target);
  return {
    view,
    activeTool: activeWorkbenchTool(view),
    ready: entry?.restore === "ready",
    error: entry?.error ?? "",
    openTool,
    activateTool,
    closeTool,
    showChooser,
    setVisibility,
    toggleVisibility,
    setFiles,
    setChanges,
    openFile,
    retryRestore,
  };
}
