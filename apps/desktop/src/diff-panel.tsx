import { useCallback, useEffect, useState } from "react";
import type { PiDesktopApi } from "./ipc";
import { InlineDiff } from "./diff-inline";
import { RefreshIcon } from "./icons";

interface ChangedFile {
  readonly path: string;
  readonly status: string;
}

interface DiffPanelProps {
  readonly workspaceId: string;
  readonly api: PiDesktopApi;
  readonly sessionStatus: string | undefined;
}

export function DiffPanel({ workspaceId, api, sessionStatus }: DiffPanelProps) {
  const [files, setFiles] = useState<readonly ChangedFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [diffText, setDiffText] = useState("");
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(() => {
    setLoading(true);
    void api.getChangedFiles(workspaceId).then((result) => {
      setFiles(result);
      setLoading(false);
    });
  }, [api, workspaceId]);

  // Auto-refresh when session stops running
  useEffect(() => {
    refresh();
  }, [refresh, sessionStatus]);

  // Fetch diff when file selected
  useEffect(() => {
    if (!selectedFile) {
      setDiffText("");
      return;
    }
    void api.getFileDiff(workspaceId, selectedFile).then(setDiffText);
  }, [api, workspaceId, selectedFile]);

  const handleStage = (filePath: string) => {
    void api.stageFile(workspaceId, filePath).then(refresh);
  };

  return (
    <aside className="diff-panel">
      <div className="diff-panel__header">
        <h2 className="diff-panel__title">Changes</h2>
        <button
          className="icon-button"
          type="button"
          onClick={refresh}
          aria-label="Refresh"
          disabled={loading}
        >
          <RefreshIcon />
        </button>
      </div>

      {files.length === 0 ? (
        <div className="diff-panel__empty">No changes</div>
      ) : (
        <>
          <div className="diff-panel__file-list">
            {files.map((file) => (
              <div
                className={`diff-panel__file ${selectedFile === file.path ? "diff-panel__file--selected" : ""}`}
                key={file.path}
              >
                <button
                  className="diff-panel__file-name"
                  type="button"
                  onClick={() => setSelectedFile(file.path === selectedFile ? null : file.path)}
                >
                  <span className={`diff-panel__status-dot diff-panel__status-dot--${file.status}`} />
                  <span>{file.path}</span>
                </button>
                <button
                  className="diff-panel__stage-btn"
                  type="button"
                  onClick={() => handleStage(file.path)}
                >
                  Stage
                </button>
              </div>
            ))}
          </div>

          {selectedFile && diffText ? (
            <div className="diff-panel__viewer">
              <div className="diff-panel__viewer-header">{selectedFile}</div>
              <InlineDiff diff={diffText} />
            </div>
          ) : null}
        </>
      )}
    </aside>
  );
}
