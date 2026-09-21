import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { WorkspaceRecord, WorktreeRecord } from "../../../contracts/desktop-state";
import type { PiDesktopApi } from "../../../contracts/ipc";
import { FileEditorPane } from "./file-editor-pane";
import { FileExplorer } from "./file-explorer";
import {
  activateFile,
  closeFile,
  openFile,
  pruneFiles,
  type FileWorkbenchTabs,
} from "./file-workbench-state";

interface FileWorkbenchProps {
  readonly api: PiDesktopApi;
  readonly workspace: WorkspaceRecord;
  readonly worktree: WorktreeRecord | undefined;
  readonly sessionStatus: string | undefined;
  readonly tabs: FileWorkbenchTabs;
  readonly onTabsChange: Dispatch<SetStateAction<FileWorkbenchTabs>>;
}

export function FileWorkbench({
  api,
  workspace,
  worktree,
  sessionStatus,
  tabs,
  onTabsChange,
}: FileWorkbenchProps) {
  const [files, setFiles] = useState<readonly string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const onTabsChangeRef = useRef(onTabsChange);
  onTabsChangeRef.current = onTabsChange;
  const requestIdRef = useRef(0);

  const refresh = useCallback(
    (options: { readonly force?: boolean } = {}) => {
      const requestId = ++requestIdRef.current;
      setLoading(true);
      setListError(null);
      void api
        .listWorkspaceFiles(workspace.id, { force: options.force ?? false })
        .then((listed) => {
          if (requestIdRef.current !== requestId) {
            return;
          }
          setFiles(listed);
          onTabsChangeRef.current((current) => pruneFiles(current, listed));
        })
        .catch((error: unknown) => {
          if (requestIdRef.current !== requestId) {
            return;
          }
          console.error("[renderer] listWorkspaceFiles failed", error);
          setListError("Couldn't load files");
        })
        .finally(() => {
          if (requestIdRef.current !== requestId) {
            return;
          }
          setLoading(false);
        });
    },
    [api, workspace.id],
  );

  const prevStatusRef = useRef(sessionStatus);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = sessionStatus;
    if (prev === "running" && sessionStatus !== "running") {
      refresh({ force: true });
    }
  }, [refresh, sessionStatus]);

  useEffect(() => {
    setFiles(null);
    setListError(null);
    refresh();
    return () => {
      requestIdRef.current += 1;
    };
  }, [refresh]);

  return (
    <section
      className="side-panel file-workbench file-workbench--split"
      data-testid="file-workbench"
    >
      <FileEditorPane
        api={api}
        tabs={tabs}
        worktree={worktree}
        workspace={workspace}
        onActivate={(path) => onTabsChange((current) => activateFile(current, path))}
        onClose={(path) => onTabsChange((current) => closeFile(current, path))}
      />
      <FileExplorer
        error={listError}
        files={files}
        loading={loading}
        selectedPath={tabs.active}
        onRefresh={() => refresh({ force: true })}
        onSelect={(path) => onTabsChange((current) => openFile(current, path))}
      />
    </section>
  );
}
