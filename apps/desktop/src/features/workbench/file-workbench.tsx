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
import { useTranslation } from "../../i18n";
import { FileEditorPane } from "./file-editor-pane";
import { FileExplorer } from "./file-explorer";
import { activateFile, closeFile, openFile, type FileWorkbenchTabs } from "./file-workbench-state";

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
  const { t } = useTranslation();
  const [files, setFiles] = useState<readonly string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [listFailed, setListFailed] = useState(false);
  const requestIdRef = useRef(0);

  const refresh = useCallback(
    (options: { readonly force?: boolean } = {}) => {
      const requestId = ++requestIdRef.current;
      setLoading(true);
      setListFailed(false);
      void api
        .listWorkspaceFiles(workspace.id, { force: options.force ?? false })
        .then((listed) => {
          if (requestIdRef.current !== requestId) {
            return;
          }
          setFiles(listed);
        })
        .catch((error: unknown) => {
          if (requestIdRef.current !== requestId) {
            return;
          }
          console.error("[renderer] listWorkspaceFiles failed", error);
          setListFailed(true);
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
    setListFailed(false);
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
        error={listFailed ? t("files.explorer.loadFailed") : null}
        files={files}
        loading={loading}
        selectedPath={tabs.active}
        onRefresh={() => refresh({ force: true })}
        onSelect={(path) => onTabsChange((current) => openFile(current, path))}
      />
    </section>
  );
}
